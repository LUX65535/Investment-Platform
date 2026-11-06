require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { subDays, format } = require('date-fns');
const { MongoClient, ServerApiVersion } = require('mongodb');
const path = require('node:path');
const createPaperRouter = require('./routes/paper-sandbox');
const { createMarketScreener, describeMarketOverview } = require('./lib/market-screener');
const { validateAggregates } = require('./lib/market-aggregates');
const { createInstrumentResolver, instrumentFromReference } = require('./lib/market-instrument');
const { createResearchHistory, availableIntervals, isPlanLimit } = require('./lib/research-history');

const app = express();
const uri = process.env.MONGO_URI;
const configuredDatabaseName = process.env.MONGO_DB_NAME?.trim();
const databaseName = configuredDatabaseName || 'Assignment3';
const maxMarketResponseBytes = 4_000_000;
const maxHourlyRangeMs = 31 * 24 * 60 * 60 * 1000;
const maxMarketRequests = 32;
const maxMarketCacheEntries = 256;
const maxMarketCacheBytes = 8_000_000;
const marketRequests = new Map();
const marketReadCache = new Map();
let marketCacheBytes = 0;
const finnhub = {
  origin: 'https://finnhub.io/api/v1',
  key: process.env.API_KEY,
  keyParameter: 'token',
  retryAt: 0,
};
const polygon = {
  origin: 'https://api.polygon.io/v2',
  key: process.env.API_POLY_KEY,
  keyParameter: 'apiKey',
  retryAt: 0,
};
// Both API versions share the same account quota and cooldown.
const polygonReference = {
  ...polygon, origin: 'https://api.polygon.io/v3',
  get retryAt() { return polygon.retryAt; },
  set retryAt(value) { polygon.retryAt = value; },
};
const browserFiles = path.join(__dirname, 'my-angular-app/dist/my-angular-app/browser');
let databaseClient;
let databaseConnection;

app.set('query parser', 'simple');
app.use(express.json());
app.use(express.static(browserFiles));

function normalizeTicker(value) {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._:/-]{0,31}$/.test(ticker) ? ticker : null;
}

function calendarDateTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && date.toISOString().startsWith(value) ? timestamp : NaN;
}

function marketRequestKey(provider, endpoint, params) {
  return JSON.stringify([provider.origin, endpoint, params]);
}

function providerRetryAt(header) {
  const now = Date.now();
  const value = typeof header === 'string' ? header.trim() : '';
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : /^[A-Za-z]/.test(value) ? (Date.parse(value) - now) / 1000 : NaN;
  const delay = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, 300)) : 60;
  return now + delay * 1000;
}

function marketBusy(retryAt) {
  return Object.assign(new Error('Market data is busy'), { status: 503, retryAt });
}

async function requestMarketData(provider, endpoint, params) {
  if (!provider.key) {
    throw Object.assign(new Error('Market data is unavailable'), { status: 503 });
  }
  const requestKey = marketRequestKey(provider, endpoint, params);
  const pending = marketRequests.get(requestKey);
  if (pending) return pending;
  if (provider.retryAt > Date.now()) throw marketBusy(provider.retryAt);
  if (marketRequests.size >= maxMarketRequests) throw marketBusy(Date.now() + 1000);

  const request = axios.get(provider.origin + endpoint, {
    params: { ...params, [provider.keyParameter]: provider.key },
    timeout: 8000,
    maxContentLength: maxMarketResponseBytes,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
  }).then(({ data }) => {
    if (endpoint.startsWith('/aggs/ticker/') && ['NOT_AUTHORIZED', 'FORBIDDEN'].includes(data?.status)) {
      throw Object.assign(new Error('History is outside the data plan'), { code: 'DATA_PLAN_LIMIT', status: 403 });
    }
    if (data === null || typeof data !== 'object' || Object.hasOwn(data, 'error')
      || (endpoint === '/company-news' && !Array.isArray(data))) {
      throw new Error('Market provider returned an unexpected response');
    }
    if (endpoint.startsWith('/aggs/ticker/')) {
      validateAggregates(data);
    }
    if (endpoint === '/quote' && (!Number.isFinite(data.c) || data.c <= 0
      || !Number.isFinite(data.t) || data.t <= 0)) {
      throw Object.assign(new Error('No valid quote is available'), { status: 503 });
    }
    return data;
  }).catch(error => {
    if (error.response?.status !== 429) throw error;
    const retryAt = providerRetryAt(error.response.headers?.['retry-after']);
    provider.retryAt = Math.max(provider.retryAt, retryAt);
    throw marketBusy(provider.retryAt);
  });

  marketRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    marketRequests.delete(requestKey);
  }
}

function sendMarketError(res, error, key = 'error') {
  const upstreamStatus = error.response?.status;
  let status = 502;
  if (error.status === 503 || upstreamStatus === 429 || upstreamStatus === 503) status = 503;
  else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') status = 504;
  // An upstream 4xx has no terminal paper receipt and must leave the order retryable.
  else if (key === 'error' && (upstreamStatus === 400 || upstreamStatus === 404)) status = upstreamStatus;
  if (error.retryAt) res.set('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))));
  res.status(status).json({ [key]: 'Market data is temporarily unavailable. Please try again.' });
}

function removeMarketRead(key) {
  marketCacheBytes -= marketReadCache.get(key).body.length;
  marketReadCache.delete(key);
}

function getCachedMarketRead(key) {
  const entry = marketReadCache.get(key);
  if (!entry || entry.expiresAt > Date.now()) return entry;
  removeMarketRead(key);
}

async function readMarketData(provider, endpoint, params, ttl = endpoint === '/quote' ? 10_000 : 30_000, cacheScope = '', validate) {
  const key = marketRequestKey(provider, endpoint, params) + cacheScope;
  const cached = getCachedMarketRead(key);
  if (cached) return cached;

  const data = await requestMarketData(provider, endpoint, params);
  if (validate) validate(data);
  // Another public reader of this in-flight request may have already cached it.
  const completed = getCachedMarketRead(key);
  if (completed) return completed;

  const body = Buffer.from(JSON.stringify(data));
  const entry = { body, expiresAt: Date.now() + ttl };
  if (body.length <= maxMarketCacheBytes) {
    while (marketReadCache.size >= maxMarketCacheEntries || marketCacheBytes + body.length > maxMarketCacheBytes) {
      removeMarketRead(marketReadCache.keys().next().value);
    }
    marketReadCache.set(key, entry);
    marketCacheBytes += body.length;
  }
  return entry;
}

async function sendMarketData(res, provider, endpoint, params, ttl) {
  try {
    const { body, expiresAt } = await readMarketData(provider, endpoint, params, ttl);
    const sharedCacheSeconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    res.set('Cache-Control', `public, max-age=0, s-maxage=${sharedCacheSeconds}`);
    res.set('Content-Type', 'application/json; charset=utf-8').send(body);
  } catch (error) {
    res.set('Cache-Control', 'no-store');
    sendMarketError(res, error);
  }
}

const finnhubRoutes = {
  '/company_quote': '/quote',
  '/company_recommendation': '/stock/recommendation',
  '/company_news': '/company-news',
  '/company_sentiment': '/stock/insider-sentiment',
  '/company_peers': '/stock/peers',
  '/company_Earning': '/stock/earnings',
};

async function readInstrumentReference(symbol) {
  const { body } = await readMarketData(polygonReference, `/reference/tickers/${encodeURIComponent(symbol)}`, {}, 300_000,
    'instrument', data => instrumentFromReference(data, symbol));
  return JSON.parse(body);
}

const resolveInstrument = createInstrumentResolver(async symbol => {
  const { body } = await readMarketData(finnhub, '/stock/profile2', { symbol }, 300_000);
  return JSON.parse(body);
}, readInstrumentReference);

app.get('/company_profile', async (req, res) => {
  const symbol = normalizeTicker(req.query.symbol);
  if (!symbol) return res.set('Cache-Control', 'no-store').status(400).json({ error: 'Enter a valid stock symbol.' });
  try {
    const profile = await resolveInstrument(symbol);
    const freshSeconds = profile.instrumentType === 'ETF' ? 3600 : 300;
    return res.set('Cache-Control', `public, max-age=0, s-maxage=${freshSeconds}`).json(profile);
  } catch (error) {
    res.set('Cache-Control', 'no-store');
    if (error.code === 'INSTRUMENT_NOT_FOUND') return res.status(404).json({ error: error.message, code: error.code });
    return sendMarketError(res, error);
  }
});

for (const [route, endpoint] of Object.entries(finnhubRoutes)) {
  app.get(route, (req, res) => {
    const symbol = normalizeTicker(req.query.symbol);
    if (!symbol) return res.status(400).json({ error: 'Enter a valid stock symbol.' });

    const params = { symbol };
    if (endpoint === '/company-news') {
      const today = new Date();
      params.from = format(subDays(today, 7), 'yyyy-MM-dd');
      params.to = format(today, 'yyyy-MM-dd');
    } else if (endpoint === '/stock/insider-sentiment') {
      params.from = '2022-01-01';
    }
    return sendMarketData(res, finnhub, endpoint, params);
  });
}

app.get('/Autocomplete_Search', (req, res) => {
  const term = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
  if (!term || term.length > 80) {
    return res.status(400).json({ error: 'Enter a company name or ticker.' });
  }
  return sendMarketData(res, finnhub, '/search', { q: term });
});

function sendChartData(res, symbol, timespan, from, to) {
  const ticker = encodeURIComponent(symbol);
  const ttl = timespan === 'day' ? 5 * 60_000 : undefined;
  return sendMarketData(res, polygon, `/aggs/ticker/${ticker}/range/1/${timespan}/${from}/${to}`, {
    adjusted: true,
    sort: 'asc',
    // The provider counts base minutes, not resulting hourly candles. Its
    // default 5,000 base bars truncates valid multi-week hourly requests.
    limit: 50_000,
  }, ttl);
}

app.get('/company_data', (req, res) => {
  const symbol = normalizeTicker(req.query.symbol);
  if (!symbol) return res.status(400).json({ error: 'Enter a valid stock symbol.' });

  const today = new Date();
  const from = format(subDays(today, 720), 'yyyy-MM-dd');
  return sendChartData(res, symbol, 'day', from, format(today, 'yyyy-MM-dd'));
});

app.get('/company_OneDay_data', (req, res) => {
  const symbol = normalizeTicker(req.query.symbol);
  const { from, to } = req.query;
  const duration = calendarDateTimestamp(to) - calendarDateTimestamp(from);
  if (!symbol || !Number.isFinite(duration) || duration < 0 || duration > maxHourlyRangeMs) {
    return res.status(400).json({ error: 'Enter a valid stock symbol and a date range of at most 31 days.' });
  }
  return sendChartData(res, symbol, 'hour', from, to);
});

app.get('/market_history', async (req, res) => {
  const symbol = normalizeTicker(req.query.symbol);
  const { range, interval } = req.query;
  res.set('Cache-Control', 'no-store');
  if (!symbol || Object.keys(req.query).some(key => !['symbol', 'range', 'interval'].includes(key))
    || !availableIntervals(range).includes(interval)) {
    return res.status(400).json({ code: 'INVALID_HISTORY_REQUEST', error: 'Choose a valid symbol, range and candle interval.',
      availableIntervals: availableIntervals(range) });
  }
  try {
    let expiresAt = Infinity;
    const readHistory = createResearchHistory(async (endpoint, params, ttl, validate) => {
      const page = await readMarketData(polygon, endpoint, params, ttl, 'research', validate);
      expiresAt = Math.min(expiresAt, page.expiresAt);
      return JSON.parse(page.body);
    });
    const history = await readHistory(symbol, range, interval);
    if (history.results.length) {
      // Other serverless instances may reuse verified public bars. Respect the
      // age of the oldest input page instead of restarting its freshness clock.
      const fresh = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      res.set('Cache-Control', `public, max-age=0, s-maxage=${fresh}, stale-while-revalidate=60`);
    }
    return res.json(history);
  } catch (error) {
    if (isPlanLimit(error)) {
      return res.status(403).json({ code: 'DATA_PLAN_LIMIT',
        error: 'This range or candle interval is not included in the current data plan. Choose a shorter range or another interval.' });
    }
    if (error.code === 'HISTORY_TOO_LARGE') return res.status(400).json({ code: error.code, error: error.message });
    return sendMarketError(res, error);
  }
});

const marketScreener = createMarketScreener(async (date, marketDay) => {
  const { body } = await readMarketData(polygon, `/aggs/grouped/locale/us/market/stocks/${date}`, {
    adjusted: true,
    include_otc: false,
  }, 5 * 60_000, marketDay);
  return JSON.parse(body);
});

app.get(['/api/market-screener', '/api/market-overview'], async (req, res) => {
  const overview = req.path.toLowerCase().startsWith('/api/market-overview');
  if (Object.keys(req.query).length) {
    const name = overview ? 'overview' : 'screener';
    return res.set('Cache-Control', 'no-store').status(400).json({ error: `The market ${name} takes no query parameters.` });
  }
  try {
    const snapshot = await marketScreener.read();
    const body = Buffer.from(JSON.stringify(overview ? describeMarketOverview(snapshot) : snapshot));
    if (body.length > maxMarketResponseBytes) throw new Error('Market snapshot response exceeds the size limit');
    const sharedCacheSeconds = snapshot.stale ? 0 : snapshot.previousUnavailable ? 30 : 300;
    res.set('Cache-Control', `public, max-age=0, s-maxage=${sharedCacheSeconds}`);
    return res.set('Content-Type', 'application/json; charset=utf-8').send(body);
  } catch (error) {
    res.set('Cache-Control', 'no-store');
    return sendMarketError(res, error);
  }
});

app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  const isPreview = process.env.VERCEL_ENV === 'preview';
  const requiresDatabaseName = isPreview || process.env.VERCEL === '1';
  if (!uri || (requiresDatabaseName && !configuredDatabaseName) ||
      (isPreview && databaseName.toLowerCase() === 'assignment3')) {
    return res.status(503).json({ message: 'Database is unavailable' });
  }

  try {
    if (!databaseConnection) {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 8000,
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      });
      databaseClient = client;
      databaseConnection = client.connect().then(() => client.db(databaseName)).catch(error => {
        databaseClient = undefined;
        databaseConnection = undefined;
        throw error;
      });
    }
  } catch (error) {
    console.error('Invalid MongoDB configuration', error.name);
    return res.status(503).json({ message: 'Database is unavailable' });
  }
  try {
    res.locals.db = await databaseConnection;
  } catch (error) {
    return sendDatabaseError(res, error);
  }
  return next();
});

function sendDatabaseError(res, error) {
  console.error('Database request failed', error.name, error.code);
  if (/^Mongo(?:ServerSelection|Network(?:Timeout)?)Error$/.test(error.name)) {
    return res.status(503).json({ message: 'Database is temporarily unavailable. Please try again.' });
  }
  return res.status(500).json({ message: 'Could not complete the request. Please try again.' });
}

async function getTradeMarket(ticker) {
  const params = { symbol: ticker };
  const [quote, profile] = await Promise.all([
    requestMarketData(finnhub, '/quote', params),
    requestMarketData(finnhub, '/stock/profile2', params),
  ]);
  let currency = typeof profile.currency === 'string' ? profile.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    try {
      const reference = instrumentFromReference(await readInstrumentReference(ticker), ticker);
      currency = reference.currency;
    } catch (error) {
      if (error.response?.status !== 404) throw error;
    }
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error('Trading currency is unavailable'), { status: 503 });
  }
  return { quote, currency };
}

async function getHistoricalCloses(symbol, from, to) {
  const ticker = encodeURIComponent(symbol);
  const endpoint = `/aggs/ticker/${ticker}/range/1/day/${from}/${to}`;
  const { body } = await readMarketData(polygon, endpoint, { adjusted: false, sort: 'asc', limit: 50_000 }, 5 * 60_000);
  const data = JSON.parse(body);
  return Array.isArray(data.results) ? data.results : [];
}

app.use('/api', createPaperRouter({
  normalizeTicker, getTradeMarket, getHistoricalCloses, sendMarketError, sendDatabaseError,
}));
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API endpoint not found' });
});

if (process.env.VERCEL !== '1') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(browserFiles, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.status === 400) return res.status(400).json({ message: 'Invalid request body' });
  if (error.status === 413) return res.status(413).json({ message: 'Request body is too large' });
  console.error('Unexpected request error', error.name, error.code);
  return res.status(500).json({ message: 'Internal Server Error' });
});

process.on('SIGINT', async () => {
  await databaseClient?.close();
  process.exit(0);
});

module.exports = app;
