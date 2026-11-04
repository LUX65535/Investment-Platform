# Investment Platform (SPA + API)

A market research and paper trading demo built with Angular, Express, and MongoDB Atlas. The public demo uses synthetic prices, news, and analytics. [Open the live demo](https://investment-platform-rouge-iota.vercel.app/).

* **Front end** — Angular 17 + TypeScript, RxJS, Angular Material, Highcharts  
* **Back end** — Node.js 22 and Express 4, with a built-in sample feed and optional Finnhub and Polygon adapters
* **Data store** — MongoDB Atlas for watchlists, holdings, and simulated cash

---

## Key Features
- Debounced symbol search with quotes, charts, news, and company insights
- SPY benchmark with matched trading dates and price returns rebased to a shared starting point
- Persistent watchlist that stays usable when quotes are unavailable
- Paper portfolio with buying power, cost basis, day change, and unrealized gain or loss
- Browser-scoped paper accounts and server-priced USD orders with persistent receipts
- Responsive research, watchlist, and portfolio views

---

## Quick Start

```bash
# 1 Clone and install
git clone https://github.com/LUX65535/Investment-Platform.git
cd Investment-Platform

# 2 Configure the demo and MongoDB in .env
# MARKET_DATA_MODE=sample
# MONGO_URI= Mongo connection string
# MONGO_DB_NAME= Optional locally (defaults to Assignment3)

# 3 Build and serve the SPA and API locally
npm run build && npm start  # http://localhost:3000 (API & SPA)
```

## Vercel Preview

Use the repository root as the Vercel project root. Select Node.js 22.x in the project settings. The deployment config builds the Angular SPA and routes API requests to Express on the same domain.

In Vercel's Environment Variables settings, add these variables to **Preview** before deploying.

| Variable | Value |
| --- | --- |
| `MONGO_URI` | Atlas driver connection string for a dedicated demo database user |
| `MONGO_DB_NAME` | `Assignment3_demo` |
| `MARKET_DATA_MODE` | `sample` (default on Vercel) |

In Atlas, give the demo database user `readWrite` on `Assignment3_demo` only and configure Network Access for the deployment's outbound traffic. Each browser opens an isolated paper account in `paper_sample_sandboxes` in sample mode. Its private cookie and records expire after 30 days. Initialize the simulated $25,000 wallet from the Portfolio page. Orders and their receipts commit together with cash and positions, and a retry of the same order ID returns its stored outcome.

To use a licensed market feed for private development, set `MARKET_DATA_MODE=live`, `API_KEY`, and `API_POLY_KEY` on the server. Provider data and paper sessions are separate from sample mode.

Run `vercel deploy` from the linked project to create a preview. Check the Portfolio page, a stock search, and a watchlist add and remove. Compare with a fresh private browser session to verify that the simulated data stays isolated.

## Paper account regression tests

Run `node --test tests/paper-sandbox.test.js` for HTTP-level isolation, concurrent orders, receipt replays, expiration, and cost basis. Set `PAPER_TEST_MONGO_PORT` to a standalone local MongoDB port to run the same suite against the real driver. It uses and cleans up a freshly generated `paper_test_*` database on loopback.

## Existing MongoDB Data

The original `watchlist`, `portfolio`, and `wallet` collections remain available for archival access. Private market-feed accounts use `paper_sandboxes`. The public sample workspace uses `paper_sample_sandboxes`. Preview deployments reject the `Assignment3` database name.

If you move to another cluster, back up `Assignment3` with `mongodump` and restore it into the destination with `mongorestore`. Verify the three collections before switching the connection string. See the [Atlas restore instructions](https://www.mongodb.com/docs/atlas/import/mongorestore/).
