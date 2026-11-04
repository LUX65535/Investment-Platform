# Investment Platform (SPA + API)

A market research and paper trading demo built with Angular, Express, and MongoDB Atlas. [Open the live demo](https://investment-platform-rouge-iota.vercel.app/).

* **Front end** — Angular 17 + TypeScript, RxJS, Angular Material, Highcharts  
* **Back end** — Node.js 22 and Express 4, with Finnhub and Polygon market data
* **Data store** — MongoDB Atlas for watchlists, holdings, and simulated cash

---

## Key Features
- Debounced symbol search with quotes, charts, news, and company insights
- Persistent watchlist that stays usable when quotes are unavailable
- Paper portfolio with buying power, cost basis, day change, and unrealized gain or loss
- Server-priced simulated trades with cash and positions updated in one MongoDB transaction
- Responsive research, watchlist, and portfolio views

---

## Quick Start

```bash
# 1 Clone and install
git clone https://github.com/LUX65535/Investment-Platform.git
cd Investment-Platform

# 2 Add secrets to .env
# API_KEY= Finnhub key
# API_POLY_KEY= Polygon key
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
| `API_KEY` | Finnhub API key |
| `API_POLY_KEY` | Polygon API key |

In Atlas, give the demo database user `readWrite` on `Assignment3_demo` only and configure Network Access for the deployment's outbound traffic. Use synthetic data. On a fresh demo database, initialize the wallet from the portfolio page, then use the watchlist and paper trading features to add demo records. The demo shares one wallet and watchlist across visitors, so keep the preview protected.

Run `vercel deploy` from the linked project to create a preview. Open the preview URL and check a direct visit to `/portfolio`, a stock search, and a watchlist add and remove.

## Existing MongoDB Data

If your original Atlas cluster still has `Assignment3` and its `watchlist`, `portfolio`, and `wallet` collections, a hosting move can reuse that cluster directly. A deployment meant to use the original data needs a database user with access to `Assignment3`, its Atlas connection string, and `MONGO_DB_NAME=Assignment3` in the intended environment. Preview deployments reject that database name. Restrict access to the deployment before connecting it to the original data.

If you move to another cluster, back up `Assignment3` with `mongodump` and restore it into the destination with `mongorestore`. Verify the three collections before switching the connection string. See the [Atlas restore instructions](https://www.mongodb.com/docs/atlas/import/mongorestore/).
