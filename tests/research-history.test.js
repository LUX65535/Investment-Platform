const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createResearchHistory, historyRequest, availableIntervals, nextPage, researchBar, marketDayStart, dateInMarket } = require('../lib/research-history');

const DAY = 86_400_000;
const now = Date.parse('2026-11-05T22:00:00Z');
function bar(date, close = 100) {
  return { t: typeof date === 'number' ? date : Date.parse(date), o: close - 1, h: close + 2,
    l: close - 2, c: close, v: 1234.5, vw: close + 3, n: 52 };
}
function page(results, extra = {}) { return { status: 'OK', results, resultsCount: results.length, ...extra }; }

test('range and interval are independent, bounded, and date arithmetic clamps month ends in Eastern time', () => {
  assert.deepEqual(availableIntervals('1D'), ['1m', '5m', '15m', '1h', '1d']);
  assert.deepEqual(availableIntervals('1M'), ['5m', '15m', '1h', '1d', '1wk', '1mo']);
  assert.deepEqual(availableIntervals('3M'), ['1h', '1d', '1wk', '1mo']);
  assert.deepEqual(availableIntervals('5Y'), ['1d', '1wk', '1mo']);
  for (const [range, interval] of [['5Y', '1m'], ['1Y', '1h'], ['All', '1d'], ['1M', 'tick']]) {
    assert.throws(() => historyRequest(range, interval, now), { status: 400 });
  }
  const month = historyRequest('1M', '1d', Date.parse('2024-03-31T19:00:00Z'));
  assert.equal(new Date(month.visibleFrom).toISOString().slice(0, 10), '2024-02-29');
  const midnight = historyRequest('YTD', '1d', Date.parse('2026-01-01T01:00:00Z'));
  assert.equal(new Date(midnight.to).toISOString().slice(0, 10), '2025-12-31');
  assert.equal(new Date(midnight.visibleFrom).toISOString().slice(0, 10), '2025-01-01');
});

test('complete pages retain real fractional volume, optional VWAP and at most 250 indicator warmup bars', async () => {
  const boundary = historyRequest('1M', '1d', now).visibleFrom;
  const rows = Array.from({ length: 350 }, (_, i) => bar(boundary + (i - 310) * DAY));
  delete rows[0].vw;
  const calls = [];
  const history = createResearchHistory(async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (calls.length === 1) return page(rows.slice(0, 200), {
      next_url: 'https://api.massive.com/v2/aggs/ticker/SOXL/range/1/day/1780000000000/2026-11-05?cursor=page-two&apiKey=must-not-propagate',
    });
    return page(rows.slice(199));
  });
  const result = await history('SOXL', '1M', '1d', now);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.apiKey, undefined);
  assert.deepEqual(calls[1].params, { cursor: 'page-two', adjusted: true, sort: 'asc', limit: 50000 });
  assert.equal(result.coverage.warmupBars, 250);
  assert.equal(result.results[0].t, rows[60].t);
  assert.equal(result.results[0].v, 1234.5);
  assert.equal(result.results[0].vw, 103, 'A provider VWAP outside OHLC is legitimate, not a malformed candle.');
  assert.equal(result.coverage.adjustment, 'split');
  assert.equal(result.coverage.complete, true);
  assert.ok(result.results.at(-1).t <= now, 'Future bars are never presented as actual prices.');
  assert.equal(new Set(result.results.map(row => row.t)).size, result.results.length);
});

test('calendar cutoffs use New York midnight rather than including the previous evening session', async () => {
  for (const [date, expected] of [
    ['2026-01-06', '2026-01-06T05:00:00Z'],
    ['2026-07-06', '2026-07-06T04:00:00Z'],
    ['2026-03-08', '2026-03-08T05:00:00Z'],
    ['2026-03-09', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z'],
    ['2026-11-02', '2026-11-02T05:00:00Z'],
  ]) assert.equal(marketDayStart(Date.parse(date)), Date.parse(expected));

  const rows = ['2026-01-06T00:15:00Z', '2026-01-06T09:00:00Z', '2026-02-05T15:00:00Z'].map(date => bar(date));
  const calls = [];
  const history = createResearchHistory(async endpoint => { calls.push(endpoint); return page(rows); });
  const result = await history('SOXL', '1M', '15m', Date.parse('2026-02-06T22:00:00Z'));
  assert.equal(result.visibleFrom, Date.parse('2026-01-06T05:00:00Z'));
  assert.equal(result.coverage.warmupBars, 1, 'The Jan 5 after-hours bar is warmup, not part of the Jan 6 range.');
  assert.equal(dateInMarket(result.results.find(row => row.t >= result.visibleFrom).t), '2026-01-06');
  assert.match(calls[0], /\/2025-12-17\/2026-02-06$/, 'Provider path dates remain inclusive ET calendar dates.');

  const weeklyRows = ['2026-11-01T04:00:00Z', '2026-11-08T05:00:00Z'].map(date => bar(date));
  const weekly = createResearchHistory(async () => page(weeklyRows));
  const week = await weekly('SOXL', '1M', '1wk', Date.parse('2026-12-05T22:00:00Z'));
  assert.equal(week.visibleFrom, Date.parse('2026-11-01T04:00:00Z'), 'Week boundary offset is resolved before the fall DST change.');
  assert.equal(week.coverage.warmupBars, 0);
});

test('1D and 5D show actual Eastern sessions across a weekend and DST without inventing gap bars', async () => {
  const rows = ['2026-10-26T13:30:00Z', '2026-10-27T13:30:00Z', '2026-10-28T13:30:00Z',
    '2026-10-29T13:30:00Z', '2026-10-30T13:30:00Z', '2026-10-30T19:30:00Z'].map(date => bar(date));
  const history = createResearchHistory(async () => page(rows));
  const sunday = Date.parse('2026-11-01T22:00:00Z');
  const one = await history('SOXL', '1D', '1h', sunday);
  assert.equal(one.visibleFrom, Date.parse('2026-10-30T13:30:00Z'));
  assert.equal(one.coverage.warmupBars, 4);
  assert.equal(one.visibleTo, Date.parse('2026-10-30T19:30:00Z'));
  const five = await history('SOXL', '5D', '1h', sunday);
  assert.equal(five.visibleFrom, rows[0].t);
  assert.equal(five.results.length, 6);
});

test('plan-limited warmup retries the requested visible window and declares reduced indicator history', async () => {
  const calls = [];
  const history = createResearchHistory(async endpoint => {
    calls.push(endpoint);
    if (calls.length === 1) throw Object.assign(new Error('Account entitlement'), { response: { status: 403 } });
    return page([bar('2026-10-07T04:00:00Z'), bar('2026-11-04T05:00:00Z')]);
  });
  const result = await history('SOXL', '1M', '1d', now);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/2026-10-05\/2026-11-05$/);
  assert.equal(result.coverage.warmupLimited, true);
  assert.equal(result.coverage.warmupBars, 0);
  assert.match(result.coverage.message, /outside the data plan/);
  assert.equal(result.availability.status, 'available');

  const denied = createResearchHistory(async () => { throw Object.assign(new Error('Denied'), { response: { status: 403 } }); });
  await assert.rejects(denied('SOXL', '5Y', '1d', now), { response: { status: 403 } });
  const empty = createResearchHistory(async () => ({ status: 'OK', resultsCount: 0 }));
  assert.equal((await empty('SOXL', '1M', '1d', now)).availability.status, 'empty');
  const onlyWarmup = createResearchHistory(async () => page([bar('2026-05-01T04:00:00Z')]));
  const stale = await onlyWarmup('SOXL', '1M', '1d', now);
  assert.equal(stale.availability.status, 'empty');
  assert.deepEqual(stale.results, [], 'Older warmup is not substituted for prices missing from the selected range.');
});

test('a shorter permitted warmup preserves earlier weekly bars rather than discarding all study history', async () => {
  const calls = [];
  const history = createResearchHistory(async endpoint => {
    calls.push(endpoint);
    if (calls.length === 1) throw Object.assign(new Error('Account entitlement'), { response: { status: 403 } });
    return page([bar('2025-11-03T05:00:00Z'), bar('2026-10-05T04:00:00Z'), bar('2026-11-02T05:00:00Z')]);
  });
  const result = await history('SOXL', '1M', '1wk', now);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /\/2024-11-07\/2026-11-05$/);
  assert.equal(result.coverage.warmupBars, 1);
  assert.equal(result.coverage.warmupLimited, true);
  assert.equal(result.visibleFrom, Date.parse('2026-10-04T04:00:00Z'));
});

test('successful but truncated history reports actual dates, including for weekly and monthly requests', async () => {
  const weeklyRows = [bar('2024-11-03T04:00:00Z'), bar('2026-11-01T04:00:00Z')];
  const history = createResearchHistory(async () => page(weeklyRows));
  const partial = await history('SOXL', '5Y', '1wk', now);
  assert.equal(partial.availability.status, 'available');
  assert.equal(partial.coverage.complete, false);
  assert.match(partial.coverage.message, /5Y.*2024-11-03 to 2026-11-01/);
  assert.equal(partial.results.length, 2);

  const monthly = createResearchHistory(async () => page([
    bar('2021-11-01T04:00:00Z'), bar('2026-11-01T04:00:00Z'),
  ]));
  const full = await monthly('AAPL', '5Y', '1mo', Date.parse('2026-11-28T22:00:00Z'));
  assert.equal(full.coverage.complete, true, 'Monthly timestamps mark the first day of the candle.');
  assert.equal(full.coverage.warmupLimited, true, 'Limited indicator history is distinct from range truncation.');
});

test('observed coverage separates shortened session counts and stale end dates from normal market closures', async () => {
  const lastTwoSessions = createResearchHistory(async () => page([
    bar('2026-11-03T14:30:00Z'), bar('2026-11-04T14:30:00Z'),
  ]));
  assert.equal((await lastTwoSessions('SOXL', '5D', '1h', now)).coverage.complete, false);
  assert.equal((await lastTwoSessions('SOXL', '1D', '1h', now)).coverage.complete, true);
  const stale = createResearchHistory(async () => page([
    bar('2026-10-05T04:00:00Z'), bar('2026-10-23T04:00:00Z'),
  ]));
  assert.equal((await stale('SOXL', '1M', '1d', now)).coverage.complete, false);
  const closedSession = createResearchHistory(async () => page([
    bar('2026-10-06T04:00:00Z'), bar('2026-11-04T05:00:00Z'),
  ]));
  assert.equal((await closedSession('SOXL', '1M', '1d', now)).coverage.complete, true);
});

test('pagination cannot change host, instrument or interval, repeat pages or silently truncate oversized history', async () => {
  const prefix = '/aggs/ticker/SOXL/range/1/day/';
  for (const url of [
    'https://evil.example/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=x',
    'https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/day/1/2?cursor=x',
    'https://api.polygon.io/v2/aggs/ticker/SOXL/range/1/hour/1/2?cursor=x',
    'https://api.polygon.io/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=x&symbol=AAPL',
    'https://api.polygon.io:8443/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=x',
    'https://secret@api.polygon.io/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=x',
  ]) assert.throws(() => nextPage(url, prefix));
  let calls = 0;
  const repeating = createResearchHistory(async () => {
    calls++;
    return page([], { next_url: 'https://api.polygon.io/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=same' });
  });
  await assert.rejects(repeating('SOXL', '1M', '1d', now), /Repeated aggregate pagination/);
  assert.equal(calls, 2);
  const endless = createResearchHistory(async () => page([], {
    next_url: `https://api.polygon.io/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=${++calls}`,
  }));
  await assert.rejects(endless('SOXL', '1M', '1d', now), { code: 'HISTORY_TOO_LARGE', status: 400 });
  assert.equal(calls, 10);
});

test('missing volume stays missing; corrupt OHLC, volume and conflicting page overlap are rejected', async () => {
  const row = bar('2026-11-04T05:00:00Z');
  const missing = { ...row };
  delete missing.v;
  delete missing.vw;
  assert.equal(Object.hasOwn(researchBar(missing), 'v'), false);
  assert.equal(Object.hasOwn(researchBar(missing), 'vw'), false);
  for (const patch of [{ o: undefined }, { h: 90 }, { l: 101 }, { v: -1 }, { vw: '100' }, { n: 1.5 }, { t: 0.1 }]) {
    assert.throws(() => researchBar({ ...row, ...patch }));
  }
  let calls = 0;
  const conflict = createResearchHistory(async () => ++calls === 1
    ? page([row], { next_url: 'https://api.polygon.io/v2/aggs/ticker/SOXL/range/1/day/1/2?cursor=next' })
    : page([{ ...row, c: 101 }]));
  await assert.rejects(conflict('SOXL', '1M', '1d', now), /Conflicting aggregate pages/);
});
