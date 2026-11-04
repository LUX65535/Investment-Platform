const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const axios = require('axios');
const { MongoClient } = require('mongodb');

test('market reads expire, back off on provider limits, and leave paper orders retryable', async t => {
  Object.assign(process.env, {
    API_KEY: 'test-token', API_POLY_KEY: 'test-chart-token',
    MONGO_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'Assignment3_demo',
  });
  const records = new Map();
  const collection = {
    async createIndex() {},
    async findOne({ _id }) { return structuredClone(records.get(_id)) ?? null; },
    async insertOne(document) { records.set(document._id, structuredClone(document)); },
    async updateOne({ _id, revision }, { $set, $inc }) {
      const record = records.get(_id);
      if (!record || record.revision !== revision) return { matchedCount: 0 };
      Object.assign(record, structuredClone($set));
      record.revision += $inc.revision;
      return { matchedCount: 1 };
    },
  };
  const selectDatabase = t.mock.method(MongoClient.prototype, 'db', () => ({ collection: () => collection }));
  const clock = Date.now;
  const clockStart = clock();
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => clockStart + clockOffset);
  let quoteStatus = 404;
  let quoteCalls = 0;
  let applePrice = 100;
  let upstreamRetryAfter = '5';
  let chartCalls = 0;
  let currency;
  let news = { error: 'Unexpected provider response' };
  t.mock.method(axios, 'get', async (url, { params }) => {
    if (url.endsWith('/company-news')) return { data: news };
    if (url.endsWith('/stock/profile2')) return { data: { currency } };
    if (url.includes('/aggs/ticker/')) {
      chartCalls++;
      return { data: { results: [] } };
    }
    assert.ok(url.endsWith('/quote'));
    quoteCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    if (quoteStatus !== 200) {
      throw Object.assign(new Error('Upstream exception with test-token'), {
        response: { status: quoteStatus, headers: { 'retry-after': upstreamRetryAfter } },
      });
    }
    return { data: { c: params.symbol === 'MSFT' ? 125 : applePrice, t: Math.floor(clock() / 1000) } };
  });
  const server = require('../app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  let cookie;
  async function request(path, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body),
    });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control'),
      retryAfter: response.headers.get('retry-after') };
  }

  const invalidNews = await request('/company_news?symbol=AAPL');
  assert.equal(invalidNews.status, 502);
  assert.equal(invalidNews.cache, 'no-store');
  news = [];
  assert.deepEqual(await request('/company_news?symbol=AAPL'), {
    status: 200, body: [], cache: 'public, max-age=0, s-maxage=30', retryAfter: null,
  });
  assert.equal((await request('/company_quote?symbol=AAPL')).status, 404);
  assert.equal(selectDatabase.mock.callCount(), 0, 'Public market reads do not connect to MongoDB.');
  assert.equal((await request('/api/paper/session')).status, 200);
  assert.equal((await request('/api/initWallet', {})).status, 200);
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 1 };
  const failure = await request('/api/buy', order);
  assert.equal(failure.status, 502);
  assert.equal(failure.cache, 'private, no-store');
  assert.doesNotMatch(JSON.stringify(failure.body), /test-token/);
  assert.deepEqual((await request('/api/orders')).body, []);

  quoteStatus = 200;
  assert.equal((await request('/api/buy', order)).status, 503);
  assert.deepEqual((await request('/api/orders')).body, []);
  currency = ' usd ';
  const beforeReads = quoteCalls;
  const publicReads = await Promise.all(Array.from({ length: 12 }, () => request('/company_quote?symbol=aapl')));
  assert.equal(quoteCalls - beforeReads, 1);
  assert.ok(publicReads.every(read => read.status === 200 && read.body.c === 100
    && read.cache === 'public, max-age=0, s-maxage=10'));
  const repeated = await request('/company_quote?ignored=true&symbol=AAPL');
  assert.equal(repeated.body.c, 100);
  assert.equal(quoteCalls - beforeReads, 1, 'Warm reads reuse the canonical cache entry.');
  const filled = await request('/api/buy', order);
  assert.equal(filled.status, 200);
  assert.equal(quoteCalls - beforeReads, 2, 'Paper fills cannot use a completed read cache entry.');
  assert.equal(filled.body.receipt.orderId, order.orderId);
  assert.equal(filled.body.receipt.balance, 24900);
  assert.equal(filled.body.receipt.quoteKind, 'recent');
  assert.ok(Date.parse(filled.body.receipt.quotedAt));

  const [apple, microsoft] = await Promise.all([
    request('/company_quote?symbol=AAPL'), request('/company_quote?symbol=MSFT'),
  ]);
  assert.deepEqual([apple.body.c, microsoft.body.c], [100, 125]);
  assert.equal(quoteCalls - beforeReads, 3);

  quoteStatus = 429;
  const limited = await request('/company_quote?symbol=NVDA');
  assert.equal(limited.status, 503);
  assert.equal(limited.cache, 'no-store');
  assert.equal(limited.retryAfter, '5');
  assert.doesNotMatch(JSON.stringify(limited.body), /test-token/);
  const blocked = await request('/company_quote?symbol=TSLA');
  assert.equal(blocked.status, 503);
  assert.ok(Number(blocked.retryAfter) > 0);
  assert.equal(quoteCalls - beforeReads, 4, 'Cooldown skips new upstream calls for the same provider.');
  assert.equal((await request('/company_quote?symbol=AAPL')).body.c, 100, 'An unexpired read survives cooldown.');
  assert.equal((await request('/company_data?symbol=AAPL')).status, 200, 'The other provider stays available.');
  assert.equal(chartCalls, 1);

  const secondOrder = { ...order, orderId: randomUUID() };
  const tradeDuringCooldown = await request('/api/buy', secondOrder);
  assert.equal(tradeDuringCooldown.status, 503, 'A fill cannot reuse a completed quote while the provider cools down.');
  assert.equal(tradeDuringCooldown.cache, 'private, no-store');
  assert.ok(Number(tradeDuringCooldown.retryAfter) > 0);
  assert.equal((await request('/api/orders')).body.length, 1);

  quoteStatus = 200;
  clockOffset += 6_000;
  const stillCached = await request('/company_quote?symbol=AAPL');
  assert.equal(stillCached.body.c, 100);
  assert.match(stillCached.cache, /s-maxage=[1-4]$/);
  assert.equal((await request('/company_quote?symbol=TSLA')).status, 200);
  assert.equal(quoteCalls - beforeReads, 5, 'A new provider request resumes after cooldown.');

  clockOffset += 5_000;
  applePrice = 110;
  assert.equal((await request('/company_quote?symbol=AAPL')).body.c, 110);
  assert.equal(quoteCalls - beforeReads, 6, 'Expired quote reads fetch a new response.');
  assert.equal((await request('/api/buy', secondOrder)).body.receipt.price, 110);
  assert.equal(quoteCalls - beforeReads, 7, 'The same retryable order can fill at the newly fetched price.');

  quoteStatus = 429;
  upstreamRetryAfter = new Date(Date.now() + 10_000).toUTCString();
  const timed = await request('/company_quote?symbol=GOOG');
  assert.equal(timed.status, 503);
  assert.ok(Number(timed.retryAfter) >= 8 && Number(timed.retryAfter) <= 10);
});
