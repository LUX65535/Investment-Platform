const assert = require('node:assert/strict');
const { once } = require('node:events');
const { request: httpRequest } = require('node:http');
const { test } = require('node:test');
const axios = require('axios');
const { MongoClient } = require('mongodb');

async function fixture(t, get) {
  Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', API_KEY: 'private-quote-key',
    API_POLY_KEY: 'private-history-key', MONGO_URI: '', MONGO_DB_NAME: '' });
  t.mock.method(axios, 'get', get);
  const database = t.mock.method(MongoClient.prototype, 'connect', () => { throw new Error('Public reads must not connect to MongoDB'); });
  delete require.cache[require.resolve('../app')];
  const server = require('../app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async path => {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path }, resolve);
      request.on('error', reject);
      request.end();
    });
    let body = '';
    for await (const chunk of response) body += chunk;
    assert.doesNotMatch(body, /private-quote-key|private-history-key/);
    assert.equal(database.mock.callCount(), 0);
    return { status: response.statusCode, body: JSON.parse(body), headers: response.headers };
  };
}

const candle = { t: Date.parse('2026-11-04T05:00:00Z'), o: 99, h: 102, l: 98, c: 100, v: 1234.5, vw: 103 };

test('company-only profile absence resolves ETF identity, currency and safe metadata; invalid securities stay distinguishable', async t => {
  const calls = [];
  const request = await fixture(t, async (url, { params }) => {
    calls.push({ url, params });
    if (url.endsWith('/stock/profile2')) {
      if (params.symbol === 'AAPL') return { data: { name: 'Apple Inc', ticker: 'AAPL', currency: 'USD' } };
      if (params.symbol === 'OUTAGE') throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' });
      return { data: {} };
    }
    assert.match(url, /^https:\/\/api\.polygon\.io\/v3\/reference\/tickers\//);
    if (!url.endsWith('/SOXL')) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    return { data: { status: 'OK', results: { ticker: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares',
      currency_name: 'usd', type: 'ETF', primary_exchange: 'ARCX', locale: 'us', active: true,
      branding: { logo_url: 'https://api.polygon.io/logo?apiKey=private-history-key' } } } };
  });
  const etf = await request('/company_profile?symbol=soxl');
  assert.equal(etf.status, 200);
  assert.equal(etf.body.instrumentType, 'ETF');
  assert.equal(etf.body.currency, 'USD');
  assert.equal(etf.body.ticker, 'SOXL');
  assert.equal(etf.body.logo, '');
  assert.equal((await request('/company_profile?symbol=SOXL')).status, 200);
  assert.equal(calls.length, 2, 'Both identity sources are cached after a successful request.');
  const apple = await request('/company_profile?symbol=AAPL');
  assert.equal(apple.body.name, 'Apple Inc');
  assert.equal(calls.length, 3, 'A valid company profile does not spend a reference request.');
  const missing = await request('/company_profile?symbol=NOTFOUND');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'INSTRUMENT_NOT_FOUND');
  assert.equal(missing.headers['cache-control'], 'no-store');
  assert.equal((await request('/company_profile?symbol=OUTAGE')).status, 504, 'A provider timeout is not a nonexistent instrument.');
  const beforeInvalid = calls.length;
  assert.equal((await request('/company_profile?symbol=SOXL&symbol=AAPL')).status, 400);
  assert.equal(calls.length, beforeInvalid);
});

test('research endpoint returns trustworthy OHLCV, validates inputs before requests and never caches corrupt study data', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T22:00:00Z') });
  let calls = 0;
  let invalid = true;
  const request = await fixture(t, async (url, { params }) => {
    calls++;
    assert.match(url, /\/range\/1\/day\//);
    assert.equal(params.limit, 50000);
    assert.equal(params.adjusted, true);
    return { data: { status: 'DELAYED', ticker: 'SOXL', adjusted: true,
      results: [{ ...candle, h: invalid ? 90 : 102 }], resultsCount: 1 } };
  });
  assert.equal((await request('/market_history?symbol=SOXL&range=1M&interval=1d')).status, 502);
  invalid = false;
  const good = await request('/market_history?symbol=SOXL&range=1M&interval=1d');
  assert.equal(good.status, 200);
  assert.equal(good.body.results[0].v, 1234.5);
  assert.equal(good.body.results[0].vw, 103);
  assert.equal(good.body.source.delayed, true);
  assert.equal(good.body.coverage.adjustment, 'split');
  assert.equal(calls, 2, 'A failed candle cannot poison the retry cache.');
  assert.equal((await request('/market_history?symbol=SOXL&range=1M&interval=1d')).status, 200);
  assert.equal(calls, 2);
  for (const path of [
    '/market_history?symbol=SOXL&range=1Y&interval=1m',
    '/market_history?symbol=SOXL&range=1M&interval=1d&from=2020-01-01',
    '/market_history?symbol=SOXL&symbol=AAPL&range=1M&interval=1d',
    '/market_history?symbol=SOXL&range=1M&range=5Y&interval=1d',
    '/market_history?symbol=SOXL&range=1M&interval=1d&interval=1m',
  ]) assert.equal((await request(path)).status, 400);
  assert.equal(calls, 2);
});

test('research plan limits and shared reference/aggregate rate limits remain explicit and retryable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T22:00:00Z') });
  let mode = 'plan';
  let calls = 0;
  const request = await fixture(t, async url => {
    calls++;
    if (url.endsWith('/stock/profile2')) return { data: {} };
    if (mode === 'plan') return { data: { status: 'NOT_AUTHORIZED', error: 'private-history-key entitlement' } };
    if (mode === 'rate') throw Object.assign(new Error('Provider rate'), { response: { status: 429, headers: { 'retry-after': '3' } } });
    return { data: { status: 'OK', results: [candle], resultsCount: 1 } };
  });
  const denied = await request('/market_history?symbol=SOXL&range=5Y&interval=1d');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'DATA_PLAN_LIMIT');
  assert.equal(denied.headers['cache-control'], 'no-store');
  assert.equal(calls, 2, 'One retry excludes optional warmup; a denied visible window is not silently shortened.');
  mode = 'rate';
  const limited = await request('/company_profile?symbol=SOXL');
  assert.equal(limited.status, 503);
  assert.equal(limited.headers['retry-after'], '3');
  const beforeBackoff = calls;
  assert.equal((await request('/market_history?symbol=SOXL&range=1M&interval=1d')).status, 503);
  assert.equal(calls, beforeBackoff, 'Reference and aggregate versions share the same provider quota.');
  t.mock.timers.tick(3000);
  mode = 'ok';
  assert.equal((await request('/market_history?symbol=SOXL&range=1M&interval=1d')).status, 200);
});

test('public charts reuse checked bars across ranges and share only the remaining freshness with the CDN', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T22:00:00Z') });
  let calls = 0;
  const request = await fixture(t, async () => {
    calls++;
    return { data: { status: 'OK', ticker: 'SOXL', adjusted: true, results: [candle], resultsCount: 1 } };
  });
  const query = (range, interval) => request(`/market_history?symbol=SOXL&range=${range}&interval=${interval}`);
  const initial = await query('1M', '1d');
  assert.match(initial.headers['cache-control'], /s-maxage=300, stale-while-revalidate=60/);
  t.mock.timers.tick(90_000);
  const longer = await query('6M', '1d');
  assert.equal(calls, 1);
  assert.equal(longer.body.range, '6M');
  assert.notEqual(initial.body.visibleFrom, longer.body.visibleFrom);
  assert.match(longer.headers['cache-control'], /s-maxage=210, stale-while-revalidate=60/);
  await query('1D', '15m');
  await query('5D', '15m');
  assert.equal(calls, 2, 'One upstream page also serves both short intraday views.');
});

test('research metadata and pagination failures never poison a same-range retry cache', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T22:00:00Z') });
  let calls = 0;
  let metadata;
  const request = await fixture(t, async () => {
    calls++;
    return { data: { status: 'OK', ticker: 'SOXL', adjusted: true,
      results: [candle], resultsCount: 1, ...metadata } };
  });
  const endpoint = '/market_history?symbol=SOXL&range=1M&interval=1d';
  const malformed = [
    { ticker: 'AAPL' },
    { ticker: '' },
    { adjusted: false },
    { adjusted: 'false' },
    { next_url: 'https://evil.example/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=x' },
    { next_url: 'https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1/2?cursor=x' },
    { next_url: 'https://api.massive.com/v2/aggs/ticker/SOXL/range/1/day/1/2' },
  ];
  for (const value of malformed) {
    metadata = value;
    const response = await request(endpoint);
    assert.equal(response.status, 502);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(calls, malformed.length, 'Every rejected page must leave a fresh upstream retry available.');
  metadata = {};
  assert.equal((await request(endpoint)).status, 200);
  assert.equal(calls, malformed.length + 1);
  assert.equal((await request(endpoint)).status, 200);
  assert.equal(calls, malformed.length + 1, 'Only the recovered, validated response is cached.');
});

test('zero and malformed quotes never become successful cache entries or evidence a valid ETF does not exist', async t => {
  let quote = { c: 0, t: 0 };
  let calls = 0;
  const request = await fixture(t, async () => { calls++; return { data: quote }; });
  const empty = await request('/company_quote?symbol=SOXL');
  assert.equal(empty.status, 503);
  assert.equal(empty.headers['cache-control'], 'no-store');
  quote = { c: '12.34', t: 1793919000 };
  assert.equal((await request('/company_quote?symbol=SOXL')).status, 503);
  quote = { c: 12.34, t: 1793919000 };
  assert.equal((await request('/company_quote?symbol=SOXL')).status, 200);
  assert.equal((await request('/company_quote?symbol=SOXL')).status, 200);
  assert.equal(calls, 3);
});

test('deployment routes dispatch the research API before SPA fallback', () => {
  const { routes } = require('../vercel.json');
  const apiRoute = routes.find(route => route.dest === '/api/handler');
  const pattern = new RegExp(apiRoute.src);
  for (const path of ['/market_history', '/market_history/', '/company_profile', '/api/paper/session']) assert.ok(pattern.test(path));
  for (const path of ['/research-embed', '/search-details/SOXL']) assert.equal(pattern.test(path), false);
});
