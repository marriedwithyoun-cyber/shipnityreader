// Reads order data straight out of Shipnity's Apollo GraphQL cache
// (read-only) and pushes a snapshot to the live site's sync endpoint,
// which stores it in Netlify Blobs for netlify/functions/lookup.js to
// serve. No button-clicking/modal-opening per order - confirmed live
// (via window.__APOLLO_CLIENT__.cache.extract() in an authenticated
// browser tab) that phone number, invoice number, and line items are
// all already present in the order-list query's own cached response;
// the "รายการสินค้า" modal just reads from that existing cache instead
// of firing a new request. The payment link is `https://cf.shipnity.com/<slug>`,
// confirmed by comparing an order's `slug` field against its real
// "ชำระเงิน" link.
//
// Runs as a scheduled GitHub Actions job (see
// .github/workflows/sync-shipnity.yml), not on Netlify - Netlify
// Functions can't carry a full Chromium install.
//
// Scope: only orders where `closed === false` (i.e. still open/active)
// are synced. Shipnity holds ~4,246 orders total across its full
// history; a customer realistically only searches for one that hasn't
// finished yet, and re-scraping all 4,246 every cycle isn't practical.
// Revisit this if closed orders ever need to stay searchable.
//
// The pagination flow (typing a page number into the "ไปที่หน้า" input
// and pressing Enter) has been confirmed live to reach and walk pages
// successfully. It was however extremely slow on the first real run
// (see the waitForCacheGrowth comment below for why and the fix).
//
// Required environment variables (set as GitHub Actions secrets):
//   SHIPNITY_USER   - Shipnity login email
//   SHIPNITY_PASS   - Shipnity login password (rotate if it was ever
//                     pasted anywhere in plaintext, e.g. a chat log)
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

const MAX_PAGES = 70; // safety cap; confirmed live at 10 orders/page, ~56 pages for ~558 open orders

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
      // Required on GitHub Actions' Linux runners - Chromium's setuid
      // sandbox needs privileges the runner's container doesn't grant,
      // so without these two flags the browser fails to launch at all
      // (this was almost certainly the exit-code-1 cause).
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

    // Skip images/fonts/media/stylesheets - we only ever read data out
    // of the JS-side Apollo cache, never anything visual.
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
    console.log('[1/4] Loading login page...');
    await page.goto('https://shipnity.com/authen/', { waitUntil: 'networkidle2' });
    await page.type('input[type="text"]', SHIPNITY_USER, { delay: 20 });
    await page.type('input[type="password"]', SHIPNITY_PASS, { delay: 20 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);
    console.log(`[1/4] Login submitted. Current URL: ${page.url()}`);
    if (page.url().includes('/authen')) {
      throw new Error('Still on the login page after submitting - credentials likely rejected.');
    }

    // ---------- Walk the order list, letting Apollo's cache accumulate ----------
    // Deliberately NOT using waitForNetworkIdle here: Shipnity has
    // background analytics traffic (Hotjar etc.) running constantly, so
    // the network never truly goes idle and every page transition was
    // eating its full 15s timeout (~7 minutes just for pagination on a
    // 28-page run). Polling the actual thing we care about - whether
    // Apollo's cache grew - is both correct and much faster in practice.
    async function currentOrderCount() {
      return page.evaluate(() => {
        const cache = window.__APOLLO_CLIENT__.cache.extract();
        return Object.keys(cache).filter((k) => k.startsWith('Order:')).length;
      });
    }
    async function waitForCacheGrowth(beforeCount, { timeout = 8000, pollInterval = 150 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const count = await currentOrderCount();
        if (count > beforeCount) return count;
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      return null; // timed out - caller decides whether that's fatal
    }

    console.log('[2/4] Loading order list...');
    await page.goto('https://www.shipnity.com/order/', { waitUntil: 'domcontentloaded' });
    const firstPageCount = await waitForCacheGrowth(0, { timeout: 30000 });
    if (firstPageCount === null) {
      throw new Error('Order list never populated the Apollo cache within 30s - page structure or auth may have changed.');
    }
    console.log(`[2/4] First page loaded (${firstPageCount} orders in cache so far).`);

    const pagesCount = await page.evaluate(() => {
      const input = document.querySelector('.pagination__page-input input');
      return input ? parseInt(input.getAttribute('max') || '1', 10) : 1;
    });
    const lastPage = Math.min(pagesCount || 1, MAX_PAGES);
    console.log(`[2/4] Found ${pagesCount || 1} page(s) of orders, visiting ${lastPage}.`);

    // Clicking the real "next page" button, rather than typing a page
    // number into the jump-to-page input, because the input-manipulation
    // approach never actually triggered Vuetify's pagination (verified
    // live - the cache-growth check below caught it staying on page 1
    // for the entire run).
    //
    // Shipnity itself is sometimes just slow to respond after a page
    // turn (confirmed by observation, not an artifact of this script) -
    // so each page gets several patient retries (25s wait each, up to 3
    // tries = ~75s worst case) before we give up. Completeness matters
    // more than speed here: no silent partial syncs - if a page truly
    // won't load, the whole run fails loudly instead of quietly missing
    // orders.
    let runningCount = firstPageCount;
    for (let p = 2; p <= lastPage; p++) {
      const nextBtn = await page.$('button[aria-label="หน้าต่อไป"]');
      if (!nextBtn) {
        throw new Error(`"Next page" button not found at page ${p} - Shipnity's page structure may have changed.`);
      }
      const disabled = await page.evaluate((el) => el.disabled || el.classList.contains('v-pagination__navigation--disabled'), nextBtn);
      if (disabled) {
        console.log(`[2/4] "Next page" button disabled at page ${p} - reached the last page.`);
        break;
      }

      let newCount = null;
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts && newCount === null; attempt++) {
        const btn = await page.$('button[aria-label="หน้าต่อไป"]');
        if (btn) await btn.click().catch(() => {});
        newCount = await waitForCacheGrowth(runningCount, { timeout: 25000 });
        if (newCount === null) {
          console.warn(`[2/4] Page ${p}: still hasn't loaded after ${attempt}/${maxAttempts} attempts (Shipnity is responding slowly) - retrying...`);
        }
      }

      if (newCount === null) {
        throw new Error(`Page ${p} never loaded after ${maxAttempts} attempts (~75s) - aborting rather than syncing an incomplete order list.`);
      }
      runningCount = newCount;
      console.log(`[2/4] Visited page ${p}/${lastPage} (${runningCount} orders in cache so far).`);
    }

    // ---------- Pull everything out of the Apollo cache at once ----------
    console.log('[3/4] Extracting Apollo cache...');
    const orders = await page.evaluate(() => {
      const cache = window.__APOLLO_CLIENT__.cache.extract();
      const orderKeys = Object.keys(cache).filter((k) => k.startsWith('Order:'));

      function resolvePurchases(order) {
        const refs = Array.isArray(order.purchases) ? order.purchases : [];
        return refs
          .map((ref) => cache[ref.id])
          .filter(Boolean)
          .map((purchase) => purchase.name)
          .filter(Boolean);
      }

      return orderKeys
        .map((key) => cache[key])
        .filter((o) => o && o.closed === false && o.tel)
        .map((o) => ({
          tel: o.tel,
          invoiceNumber: o.invoiceNumber || '',
          products: resolvePurchases(o),
          link: o.slug ? `https://cf.shipnity.com/${o.slug}` : '',
        }));
    });

    console.log(`[3/4] Extracted ${orders.length} open order(s) from the cache.`);
    if (!orders.length) {
      throw new Error('Extracted 0 orders from the Apollo cache - schema likely changed, aborting sync.');
    }

    // ---------- Push to the live site ----------
    console.log('[4/4] Posting to sync endpoint...');
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
