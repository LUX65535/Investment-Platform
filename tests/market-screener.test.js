const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const axios = require('axios');
const { createMarketScreener } = require('../lib/market-screener');

function summary(date, closes) {
  return {
    status: 'OK', adjusted: true, resultsCount: closes.length,
    results: closes.map(([T, c, v, extra]) => ({ T, c, v, t: Date.parse(date + 'T20:00:00Z'), ...extra })),
  };
}

test('selects actual published ET sessions, skips weekends and a holiday, and preserves missing fields', async () => {
  const requests = [];
  const screener = createMarketScreener(async date => {
    requests.push(date);
    if (date === '2026-07-02') return summary(date, [
      ['AAPL', 110, 40], ['BRK.B', 25.2, 0], ['NEW', 7],
      ['OUTDATED', 12, 8, { t: Date.parse('2026-07-01T20:00Z') }],
      ['TESTOTC', 5, 55, { otc: true }], ['BROKEN', 0, 100],
    ]);
    return summary(date, [['AAPL', 100, 39], ['BRK.B', 28, 28], ['MISSING', 7, 10]]);
  }, () => Date.parse('2026-07-05T20:00:00Z'));

  const [first, concurrent] = await Promise.all([screener.read(), screener.read()]);
  assert.equal(first, concurrent);
  assert.deepEqual(requests, ['2026-07-02', '2026-07-01']);
  assert.equal(first.session, '2026-07-02');
  assert.equal(first.previousSession, '2026-07-01');
  assert.deepEqual(first.coverage, { reported: 6, screened: 3, comparable: 2 });
  assert.equal(first.rows[0].symbol, 'AAPL');
  assert.ok(Math.abs(first.rows[0].change - 10) < .00001);
  assert.equal(first.rows[1].volume, 0);
  assert.ok(Math.abs(first.rows[1].change + 10) < .00001);
  assert.deepEqual(first.rows[2], { symbol: 'NEW', close: 7, volume: null, change: null });
});

test('does not label a price as one-day change when the scheduled previous session has an empty feed', async () => {
  const requests = [];
  const screener = createMarketScreener(async date => {
    requests.push(date);
    if (date === '2026-11-02') return { status: 'OK', resultsCount: 0 };
    return summary(date, [['AAPL', 30, 40]]);
  }, () => Date.parse('2026-11-04T15:00:00Z'));
  const latest = await screener.read();
  assert.equal(latest.previousSession, null);
  assert.equal(latest.rows[0].change, null);
  assert.equal(latest.stale, false);
  assert.deepEqual(requests, ['2026-11-03', '2026-11-02']);
});

test('holds a complete snapshot through the ET day, and reports last good data during a later provider failure', async () => {
  let now = Date.parse('2026-11-04T04:00:00Z'); // Nov 3 at 11 pm EST.
  const requests = [];
  const screener = createMarketScreener(async date => {
    requests.push(date);
    if (date === '2026-11-03') throw Object.assign(new Error('test provider limit'), { status: 503, retryAt: now + 120_000 });
    return summary(date, [['AAPL', 50, 27]]);
  }, () => now);

  const good = await screener.read();
  assert.equal(good.session, '2026-11-02');
  assert.deepEqual(requests, ['2026-11-02', '2026-10-30']);
  now += 45 * 60_000;
  assert.equal(await screener.read(), good);
  now += 30 * 60_000;
  const fallback = await screener.read();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.session, good.session);
  assert.deepEqual(fallback.rows, good.rows);
  now += 90_000;
  assert.equal((await screener.read()).stale, true);
  assert.deepEqual(requests, ['2026-11-02', '2026-10-30', '2026-11-03']);
});

test('retains latest closes during a prior-session outage and recovers comparison without inventing older baselines', async () => {
  let now = Date.parse('2026-11-04T15:00:00Z');
  let available = false;
  const requests = [];
  const screener = createMarketScreener(async date => {
    requests.push(date);
    if (date === '2026-11-02' && !available) throw new Error('test network error');
    return summary(date, [['AAPL', date === '2026-11-03' ? 110 : 100, 30]]);
  }, () => now);
  const partial = await screener.read();
  assert.equal(partial.previousUnavailable, true);
  assert.equal(partial.previousSession, null);
  assert.equal(partial.rows[0].close, 110);
  assert.equal(partial.rows[0].change, null);
  assert.deepEqual(requests, ['2026-11-03', '2026-11-02']);
  available = true;
  now += 61_000;
  const recovered = await screener.read();
  assert.equal(recovered.previousUnavailable, false);
  assert.equal(recovered.previousSession, '2026-11-02');
  assert.ok(Math.abs(recovered.rows[0].change - 10) < .00001);
});

test('bounds date probing and treats empty or malformed feeds as unavailable', async () => {
  let requests = 0;
  const now = () => Date.parse('2026-11-04T15:00:00Z');
  const empty = createMarketScreener(async () => {
    requests++;
    return { status: 'OK', resultsCount: 0, results: [] };
  }, now);
  await assert.rejects(empty.read(), { status: 503 });
  await assert.rejects(empty.read(), { status: 503 });
  assert.equal(requests, 4);

  const malformed = createMarketScreener(async () => ({ status: 'OK', resultsCount: 12, results: [] }), now);
  await assert.rejects(malformed.read(), /Unexpected market summary rows/);
});

test('Express screener route uses grouped data and response caching without connecting to the paper database', async t => {
  Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', API_POLY_KEY: 'test-screener-key', MONGO_URI: '' });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T15:00:00Z') });
  const grouped = t.mock.method(axios, 'get', async (url, { params }) => {
    const endpoint = 'https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/';
    assert.ok(url.startsWith(endpoint));
    assert.deepEqual(params, { adjusted: true, include_otc: false, apiKey: 'test-screener-key' });
    const date = url.slice(endpoint.length);
    const closes = date === '2026-11-03'
      ? [['AAPL', 110, 90], ['SPY', 100, 70], ['QQQ', 99, 200], ['IWM', 108, 40], ['NEW', 10, 13], ['XLK', 105, 12]]
      : [['AAPL', 100, 80], ['SPY', 100, 65], ['QQQ', 100, 190], ['IWM', 105, 40], ['XLK', 100, 12]];
    return { data: summary(date, closes) };
  });
  const server = require('../app').listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = 'http://127.0.0.1:' + server.address().port;
  const [overviewResponse, ...snapshots] = await Promise.all([
    fetch(root + '/api/market-overview'),
    ...Array.from({ length: 6 }, () => fetch(root + '/api/market-screener')),
  ]);
  for (const response of snapshots) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
    assert.equal(response.headers.get('set-cookie'), null);
    const data = await response.text();
    assert.doesNotMatch(data, /test-screener-key/);
    assert.equal(JSON.parse(data).rows[0].close, 110);
  }
  assert.equal(overviewResponse.status, 200);
  assert.equal(overviewResponse.headers.get('set-cookie'), null);
  const overview = await overviewResponse.json();
  assert.equal(overview.session, '2026-11-03');
  assert.deepEqual([overview.up, overview.down, overview.unchanged, overview.comparable, overview.screened], [3, 1, 1, 5, 6]);
  assert.deepEqual(overview.benchmarks.map(row => row.symbol), ['SPY', 'QQQ', 'IWM']);
  assert.equal(overview.sectors.length, 11);
  assert.ok(Math.abs(overview.sectors.find(row => row.symbol === 'XLK').change - 5) < 0.0001);
  assert.equal(overview.sectors.find(row => row.symbol === 'XLY').change, null);
  assert.deepEqual(overview.active.map(row => row.symbol), ['QQQ', 'AAPL', 'SPY', 'IWM']);
  assert.equal(overview.rows, undefined);
  assert.equal(grouped.mock.callCount(), 2);
});
