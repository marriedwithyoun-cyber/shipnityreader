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
// UNVERIFIED: the pagination flow below (typing a page number into the
// "ไปที่หน้า" input and pressing Enter) is based on a static HTML dump,
// not a live test run - it has not been executed end-to-end yet. Run
// this once manually (workflow_dispatch) and check shipnity-error.png
// / the Actions log before trusting the schedule.
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

const MAX_PAGES = 40; // safety cap; ~558 open orders / ~20 per page

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
    await page.goto('https://shipnity.com/authen/', { waitUntil: 'networkidle2' });
    await page.type('input[type="text"]', SHIPNITY_USER, { delay: 20 });
    await page.type('input[type="password"]', SHIPNITY_PASS, { delay: 20 });
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    // ---------- Walk the order list, letting Apollo's cache accumulate ----------
    await page.goto('https://www.shipnity.com/order/', { waitUntil: 'networkidle2' });

    const pagesCount = await page.evaluate(() => {
      const input = document.querySelector('.pagination__page-input input');
      return input ? parseInt(input.getAttribute('max') || '1', 10) : 1;
    });
    const lastPage = Math.min(pagesCount || 1, MAX_PAGES);

    for (let p = 1; p <= lastPage; p++) {
      if (p > 1) {
        await page.evaluate((pageNum) => {
          const input = document.querySelector('.pagination__page-input input');
          if (!input) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, String(pageNum));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, p);
        await page.keyboard.press('Enter');
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
      }
    }

    // ---------- Pull everything out of the Apollo cache at once ----------
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

    if (!orders.length) {
      throw new Error('Extracted 0 orders from the Apollo cache - schema likely changed, aborting sync.');
    }

    // ---------- Push to the live site ----------
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
    try {
      const pages = await browser.pages();
      const page = pages[pages.length - 1];
      if (page) await page.screenshot({ path: 'shipnity-error.png', fullPage: true });
    } catch (screenshotErr) {
      console.error('Failed to capture error screenshot:', screenshotErr);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
