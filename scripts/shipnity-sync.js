// Reads order data straight from Shipnity's own GraphQL API
// (read-only) and pushes a snapshot to the live site's sync endpoint,
// which stores it in Netlify Blobs for netlify/functions/lookup.js to
// serve.
//
// History: earlier versions of this script clicked through the order
// list's pagination in a real browser and read Apollo's client-side
// cache. That worked but was slow and occasionally flaky (Shipnity is
// sometimes slow to respond after a page turn). Captured the actual
// network request Shipnity's own frontend sends when you click "next
// page" (via a fetch() interceptor in an authenticated browser tab)
// and found:
//   - It's a POST to /api/graphql, auth'd by the session cookie plus
//     an `x-csrf-token` header - whose value is just read from the
//     (non-httpOnly) `CSRF-TOKEN` cookie, so it's trivially available
//     to any same-origin fetch() from within the logged-in page.
//   - The query takes `page`/`perPage` variables and the server
//     accepts perPage far larger than the UI's own default of 10 -
//     confirmed perPage: 200 works, turning ~56 page-clicks into 3
//     plain HTTP requests.
//   - orderStatus: "OPEN" server-side filters to exactly the open/
//     unclosed orders (confirmed nodesCount matches the "558" badge
//     shown in the dashboard UI), so no client-side filtering by
//     `closed` is even required, though it's kept as a safety net.
// So: log in with Puppeteer (only way to get a valid session), then
// call the API directly via fetch() from inside the page - no DOM
// interaction, no waiting for renders, no pagination clicking at all.
//
// Runs as a scheduled GitHub Actions job (see .github/workflows/sync.yml),
// not on Netlify - Netlify Functions can't carry a full Chromium install.
//
// Required environment variables (set as GitHub Actions secrets):
//   SHIPNITY_USER   - Shipnity login email
//   SHIPNITY_PASS   - Shipnity login password
//   SYNC_ENDPOINT   - e.g. https://prewithmarry.app/api/sync-orders
//   SYNC_SECRET     - shared secret, must match the Netlify env var of
//                     the same name (see sync-orders.js)

const puppeteer = require('puppeteer');

const {
  SHIPNITY_USER,
  SHIPNITY_PASS,
  SYNC_ENDPOINT,
  SYNC_SECRET,
} = process.env;

const PER_PAGE = 200;
const MAX_PAGES = 20; // safety cap - real total is ~3 pages at perPage 200

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

async function main() {
  requireEnv('SHIPNITY_USER', SHIPNITY_USER);
  requireEnv('SHIPNITY_PASS', SHIPNITY_PASS);
  requireEnv('SYNC_ENDPOINT', SYNC_ENDPOINT);
  requireEnv('SYNC_SECRET', SYNC_SECRET);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-background-networking',
      '--no-first-run',
      '--disable-speech-api',
      '--disable-dev-shm-usage',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ---------- Login ----------
    console.log('[1/3] Loading login page...');
    await page.goto('https://shipnity.com/authen/', { waitUntil: 'networkidle2' });
    await page.type('input[type="text"]', SHIPNITY_USER, { delay: 20 });
    await page.type('input[type="password"]', SHIPNITY_PASS, { delay: 20 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    console.log(`[1/3] Login submitted. Current URL: ${page.url()}`);
    if (page.url().includes('/authen')) {
      throw new Error('Still on the login page after submitting - credentials likely rejected.');
    }

    // Land on the order list once so the CSRF-TOKEN cookie is set for
    // this session (should already be set post-login, but this is the
    // confirmed-working state to fetch from).
    await page.goto('https://www.shipnity.com/order/', { waitUntil: 'networkidle2' });

    // ---------- Fetch every open order directly via the GraphQL API ----------
    console.log('[2/3] Fetching orders via /api/graphql...');
    const { orders: rawOrders, error: fetchError } = await page.evaluate(
      async (perPage, maxPages) => {
        const csrfCookie = document.cookie.split('; ').find((c) => c.startsWith('CSRF-TOKEN='));
        if (!csrfCookie) return { orders: [], error: 'CSRF-TOKEN cookie not found - login may not have completed.' };
        const csrf = decodeURIComponent(csrfCookie.split('=')[1]);

        const query = `query ($perPage: Int, $page: Int, $orderStatus: OrderFilterEnum, $orderFilter: OrderQueryFilterInput, $sort: OrderResolverOrderBy) {
          orderList(perPage: $perPage, page: $page, orderStatus: $orderStatus, orderFilter: $orderFilter, sort: $sort) {
            nodesCount
            pagesCount
            nodes {
              tel
              invoiceNumber
              slug
              closed
              unpaidAmount
              purchases { name }
            }
          }
        }`;

        async function fetchPage(pageNum) {
          const res = await fetch('/api/graphql', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({
              operationName: null,
              variables: { page: pageNum, perPage, sort: 'id_DESC', orderStatus: 'OPEN', orderFilter: { filterType: 'ALL' } },
              query,
            }),
          });
          if (!res.ok) throw new Error(`GraphQL request failed with status ${res.status}`);
          const json = await res.json();
          if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
          return json.data.orderList;
        }

        const first = await fetchPage(1);
        const all = first.nodes.slice();
        const pagesCount = Math.min(first.pagesCount || 1, maxPages);
        for (let p = 2; p <= pagesCount; p++) {
          const next = await fetchPage(p);
          all.push(...next.nodes);
        }
        return { orders: all, error: null };
      },
      PER_PAGE,
      MAX_PAGES
    );

    if (fetchError) throw new Error(fetchError);
    console.log(`[2/3] Fetched ${rawOrders.length} raw order record(s).`);

    const orders = rawOrders
      .filter((o) => o && o.closed === false && o.tel)
      .map((o) => ({
        tel: o.tel,
        invoiceNumber: o.invoiceNumber || '',
        products: (o.purchases || []).map((p) => p.name).filter(Boolean),
        link: o.slug ? `https://cf.shipnity.com/${o.slug}` : '',
        unpaidAmount: typeof o.unpaidAmount === 'number' ? o.unpaidAmount : 0,
      }));

    if (!orders.length) {
      throw new Error('Extracted 0 open orders from the API response - schema likely changed, aborting sync.');
    }

    // ---------- Push to the live site ----------
    console.log('[3/3] Posting to sync endpoint...');
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': SYNC_SECRET,
      },
      body: JSON.stringify({ orders }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Sync endpoint returned ${res.status}: ${text}`);
    }

    console.log(`Synced ${orders.length} orders successfully.`);
  } catch (err) {
    console.error('--- Sync failed ---');
    console.error('Message:', err && err.message);
    console.error('Name:', err && err.name);
    console.error('Stack:', err && err.stack);
    try {
      const pages = await browser.pages();
      const page = pages[pages.length - 1];
      if (page) {
        console.error('Current URL at time of failure:', page.url());
        await page.screenshot({ path: 'shipnity-error.png', fullPage: true });
        console.error('Saved screenshot to shipnity-error.png');
      }
    } catch (screenshotErr) {
      console.error('Failed to capture error screenshot:', screenshotErr);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal error, exiting with code 1:', err);
  process.exit(1);
});
