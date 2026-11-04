require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { subDays, format } = require('date-fns');
const { MongoClient, ServerApiVersion } = require('mongodb');
const path = require('node:path');
const createPaperRouter = require('./routes/paper-sandbox');

const app = express();
const uri = process.env.MONGO_URI;
const configuredDatabaseName = process.env.MONGO_DB_NAME?.trim();
const databaseName = configuredDatabaseName || 'Assignment3';
const maxMarketResponseBytes = 4_000_000;
const maxHourlyRangeMs = 31 * 24 * 60 * 60 * 1000;
const maxMarketRequests = 32;
const marketRequests = new Map();
const finnhub = {
  origin: 'https://finnhub.io/api/v1',
  key: process.env.API_KEY,
  keyParameter: 'token',
};
const polygon = {
  origin: 'https://api.polygon.io/v2',
  key: process.env.API_POLY_KEY,
  keyParameter: 'apiKey',
};
const browserFiles = path.join(__dirname, 'my-angular-app/dist/my-angular-app/browser');
let client;
let database;

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

async function requestMarketData(provider, endpoint, params) {
  if (!provider.key) {
    throw Object.assign(new Error('Market data is unavailable'), { status: 503 });
  }
  const requestKey = JSON.stringify([provider.origin, endpoint, params]);
  const pending = marketRequests.get(requestKey);
  if (pending) return pending;
  if (marketRequests.size >= maxMarketRequests) {
    throw Object.assign(new Error('Market data is busy'), { status: 503 });
  }

  const request = axios.get(provider.origin + endpoint, {
    params: { ...params, [provider.keyParameter]: provider.key },
    timeout: 8000,
    maxContentLength: maxMarketResponseBytes,
    responseType: 'json',
    transitional: { silentJSONParsing: false },
  }).then(({ data }) => {
    if (data === null || typeof data !== 'object' || (endpoint === '/company-news' && !Array.isArray(data))) {
      throw new Error('Market provider returned an unexpected response');
    }
    return data;
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
  if (error.status === 503 || upstreamStatus === 429) status = 503;
  else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') status = 504;
  // An upstream 4xx has no terminal paper receipt and must leave the order retryable.
  else if (key === 'error' && (upstreamStatus === 400 || upstreamStatus === 404)) status = upstreamStatus;
  res.status(status).json({ [key]: 'Market data is temporarily unavailable. Please try again.' });
}

async function sendMarketData(res, provider, endpoint, params) {
  try {
    const data = await requestMarketData(provider, endpoint, params);
    const sharedCacheSeconds = endpoint === '/quote' ? 10 : 30;
    res.set('Cache-Control', `public, max-age=0, s-maxage=${sharedCacheSeconds}`);
    res.json(data);
  } catch (error) {
    res.set('Cache-Control', 'no-store');
    sendMarketError(res, error);
  }
}

const finnhubRoutes = {
  '/company_quote': '/quote',
  '/company_profile': '/stock/profile2',
  '/company_recommendation': '/stock/recommendation',
  '/company_news': '/company-news',
  '/company_sentiment': '/stock/insider-sentiment',
  '/company_peers': '/stock/peers',
  '/company_Earning': '/stock/earnings',
};

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
  return sendMarketData(res, polygon, `/aggs/ticker/${ticker}/range/1/${timespan}/${from}/${to}`, {
    adjusted: true,
    sort: 'asc',
  });
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

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  const isPreview = process.env.VERCEL_ENV === 'preview';
  const requiresDatabaseName = isPreview || process.env.VERCEL === '1';
  if (!uri || (requiresDatabaseName && !configuredDatabaseName) ||
      (isPreview && databaseName.toLowerCase() === 'assignment3')) {
    return res.status(503).json({ message: 'Database is unavailable' });
  }

  try {
    client ??= new MongoClient(uri, {
      serverSelectionTimeoutMS: 8000,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    res.locals.db = database ??= client.db(databaseName);
  } catch (error) {
    console.error('Invalid MongoDB configuration', error.name);
    return res.status(503).json({ message: 'Database is unavailable' });
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
  const currency = typeof profile.currency === 'string' ? profile.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error('Trading currency is unavailable'), { status: 503 });
  }
  return { quote, currency };
}

app.use('/api', createPaperRouter({ normalizeTicker, getTradeMarket, sendMarketError, sendDatabaseError }));
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
  await client?.close();
  process.exit(0);
});

module.exports = app;
