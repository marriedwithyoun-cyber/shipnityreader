# shipnityreader

Scheduled worker that reads order data (read-only) out of Shipnity and
pushes it to `prewithmarry.app` so its order-lookup search stays
up to date without anyone manually copying data over.

See `SUMMARY.md` for current status and the setup steps still needed.

## How it works

`scripts/shipnity-sync.js` logs into Shipnity with Puppeteer, then reads
order data directly out of the page's Apollo GraphQL cache (phone
number, invoice number, line items, and the slug used to build the
payment link) instead of clicking into each order individually. Only
open (unclosed) orders are synced. The result is POSTed to
`prewithmarry.app`'s `sync-orders` endpoint, which stores it in Netlify
Blobs for the site's order-lookup function to read.

`.github/workflows/sync.yml` runs this on a schedule (every 3 hours)
and can also be triggered manually from the Actions tab.

## Required repository secrets

Set these under Settings → Secrets and variables → Actions:

- `SHIPNITY_USER` — Shipnity login email
- `SHIPNITY_PASS` — Shipnity login password
- `SYNC_ENDPOINT` — `https://prewithmarry.app/api/sync-orders`
- `SYNC_SECRET` — shared secret (must match the `SYNC_SECRET` env var
  set on the Netlify site)
