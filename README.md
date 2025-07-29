# Investment Platform (SPA + API)

A full-stack Angular + Express platform that turns real-time market data into actionable investment insight.

* **Front end** — Angular 17 + TypeScript, RxJS, Angular Material, Highcharts  
* **Back end** — Node 18 / Express 4 proxy to Finnhub & Polygon  
* **Data store** — MongoDB Atlas (watch-list & holdings)  
* **Tooling** — ESLint · Nodemon · Concurrently

---

## Key Features
- **Symbol search with autocomplete** (debounced API calls)  
- **Live quote & OHLC chart** (Highstock, custom indicators)  
- **Watch-list** – stored in Mongo, drag-reorder in UI  
- **Paper portfolio** – average cost, P/L, day change  
- **Responsive layout** – Bootstrap 5 grid + Angular Flex Layout  
- *(planned)* WebSocket streaming to replace REST polling

---

## Quick Start

```bash
# 1 Clone and install
git clone https://github.com/LUX65535/Investment-Platform.git
cd investment-platform
npm ci        # installs both root & client deps via workspaces

# 2 Add secrets to .env
# API_KEY= Finnhub key
# API_POLY_KEY= Polygon key
# MONGO_URI= Mongo connection string

# 3 Run everything in dev mode to test (concurrently)
npm run dev      # http://localhost:3000 (API & SPA)
