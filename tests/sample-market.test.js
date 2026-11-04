const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const sampleMarket = require('../lib/sample-market');

function chart(ticker, interval, from, to, now) {
  return sampleMarket(`/aggs/ticker/${ticker}/range/1/${interval}/${from}/${to}`, {}, Date.parse(now)).results;
}

test('sample chart, quote and search have consistent synthetic data', () => {
  const monday = '2026-03-09';
  const friday = '2026-03-06';
  const intraday = '2026-03-09T15:05:28Z';
  const close = '2026-03-09T20:00:00Z';
  const mondayHours = chart('AAPL', 'hour', monday, monday, intraday);
  assert.equal(mondayHours.length, 1, 'Only completed hourly bars are visible.');
  assert.equal(mondayHours[0].t, Date.parse('2026-03-09T13:30:00Z'));
  assert.equal(chart('AAPL', 'hour', friday, friday, intraday)[0].t, Date.parse('2026-03-06T14:30:00Z'));

  const earlierDays = chart('AAPL', 'day', friday, monday, intraday);
  assert.deepEqual(earlierDays.map(bar => bar.t), [Date.parse(friday)], 'Weekends and unfinished sessions are excluded.');
  const quote = sampleMarket('/quote', { symbol: 'AAPL' }, Date.parse(intraday));
  assert.equal(quote.pc, earlierDays[0].c);
  assert.equal(quote.c, mondayHours[0].c);
  assert.equal(quote.t, Date.parse('2026-03-09T15:05:00Z') / 1000);
  assert.deepEqual(sampleMarket('/quote', { symbol: 'AAPL' }, Date.parse(intraday) + 900), quote);

  for (const ticker of ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'SPY']) {
    const bars = chart(ticker, 'hour', monday, monday, close);
    const [daily] = chart(ticker, 'day', monday, monday, close);
    assert.equal(bars.length, 7);
    assert.ok(bars.every(bar => bar.l > 0 && bar.l <= Math.min(bar.o, bar.c)
      && bar.h >= Math.max(bar.o, bar.c) && bar.v > 0));
    assert.equal(daily.o, bars[0].o);
    assert.equal(daily.c, bars.at(-1).c);
    assert.equal(daily.h, Math.max(...bars.map(bar => bar.h)));
    assert.equal(daily.l, Math.min(...bars.map(bar => bar.l)));
    assert.equal(daily.v, bars.reduce((total, bar) => total + bar.v, 0));
    assert.deepEqual(chart(ticker, 'day', monday, monday, '2026-03-14T22:10:00Z'), [daily]);
    const stories = sampleMarket('/company-news', { symbol: ticker }, Date.parse(close));
    assert.ok(stories.length > 1 && stories.every(item => item.sample && !item.url && !item.image));
    assert.equal(new Set(stories.map(item => item.id)).size, stories.length);
  }

  assert.deepEqual(sampleMarket('/search', { q: 'apple inc.' }).result.map(row => row.symbol), ['AAPL']);
  assert.deepEqual(sampleMarket('/search', { q: 'SPY' }).result.map(row => row.type), ['ETF']);
  assert.deepEqual(sampleMarket('/search', { q: 'TSLA' }).result, []);
  assert.deepEqual(sampleMarket('/stock/profile2', { symbol: 'TSLA' }), {});
  assert.equal(sampleMarket('/stock/recommendation', { symbol: 'AAPL' }, Date.parse(close)).length, 6);
  assert.equal(sampleMarket('/stock/earnings', { symbol: 'AAPL' }, Date.parse(close)).length, 4);
  assert.deepEqual(sampleMarket('/stock/insider-sentiment', { symbol: 'SPY' }, Date.parse(close)), { symbol: 'SPY', data: [] });
});

test('Vercel sample mode is provider-free and uses a separate paper workspace', async t => {
  Object.assign(process.env, {
    VERCEL: '1', VERCEL_ENV: 'production', MARKET_DATA_MODE: '', API_KEY: '', API_POLY_KEY: '',
    MONGO_URI: 'mongodb://127.0.0.1:27017', MONGO_DB_NAME: 'Assignment3_demo',
  });
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const upstream = t.mock.method(axios, 'get', () => assert.fail('Sample mode contacted an external provider.'));
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
  const database = t.mock.method(MongoClient.prototype, 'db', () => ({
    collection(name) {
      assert.equal(name, 'paper_sample_sandboxes');
      return collection;
    },
  }));
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
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie'),
      cache: response.headers.get('cache-control') };
  }

  assert.deepEqual(await request('/company_market_mode'), { status: 200, body: { mode: 'sample' }, cookie: null, cache: 'no-store' });
  const { body: quote } = await request('/company_quote?symbol=AAPL');
  assert.ok(quote.c > 0);
  assert.ok((await request('/company_data?symbol=SPY')).body.results.length > 200);
  assert.equal(database.mock.callCount(), 0, 'Public sample data does not depend on MongoDB.');

  cookie = 'investment_paper_v1=' + 'a'.repeat(43);
  assert.equal((await request('/api/balance')).status, 428);
  const session = await request('/api/paper/session');
  assert.match(session.cookie, /^investment_paper_sample_v1=/);
  cookie = session.cookie.split(';')[0];
  assert.equal((await request('/api/initWallet', {})).status, 200);
  const order = { orderId: randomUUID(), ticker: 'AAPL', quantity: 2 };
  const fill = await request('/api/buy', order);
  assert.equal(fill.status, 200);
  assert.equal(fill.body.receipt.price, quote.c);
  assert.equal(fill.body.receipt.quoteKind, 'recent');
  assert.deepEqual((await request('/api/buy', order)).body.receipt, fill.body.receipt);
  assert.equal((await request('/api/orders')).body.length, 1);
  assert.equal(upstream.mock.callCount(), 0);
});
