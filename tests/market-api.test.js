const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { marketDate } = require('../lib/portfolio-equity-history');
const { test } = require('node:test');
const axios = require('axios');
const { MongoClient } = require('mongodb');

test('market reads expire, back off on provider limits, and leave paper orders retryable', async t => {
  Object.assign(process.env, {
    VERCEL: '1', VERCEL_ENV: 'production',
    API_KEY: 'test-token', API_POLY_KEY: 'test-chart-token',
    MONGO_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'Assignment3_demo',
  });
  const records = new Map();
  t.mock.method(MongoClient.prototype, 'connect', async function () { return this; });
  const collection = {
    async createIndex() {},
    async findOne({ _id, expiresAt }) {
      const record = records.get(_id);
      return record && record.expiresAt > expiresAt.$gt ? structuredClone(record) : null;
    },
    async insertOne(document) { records.set(document._id, structuredClone(document)); },
    async updateOne({ _id, revision }, { $set, $inc }) {
      const record = records.get(_id);
      if (!record || record.revision !== revision) return { matchedCount: 0 };
      Object.assign(record, structuredClone($set));
      record.revision += $inc.revision;
      return { matchedCount: 1 };
    },
  };
  const selectDatabase = t.mock.method(MongoClient.prototype, 'db', () => ({
    collection(name) {
      assert.equal(name, 'paper_sandboxes');
      return collection;
    },
  }));
  const clock = Date.now;
  const clockStart = clock();
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => clockStart + clockOffset);
  let quoteStatus = 404;
  let quoteCalls = 0;
  let applePrice = 100;
  let upstreamRetryAfter = '5';
  let chartCalls = 0;
  let historicalCloses = [];
  let currency;
  let news = { error: 'Unexpected provider response' };
  t.mock.method(axios, 'get', async (url, { params }) => {
    assert.match(url, /^https:\/\/(finnhub\.io\/api\/v1|api\.polygon\.io\/v2)\//);
    if (url.endsWith('/company-news')) return { data: news };
    if (url.endsWith('/stock/profile2')) return { data: { currency } };
    if (url.includes('/aggs/ticker/')) {
      chartCalls++;
      return { data: { results: params.adjusted === false ? historicalCloses : [] } };
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

  let cookie = 'investment_paper_sample_v1=' + 'a'.repeat(43);
  async function request(path, body, headers = {}) {
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
  assert.equal((await request('/api/balance')).status, 428, 'The old sample cookie cannot load a real account.');
  assert.equal((await request('/api/paper/session')).status, 200);
  assert.match(cookie, /^investment_paper_v1=/);
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

  const dates = [];
  const marketDay = Date.parse(marketDate(new Date()) + 'T00:00:00Z');
  for (let offset = 1; dates.length < 2; offset++) {
    const date = new Date(marketDay - offset * 86_400_000);
    if (![0, 6].includes(date.getUTCDay())) dates.unshift(date.toISOString().slice(0, 10));
  }
  historicalCloses = dates.map((date, i) => ({ t: Date.parse(date + 'T05:00:00Z'), c: 500 + i * 10 }));
  [...records.values()][0].walletInitializedAt = new Date(dates[0] + 'T14:00:00Z');

  const accountHistory = await request('/api/portfolio/history');
  assert.equal(accountHistory.status, 200);
  assert.equal(accountHistory.cache, 'private, no-store');
  assert.equal(accountHistory.body.status, 'ok');
  assert.deepEqual(accountHistory.body.points, dates.map((date, i) => ({ date, nav: 25000, spyClose: 500 + i * 10 })));
  const historyCalls = chartCalls;
  assert.deepEqual((await request('/api/portfolio/history')).body, accountHistory.body);
  assert.equal(chartCalls, historyCalls, 'Completed bars can be reused without caching private account history.');

  cookie = 'investment_paper_v1=' + 'b'.repeat(43);
  assert.equal((await request('/api/portfolio/history')).status, 428);
  assert.equal(chartCalls, historyCalls, 'Another browser cannot trigger the first account history reads.');
  assert.equal((await request('/api/paper/session')).status, 200);
  assert.equal((await request('/api/initWallet', {})).status, 200);
  [...records.values()][1].walletInitializedAt = new Date(dates[1] + 'T14:00:00Z');
  const newerAccount = await request('/api/portfolio/history');
  assert.equal(newerAccount.cache, 'private, no-store');
  assert.deepEqual(newerAccount.body.points, accountHistory.body.points.slice(1));
  assert.equal(chartCalls, historyCalls, 'The same public bars serve accounts opened on different dates.');

  const crossSite = await request('/api/portfolio/history', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.cache, 'private, no-store');
  [...records.values()][1].expiresAt = new Date(Date.now() - 60_000);
  assert.equal((await request('/api/portfolio/history')).status, 428);
  assert.equal(chartCalls, historyCalls, 'Cross-site and expired sessions cannot reach the market provider.');
});

test('production market endpoints fail closed without provider credentials', async t => {
  Object.assign(process.env, {
    VERCEL: '1', VERCEL_ENV: 'production', API_KEY: '', API_POLY_KEY: '',
    MONGO_URI: '', MONGO_DB_NAME: '',
  });
  const upstream = t.mock.method(axios, 'get', () => assert.fail('Missing credentials must stop the upstream call.'));
  delete require.cache[require.resolve('../app')];
  const server = require('../app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;

  for (const path of ['/company_quote?symbol=AAPL', '/company_data?symbol=AAPL']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Market data is temporarily unavailable. Please try again.' });
  }

  const retiredMode = await fetch(origin + '/company_market_mode');
  assert.equal(retiredMode.status, 404);
  await retiredMode.text();
  assert.equal(upstream.mock.callCount(), 0);
});

test('a failed initial Mongo connection is retried and shared by concurrent requests', async t => {
  Object.assign(process.env, {
    VERCEL: '1', VERCEL_ENV: 'production',
    MONGO_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'Assignment3_demo',
  });
  let attempts = 0;
  t.mock.method(MongoClient.prototype, 'connect', async function () {
    if (++attempts === 1) throw Object.assign(new Error('Connection refused'), { name: 'MongoServerSelectionError' });
    await new Promise(resolve => setTimeout(resolve, 25));
    return this;
  });
  t.mock.method(MongoClient.prototype, 'db', () => ({ collection: () => ({}) }));
  delete require.cache[require.resolve('../app')];
  const server = require('../app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const history = `http://127.0.0.1:${server.address().port}/api/portfolio/history`;

  const first = await fetch(history);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  await first.text();

  const statuses = await Promise.all(Array.from({ length: 6 }, async () => {
    const response = await fetch(history);
    await response.text();
    return response.status;
  }));
  assert.deepEqual(statuses, Array(6).fill(428));
  assert.equal(attempts, 2);
});
