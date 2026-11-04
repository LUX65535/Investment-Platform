const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const axios = require('axios');
const { MongoClient } = require('mongodb');

test('public market reads share requests and provider failures leave paper orders retryable', async t => {
  Object.assign(process.env, {
    API_KEY: 'test-token', MONGO_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'Assignment3_demo',
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
  t.mock.method(MongoClient.prototype, 'db', () => ({ collection: () => collection }));
  let quoteStatus = 404;
  let quoteCalls = 0;
  let currency;
  let news = { error: 'Unexpected provider response' };
  t.mock.method(axios, 'get', async (url, { params }) => {
    if (url.endsWith('/company-news')) return { data: news };
    if (url.endsWith('/stock/profile2')) return { data: { currency } };
    assert.ok(url.endsWith('/quote'));
    quoteCalls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    if (quoteStatus !== 200) {
      throw Object.assign(new Error('Upstream exception with test-token'), { response: { status: quoteStatus } });
    }
    return { data: { c: params.symbol === 'MSFT' ? 125 : 100 } };
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
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }

  const invalidNews = await request('/company_news?symbol=AAPL');
  assert.equal(invalidNews.status, 502);
  assert.equal(invalidNews.cache, 'no-store');
  news = [];
  assert.deepEqual(await request('/company_news?symbol=AAPL'), {
    status: 200, body: [], cache: 'public, max-age=0, s-maxage=30',
  });
  assert.equal((await request('/company_quote?symbol=AAPL')).status, 404);
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
  const filled = await request('/api/buy', order);
  assert.equal(filled.status, 200);
  assert.equal(quoteCalls - beforeReads, 2, 'Paper fills cannot use a completed read cache entry.');
  assert.equal(filled.body.receipt.orderId, order.orderId);
  assert.equal(filled.body.receipt.balance, 24900);

  const [apple, microsoft] = await Promise.all([
    request('/company_quote?symbol=AAPL'), request('/company_quote?symbol=MSFT'),
  ]);
  assert.deepEqual([apple.body.c, microsoft.body.c], [100, 125]);
  assert.equal(quoteCalls - beforeReads, 4);
});
