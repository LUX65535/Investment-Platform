require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { subDays, format } = require('date-fns');
const { MongoClient, ServerApiVersion } = require('mongodb');
const path = require('node:path');

const app = express();
const uri = process.env.MONGO_URI;
const configuredDatabaseName = process.env.MONGO_DB_NAME?.trim();
const databaseName = configuredDatabaseName || 'Assignment3';
const initialDemoBalance = 25000;
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

app.use(express.json());
app.use(express.static(browserFiles));

function normalizeTicker(value) {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._:/-]{0,31}$/.test(ticker) ? ticker : null;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

async function requestMarketData(provider, endpoint, params) {
  if (!provider.key) {
    throw Object.assign(new Error('Market data is unavailable'), { status: 503 });
  }
  const response = await axios.get(provider.origin + endpoint, {
    params: { ...params, [provider.keyParameter]: provider.key },
    timeout: 8000,
  });
  return response.data;
}

function sendMarketError(res, error, key = 'error') {
  const upstreamStatus = error.response?.status;
  let status = 502;
  if (error.status === 503 || upstreamStatus === 429) status = 503;
  else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') status = 504;
  else if (upstreamStatus === 400 || upstreamStatus === 404) status = upstreamStatus;
  res.status(status).json({ [key]: 'Market data is temporarily unavailable. Please try again.' });
}

async function sendMarketData(res, provider, endpoint, params) {
  try {
    res.json(await requestMarketData(provider, endpoint, params));
  } catch (error) {
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
  if (!symbol || !isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return res.status(400).json({ error: 'Enter a valid stock symbol and date range.' });
  }
  return sendChartData(res, symbol, 'hour', from, to);
});

app.use('/api', (req, res, next) => {
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
    res.locals.db = client.db(databaseName);
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

app.post('/api/watchlist', async (req, res) => {
  const ticker = normalizeTicker(req.body?.ticker);
  if (!ticker) return res.status(400).json({ message: 'Enter a valid stock symbol.' });

  try {
    const watchlist = res.locals.db.collection('watchlist');
    // New entries use a stable ID so two requests cannot add the same ticker.
    const result = await watchlist.updateOne({ ticker }, { $setOnInsert: { _id: ticker } }, { upsert: true });
    res.status(200).json({ acknowledged: result.acknowledged, insertedId: result.upsertedId });
  } catch (error) {
    if (error.code === 11000) return res.status(200).json({ acknowledged: true, insertedId: null });
    sendDatabaseError(res, error);
  }
});

app.get('/api/watchlist', async (req, res) => {
  try {
    const entries = await res.locals.db.collection('watchlist').find({}).toArray();
    const seen = new Set();
    res.status(200).json(entries.filter(({ ticker }) => {
      if (seen.has(ticker)) return false;
      seen.add(ticker);
      return true;
    }));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/watchlist/check/:ticker', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ message: 'Enter a valid stock symbol.' });

  try {
    const item = await res.locals.db.collection('watchlist').findOne({ ticker });
    res.status(200).json(Boolean(item));
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.delete('/api/watchlist/:ticker', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ message: 'Enter a valid stock symbol.' });

  try {
    await res.locals.db.collection('watchlist').deleteMany({ ticker });
    res.status(200).json({ message: 'Stock removed from watchlist' });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

function toCents(amount) {
  return Math.round((amount + Math.abs(amount) * Number.EPSILON) * 100);
}

async function buyStock(wallets, portfolio, wallet, ticker, quantity, cost, session) {
  const balance = toCents(wallet.balance) / 100;
  if (balance < cost) {
    return { status: 400, message: 'Insufficient funds' };
  }

  const stock = await portfolio.findOne({ ticker }, { session });
  const nextQuantity = (stock?.quantity ?? 0) + quantity;
  const totalCost = toCents((stock?.totalCost ?? 0) + cost) / 100;
  await wallets.updateOne({ _id: wallet._id }, { $set: { balance: toCents(balance - cost) / 100 } }, { session });
  await portfolio.updateOne(stock ? { _id: stock._id } : { ticker }, {
    $set: { quantity: nextQuantity, totalCost },
  }, { session, upsert: !stock });
  return { status: 200, message: 'Stock purchased successfully' };
}

async function sellStock(wallets, portfolio, wallet, ticker, quantity, proceeds, session) {
  const stock = await portfolio.findOne({ ticker }, { session });
  if (!stock) return { status: 404, message: 'Stock not found in portfolio' };
  if (stock.quantity < quantity) {
    return { status: 400, message: 'Insufficient stock quantity' };
  }

  await wallets.updateOne({ _id: wallet._id }, { $set: { balance: toCents(wallet.balance + proceeds) / 100 } }, { session });
  const remainingQuantity = stock.quantity - quantity;
  if (remainingQuantity === 0) {
    await portfolio.deleteOne({ _id: stock._id }, { session });
  } else {
    // Selling at a different price changes cash, while the retained shares keep their cost basis.
    const remainingCost = toCents(stock.totalCost * remainingQuantity / stock.quantity) / 100;
    await portfolio.updateOne({ _id: stock._id }, {
      $set: { quantity: remainingQuantity, totalCost: remainingCost },
    }, { session });
  }
  return { status: 200, message: 'Stock sold successfully' };
}

for (const [side, execute] of Object.entries({ buy: buyStock, sell: sellStock })) {
  app.post(`/api/${side}`, async (req, res) => {
    const ticker = normalizeTicker(req.body?.ticker);
    const quantity = req.body?.quantity;
    if (!ticker || !Number.isSafeInteger(quantity) || quantity < 1) {
      return res.status(400).json({ message: 'Enter a valid ticker and a positive whole number of shares.' });
    }

    let quote;
    try {
      quote = await requestMarketData(finnhub, '/quote', { symbol: ticker });
    } catch (error) {
      return sendMarketError(res, error, 'message');
    }
    const cents = toCents(quote?.c * quantity);
    if (typeof quote?.c !== 'number' || !Number.isSafeInteger(cents) || cents < 1) {
      return res.status(422).json({ message: 'A valid trading quote is unavailable for this ticker.' });
    }

    try {
      const db = res.locals.db;
      const wallets = db.collection('wallet');
      const portfolio = db.collection('portfolio');
      const outcome = await client.withSession(session => session.withTransaction(async () => {
        const wallet = await wallets.findOne({}, { session });
        if (!wallet) return { status: 409, message: 'Initialize the demo wallet before placing a trade.' };
        return execute(wallets, portfolio, wallet, ticker, quantity, cents / 100, session);
      }));
      res.status(outcome.status).json({ message: outcome.message });
    } catch (error) {
      sendDatabaseError(res, error);
    }
  });
}

app.get('/api/stocks', async (req, res) => {
  try {
    const stocks = await res.locals.db.collection('portfolio').find({}).toArray();
    res.status(200).json(stocks);
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/stocks/:ticker', async (req, res) => {
  const ticker = normalizeTicker(req.params.ticker);
  if (!ticker) return res.status(400).json({ message: 'Enter a valid stock symbol.' });

  try {
    const stock = await res.locals.db.collection('portfolio').findOne({ ticker });
    if (!stock) return res.status(404).json({ message: `Ticker ${ticker} not found in portfolio.` });
    res.status(200).json({ ticker, quantity: stock.quantity, totalCost: stock.totalCost });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const wallet = await res.locals.db.collection('wallet').findOne({});
    res.status(200).json({ balance: wallet?.balance ?? 0 });
  } catch (error) {
    sendDatabaseError(res, error);
  }
});

app.post('/api/initWallet', async (req, res) => {
  try {
    const wallets = res.locals.db.collection('wallet');
    const existingWallet = await wallets.findOne({}, { projection: { _id: 1 } });
    if (existingWallet) return res.status(200).json({ message: 'Demo wallet is already initialized' });

    const result = await wallets.updateOne({ _id: 'demo-wallet' }, {
      $setOnInsert: { balance: initialDemoBalance },
    }, { upsert: true });
    res.status(200).json({
      message: result.upsertedCount ? 'Wallet initialized with $25,000' : 'Demo wallet is already initialized',
    });
  } catch (error) {
    if (error.code === 11000) return res.status(200).json({ message: 'Demo wallet is already initialized' });
    sendDatabaseError(res, error);
  }
});

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
