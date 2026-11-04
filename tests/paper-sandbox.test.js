const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const { MongoClient } = require('mongodb');
const createPaperRouter = require('../routes/paper-sandbox');

// Without a local mongod, exercise the HTTP and optimistic-write races against
// a store that honors the same active-session and revision conditions as MongoDB.
function memoryStore() {
  const records = new Map();
  const indexes = [];
  return {
    async createIndex(key, options) {
      indexes.push({ key, ...options });
      return 'expiresAt_1';
    },
    async indexes() {
      return indexes;
    },
    async findOne(query) {
      await new Promise(resolve => setImmediate(resolve));
      const record = records.get(query._id);
      return record && (!query.expiresAt || record.expiresAt > query.expiresAt.$gt)
        ? structuredClone(record) : null;
    },
    async insertOne(document) {
      assert.ok(!records.has(document._id), 'Sandbox identity must be unique');
      records.set(document._id, structuredClone(document));
    },
    async updateOne(query, update) {
      const record = records.get(query._id);
      if (!record || (query.revision !== undefined && record.revision !== query.revision) ||
          (query.expiresAt && record.expiresAt <= query.expiresAt.$gt)) return { matchedCount: 0 };
      Object.assign(record, structuredClone(update.$set));
      if (update.$inc) record.revision += update.$inc.revision;
      return { matchedCount: 1 };
    },
  };
}

async function fixture(t) {
  const testPort = process.env.PAPER_TEST_MONGO_PORT;
  let collection;
  if (testPort) {
    assert.match(testPort, /^\d{2,5}$/);
    assert.ok(Number(testPort) <= 65535);
    const client = new MongoClient('mongodb://127.0.0.1:' + testPort, {
      serverSelectionTimeoutMS: 3000,
      serverApi: { version: '1', strict: true, deprecationErrors: true },
    });
    const db = client.db('paper_test_' + randomUUID().replaceAll('-', ''));
    collection = db.collection('paper_sandboxes');
    t.after(async () => {
      try {
        await db.dropDatabase();
      } finally {
        await client.close();
      }
    });
  } else {
    collection = memoryStore();
  }

  const market = { price: 100.01, timestamp: Math.floor(Date.now() / 1000), currency: 'USD', offline: false, calls: 0 };
  const app = express();
  app.use(express.json());
  app.use('/api', (_req, res, next) => {
    res.locals.db = { collection(name) {
      assert.equal(name, 'paper_sandboxes');
      return collection;
    } };
    next();
  });
  app.use('/api', createPaperRouter({
    normalizeTicker(value) {
      return /^[A-Z]{1,5}$/.test(value) ? value : null;
    },
    async getTradeMarket() {
      market.calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      if (market.offline) throw new Error('Provider unavailable');
      return { quote: { c: market.price, t: market.timestamp }, currency: market.currency };
    },
    sendMarketError(res) { res.status(503).json({ message: 'Market unavailable' }); },
    sendDatabaseError(_res, error) { throw error; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  function browser() {
    let cookie = '';
    async function request(path, method = 'GET', body, additionalHeaders) {
      const headers = { ...additionalHeaders };
      if (cookie) headers.Cookie = cookie;
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/' + path, {
        method, headers, body: body && JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: response.status, body: await response.json(), setCookie, cache: response.headers.get('cache-control') };
    }
    return {
      request,
      get id() { return createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('hex'); },
      async initialize() {
        assert.equal((await request('paper/session')).status, 200);
        assert.equal((await request('initWallet', 'POST')).status, 200);
      },
    };
  }
  return { browser, collection, market };
}

test('browser sessions isolate the watchlist, cash, holdings and receipts', async t => {
  const { browser, collection } = await fixture(t);
  const first = browser();
  const second = browser();
  assert.equal((await first.request('balance')).status, 428);
  assert.equal((await first.request('paper/session', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await first.request('initWallet', 'POST', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
  const session = await first.request('paper/session');
  assert.match(session.setCookie, /Path=\/api;.*HttpOnly; SameSite=Strict/);
  assert.equal(session.cache, 'private, no-store');
  assert.equal((await first.request('paper/session')).setCookie, null);
  await first.initialize();
  await second.request('paper/session');
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await second.request('balance')).body, { balance: 0, initialized: false });

  await first.request('watchlist', 'POST', { ticker: 'AAPL' });
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 3 };
  assert.equal((await first.request('buy', 'POST', order)).status, 200);
  assert.deepEqual((await first.request('watchlist')).body, [{ ticker: 'AAPL' }]);
  assert.deepEqual((await first.request('stocks')).body, [{ ticker: 'AAPL', quantity: 3, totalCost: 300.03 }]);
  assert.equal((await first.request('balance')).body.balance, 24699.97);
  assert.deepEqual((await second.request('watchlist')).body, []);
  assert.deepEqual((await second.request('stocks')).body, []);
  assert.deepEqual((await second.request('orders')).body, []);
  assert.equal((await second.request('orders/' + order.orderId)).status, 404);
  await second.initialize();
  assert.equal((await second.request('buy', 'POST', { ...order, quantity: 1 })).status, 200);
  assert.deepEqual((await second.request('stocks')).body, [{ ticker: 'AAPL', quantity: 1, totalCost: 100.01 }]);
  assert.equal((await first.request('stocks/AAPL')).body.quantity, 3);

  const indexes = await collection.indexes();
  assert.ok(indexes.some(index => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));
  await collection.updateOne({ _id: first.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await first.request('orders')).status, 428);
  assert.notEqual((await first.request('paper/session')).setCookie, null);
  assert.deepEqual((await first.request('stocks')).body, []);
});

test('concurrent orders settle once and receipt replay bypasses the price provider', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 2 };
  const [first, second] = await Promise.all([
    visitor.request('buy', 'POST', order), visitor.request('buy', 'POST', order),
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(first, second);
  assert.equal((await visitor.request('balance')).body.balance, 24799.98);
  assert.equal((await visitor.request('orders')).body.length, 1);
  assert.deepEqual((await visitor.request('orders/' + order.orderId)).body, first.body.receipt);
  const before = market.calls;
  market.offline = true;
  assert.deepEqual(await visitor.request('buy', 'POST', order), first);
  assert.equal((await visitor.request('sell', 'POST', order)).status, 409);
  assert.equal((await visitor.request('buy', 'POST', { ...order, quantity: 3 })).status, 409);
  assert.equal(market.calls, before);
});

test('different concurrent orders cannot overspend and a rejected receipt stays terminal', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  market.price = 15000;
  const orders = ['AAPL', 'MSFT'].map(ticker => ({ orderId: randomUUID(), ticker, quantity: 1 }));
  const outcomes = await Promise.all(orders.map(order => visitor.request('buy', 'POST', order)));
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200, 400]);
  assert.equal((await visitor.request('balance')).body.balance, 10000);
  const rejected = outcomes.findIndex(outcome => outcome.status === 400);
  const filledOrder = orders[1 - rejected];
  assert.equal((await visitor.request('sell', 'POST', { ...filledOrder, orderId: randomUUID() })).status, 200);
  assert.equal((await visitor.request('balance')).body.balance, 25000);
  assert.deepEqual(await visitor.request('buy', 'POST', orders[rejected]), outcomes[rejected]);
  assert.deepEqual((await visitor.request('stocks')).body, []);
});

test('partial sales keep proportional cents, non-USD is rejected, and provider failures can be retried', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const order = (quantity, ticker = 'AAPL') => ({ orderId: randomUUID(), ticker, quantity });
  market.price = 101.01;
  await visitor.request('buy', 'POST', order(3));
  market.price = 109.02;
  await visitor.request('buy', 'POST', order(2));
  market.price = 125.5;
  const fill = await visitor.request('sell', 'POST', order(2));
  assert.equal(fill.body.receipt.total, 251);
  assert.equal(fill.body.receipt.balance, 24729.93);
  assert.deepEqual((await visitor.request('stocks')).body, [{ ticker: 'AAPL', quantity: 3, totalCost: 312.64 }]);

  market.currency = 'GBP';
  const rejected = order(1, 'VOD');
  const foreign = await visitor.request('buy', 'POST', rejected);
  assert.equal(foreign.status, 422);
  assert.equal(foreign.body.receipt.status, 'rejected');
  market.currency = 'USD';
  assert.deepEqual(await visitor.request('buy', 'POST', rejected), foreign);

  const retry = order(1);
  market.offline = true;
  assert.equal((await visitor.request('buy', 'POST', retry)).status, 503);
  assert.equal((await visitor.request('orders/' + retry.orderId)).status, 404);
  market.offline = false;
  assert.equal((await visitor.request('buy', 'POST', retry)).status, 200);
});

test('fractional-cent quotes round the order total once and preserve the quoted unit price', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  market.price = 0.015;
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 1000 };
  const fill = await visitor.request('buy', 'POST', order);
  assert.equal(fill.status, 200);
  assert.equal(fill.body.receipt.price, 0.015);
  assert.equal(fill.body.receipt.total, 15);
  assert.equal(fill.body.receipt.balance, 24985);

  market.price = 0.004;
  const sell = await visitor.request('sell', 'POST', { ...order, orderId: randomUUID(), quantity: 250 });
  assert.equal(sell.status, 200);
  assert.equal(sell.body.receipt.total, 1);
  assert.deepEqual((await visitor.request('stocks')).body, [{ ticker: 'AAPL', quantity: 750, totalCost: 11.25 }]);
  assert.deepEqual(await visitor.request('buy', 'POST', order), fill);
});

test('a stale quote requires exact explicit confirmation and fills only once', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 2 };
  market.timestamp -= 3 * 24 * 60 * 60;

  const offer = await visitor.request('buy', 'POST', order);
  assert.equal(offer.status, 409);
  assert.equal(offer.body.code, 'PAPER_REFERENCE_QUOTE_REQUIRED');
  assert.equal(offer.body.quoteKind, 'reference');
  assert.deepEqual(offer.body.referenceQuote, {
    price: 100.01, quotedAt: new Date(market.timestamp * 1000).toISOString(),
  });
  assert.equal((await visitor.request('orders/' + order.orderId)).status, 404);
  assert.equal((await visitor.request('balance')).body.balance, 25000);

  market.price = 101.11;
  const changed = await visitor.request('buy', 'POST', { ...order, referenceQuote: offer.body.referenceQuote });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'PAPER_REFERENCE_QUOTE_REQUIRED');
  assert.equal(changed.body.quoteKind, 'reference');
  assert.equal(changed.body.referenceQuote.price, 101.11);
  assert.deepEqual((await visitor.request('stocks')).body, []);

  const confirmation = { ...order, referenceQuote: changed.body.referenceQuote };
  const [filled, repeated] = await Promise.all([
    visitor.request('buy', 'POST', confirmation), visitor.request('buy', 'POST', confirmation),
  ]);
  assert.equal(filled.status, 200);
  assert.deepEqual(repeated, filled);
  assert.equal(filled.body.receipt.quoteKind, 'reference');
  assert.equal(filled.body.receipt.quotedAt, changed.body.referenceQuote.quotedAt);
  assert.equal(filled.body.receipt.price, changed.body.referenceQuote.price);
  assert.equal((await visitor.request('balance')).body.balance, 24797.78);
  assert.equal((await visitor.request('orders')).body.length, 1);

  const calls = market.calls;
  market.offline = true;
  assert.deepEqual(await visitor.request('buy', 'POST', order), filled);
  assert.equal(market.calls, calls);
});

test('a fresh quote cannot replace the reference price a user confirmed', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 1 };
  const recentTimestamp = market.timestamp;
  market.timestamp -= 3600;
  const offer = await visitor.request('buy', 'POST', order);

  market.timestamp = recentTimestamp;
  const changed = await visitor.request('buy', 'POST', { ...order, referenceQuote: offer.body.referenceQuote });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'PAPER_REFERENCE_QUOTE_REQUIRED');
  assert.equal(changed.body.quoteKind, 'recent');
  assert.deepEqual(changed.body.referenceQuote, {
    price: market.price, quotedAt: new Date(recentTimestamp * 1000).toISOString(),
  });
  assert.deepEqual((await visitor.request('orders')).body, []);
  assert.equal((await visitor.request('balance')).body.balance, 25000);

  const filled = await visitor.request('buy', 'POST', { ...order, referenceQuote: changed.body.referenceQuote });
  assert.equal(filled.status, 200);
  assert.equal(filled.body.receipt.quoteKind, 'recent');
  assert.equal(filled.body.receipt.quotedAt, new Date(recentTimestamp * 1000).toISOString());
});

test('missing, future and expired quotes cannot fill paper orders', async t => {
  const { browser, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const recentTimestamp = market.timestamp;
  for (const timestamp of [undefined, recentTimestamp + 120, recentTimestamp - 8 * 24 * 60 * 60]) {
    market.timestamp = timestamp;
    const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 1 };
    const rejection = await visitor.request('buy', 'POST', order);
    assert.equal(rejection.status, 422);
    assert.equal(rejection.body.receipt.status, 'rejected');
    assert.equal(rejection.body.receipt.quoteKind, null);
    assert.equal(rejection.body.receipt.quotedAt, null);
    assert.deepEqual(await visitor.request('orders/' + order.orderId), { ...rejection, status: 200, body: rejection.body.receipt });
  }
  assert.equal((await visitor.request('balance')).body.balance, 25000);
  assert.deepEqual((await visitor.request('stocks')).body, []);
});

test('a full order log keeps earlier receipt IDs replayable', async t => {
  const { browser, collection, market } = await fixture(t);
  const visitor = browser();
  await visitor.initialize();
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 1 };
  const fill = await visitor.request('buy', 'POST', order);
  const stored = await collection.findOne({ _id: visitor.id });
  const { unitPrice, quotedAt, quoteKind, ...receipt } = stored.receipts[0];
  const previous = { ...receipt, priceCents: Math.round(unitPrice * 100) };
  const placeholders = Array.from({ length: 499 }, () => ({ ...previous, orderId: randomUUID() }));
  await collection.updateOne({ _id: visitor.id }, { $set: { receipts: [previous, ...placeholders] } });
  assert.equal((await visitor.request('buy', 'POST', { ...order, orderId: randomUUID() })).status, 409);
  assert.deepEqual(await visitor.request('buy', 'POST', order), {
    ...fill,
    body: { ...fill.body, receipt: { ...fill.body.receipt, quotedAt: null, quoteKind: null } },
  });
  assert.equal((await visitor.request('orders')).body.length, 500);
  assert.equal(market.calls, 1);
});
