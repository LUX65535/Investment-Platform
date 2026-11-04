const assert = require('node:assert/strict');
const { test } = require('node:test');
const { equityHistoryRequirements, marketDate, reconstructEquityHistory } = require('../lib/portfolio-equity-history');

const startingCashCents = 2_500_000;
const asOf = new Date('2026-11-04T22:00:00Z');
const bar = (sessionStart, c) => ({ t: Date.parse(sessionStart), c });
const fill = (side, ticker, quantity, totalCents, submittedAt) => ({
  status: 'filled', side, ticker, quantity, totalCents, submittedAt,
});

function history(overrides) {
  return reconstructEquityHistory({
    receipts: [], startingCashCents, benchmarkBars: [], barsByTicker: new Map(), asOf, ...overrides,
  });
}

test('known wallet initialization anchors cash-only history to completed Eastern sessions', () => {
  const walletInitializedAt = new Date('2026-10-30T15:00:00Z');
  const benchmarkBars = [
    bar('2026-11-05T05:00:00Z', 574),
    bar('2026-11-04T05:00:00Z', 571),
    bar('2026-10-31T04:00:00Z', 562),
    bar('2026-11-03T05:00:00Z', 568),
    bar('2026-11-02T05:00:00Z', 564),
    bar('2026-11-02T05:00:00Z', 565),
    bar('2026-10-30T04:00:00Z', 560),
    bar('2026-10-29T04:00:00Z', 556),
  ];
  const result = history({ walletInitializedAt, benchmarkBars, expectedAccount: { cashCents: startingCashCents, positions: [] } });
  assert.deepEqual(result.points, [
    { date: '2026-10-30', nav: 25000, spyClose: 560 },
    { date: '2026-11-02', nav: 25000, spyClose: null },
    { date: '2026-11-03', nav: 25000, spyClose: 568 },
  ]);
  assert.equal(result.missingBenchmarkSessions, 1, 'A conflicting SPY close still proves the session exists.');
  assert.deepEqual(history({ benchmarkBars }).points, [], 'Undated legacy cash is not backfilled.');
  assert.equal(marketDate(new Date('2026-11-04T04:59:59Z')), '2026-11-03');
  assert.equal(marketDate(Date.parse('2026-11-04T05:00:00Z')), '2026-11-04');
});

test('cash and shares replay in order using actual receipt totals and historical closes', () => {
  const legacyBuy = {
    ...fill('buy', 'AAPL', 10, 100_000, '2026-10-30T19:30:00Z'),
    priceCents: 10_000,
  };
  const receipts = [
    fill('sell', 'AAPL', 5, 65_000, new Date('2026-11-03T16:00:00Z')),
    legacyBuy,
    fill('sell', 'AAPL', 5, 60_000, '2026-10-30T20:00:00Z'),
    fill('buy', 'MSFT', 3, 150_000, '2026-10-31T14:00:00Z'),
    { ...fill('buy', 'AMD', 50, 100_000, '2026-10-31T18:00:00Z'), status: 'rejected' },
    fill('buy', 'FUTURE', 1, 100, '2026-11-05T16:00:00Z'),
  ];
  const benchmarkBars = [bar('2026-10-30T04:00:00Z', 560), bar('2026-11-03T05:00:00Z', 568)];
  const barsByTicker = new Map([
    ['AAPL', [bar('2026-10-30T04:00:00Z', 110), bar('2026-11-02T05:00:00Z', 125)]],
    ['MSFT', [bar('2026-11-02T05:00:00Z', 510), bar('2026-11-03T05:00:00Z', 520)]],
  ]);
  assert.deepEqual(equityHistoryRequirements({ receipts, asOf }), {
    fromDate: '2026-10-30', windowStartDate: '2026-10-05', throughDate: '2026-11-03',
    tickers: ['AAPL', 'MSFT'], invalidLedger: false,
  });
  const expectedAccount = { cashCents: 2_375_000, positions: [{ ticker: 'MSFT', quantity: 3 }] };
  assert.deepEqual(history({ receipts, benchmarkBars, barsByTicker, expectedAccount }), {
    points: [
      { date: '2026-10-30', nav: 25100, spyClose: 560 },
      { date: '2026-11-02', nav: 25255, spyClose: null },
      { date: '2026-11-03', nav: 25310, spyClose: 568 },
    ],
    attribution: [
      { date: '2026-10-30', contributions: [] },
      { date: '2026-11-02', contributions: [{ ticker: 'AAPL', cents: 12_500 }, { ticker: 'MSFT', cents: 3_000 }] },
      { date: '2026-11-03', contributions: [{ ticker: 'AAPL', cents: 15_000 }, { ticker: 'MSFT', cents: 6_000 }] },
    ],
    missingSessions: 0, missingBenchmarkSessions: 1, invalidLedger: false,
  });
});

test('close-to-close contributions reconcile for any two marks, including fully sold and newly bought symbols', () => {
  const receipts = [
    fill('buy', 'AAPL', 1, 10_000, '2026-10-29T15:00:00Z'),
    fill('buy', 'MSFT', 1, 10_000, '2026-10-29T15:01:00Z'),
    fill('buy', 'NVDA', 1, 5_000, '2026-10-30T15:00:00Z'),
    fill('sell', 'AAPL', 1, 12_000, '2026-10-30T20:00:00Z'),
    fill('buy', 'AMD', 1, 2_000, '2026-11-03T16:00:00Z'),
    fill('sell', 'AMD', 1, 2_300, '2026-11-03T17:00:00Z'),
    fill('buy', 'MSFT', 1, 8_000, '2026-11-04T17:00:00Z'),
  ];
  const dates = ['2026-10-29T04:00:00Z', '2026-10-30T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-03T05:00:00Z'];
  const barsByTicker = new Map([
    ['AAPL', [bar(dates[0], 100), bar(dates[1], 110)]],
    ['MSFT', dates.map((date, index) => bar(date, [100, 99, 90, 90][index]))],
    ['NVDA', dates.slice(1).map((date, index) => bar(date, [55, 55, 57][index]))],
  ]);
  const result = history({
    receipts,
    startingCashCents: 100_000,
    benchmarkBars: dates.map(date => bar(date, 560)),
    barsByTicker,
    expectedAccount: { cashCents: 79_300, positions: [{ ticker: 'MSFT', quantity: 2 }, { ticker: 'NVDA', quantity: 1 }] },
  });

  assert.deepEqual(result.points.map(point => point.nav), [1000, 1014, 1015, 1020]);
  const contributions = result.attribution.map(point => Object.fromEntries(point.contributions.map(({ ticker, cents }) => [ticker, cents])));
  assert.deepEqual(contributions, [
    {},
    { AAPL: 1000, MSFT: -100, NVDA: 500 },
    { AAPL: 2000, MSFT: -1000, NVDA: 500 },
    { AAPL: 2000, AMD: 300, MSFT: -1000, NVDA: 700 },
  ]);
  for (let start = 0; start < contributions.length; start++) {
    for (let end = start + 1; end < contributions.length; end++) {
      const symbols = new Set([...Object.keys(contributions[start]), ...Object.keys(contributions[end])]);
      const sum = [...symbols].reduce((cents, ticker) => cents + (contributions[end][ticker] ?? 0) - (contributions[start][ticker] ?? 0), 0);
      assert.equal(sum, Math.round(result.points[end].nav * 100) - Math.round(result.points[start].nav * 100));
    }
  }
});

test('fractional close marks allocate the same cent rounding as the aggregate NAV', () => {
  const receipts = [
    fill('buy', 'AAPL', 1, 1, '2026-11-02T16:00:00Z'),
    fill('buy', 'MSFT', 1, 1, '2026-11-02T16:01:00Z'),
  ];
  const first = '2026-11-02T05:00:00Z';
  const last = '2026-11-03T05:00:00Z';
  const result = history({ receipts, barsByTicker: new Map([
    ['AAPL', [bar(first, .0051), bar(last, .0051)]],
    ['MSFT', [bar(first, .0051), bar(last, .0101)]],
  ]) });
  assert.deepEqual(result.points.map(point => point.nav), [24999.99, 25000]);
  assert.deepEqual(result.attribution, [
    { date: '2026-11-02', contributions: [] },
    { date: '2026-11-03', contributions: [{ ticker: 'MSFT', cents: 1 }] },
  ]);
});

test('missing or conflicting held closes leave gaps and no future price is substituted', () => {
  const receipts = [
    fill('buy', 'AAPL', 1, 10_000, '2026-10-29T14:00:00Z'),
    fill('buy', 'MSFT', 1, 20_000, '2026-10-29T14:01:00Z'),
  ];
  const benchmarkBars = [
    bar('2026-10-29T04:00:00Z', 560),
    bar('2026-10-30T04:00:00Z', 561),
    bar('2026-11-02T05:00:00Z', 568),
  ];
  const barsByTicker = new Map([
    ['AAPL', [
      bar('2026-10-29T04:00:00Z', 105),
      bar('2026-10-30T04:00:00Z', 106),
      bar('2026-11-02T05:00:00Z', 110),
      bar('2026-11-02T05:00:00Z', 115),
    ]],
    ['MSFT', [bar('2026-10-29T04:00:00Z', 210), bar('2026-11-02T05:00:00Z', 215)]],
  ]);
  assert.deepEqual(history({ receipts, benchmarkBars, barsByTicker }), {
    points: [
      { date: '2026-10-29', nav: 25015, spyClose: 560 },
      { date: '2026-10-30', nav: null, spyClose: 561 },
      { date: '2026-11-02', nav: null, spyClose: 568 },
      { date: '2026-11-03', nav: null, spyClose: null },
    ],
    attribution: [{ date: '2026-10-29', contributions: [] }],
    missingSessions: 3, missingBenchmarkSessions: 1, invalidLedger: false,
  });
});

test('a complete data gap on a scheduled session stays visible without adding closed days', () => {
  const receipts = [fill('buy', 'AAPL', 1, 10_000, '2026-04-01T14:00:00Z')];
  const benchmarkBars = [
    bar('2026-04-01T04:00:00Z', 550), bar('2026-04-03T04:00:00Z', 551), bar('2026-04-06T04:00:00Z', 560),
  ];
  const barsByTicker = new Map([['AAPL', [bar('2026-04-01T04:00:00Z', 110), bar('2026-04-06T04:00:00Z', 115)]]]);
  assert.deepEqual(history({ receipts, benchmarkBars, barsByTicker, asOf: new Date('2026-04-07T20:00:00Z') }), {
    points: [
      { date: '2026-04-01', nav: 25010, spyClose: 550 },
      { date: '2026-04-02', nav: null, spyClose: null },
      { date: '2026-04-06', nav: 25015, spyClose: 560 },
    ],
    attribution: [
      { date: '2026-04-01', contributions: [] },
      { date: '2026-04-06', contributions: [{ ticker: 'AAPL', cents: 500 }] },
    ],
    missingSessions: 1, missingBenchmarkSessions: 1, invalidLedger: false,
  });
});

test('fills at a verified early close take effect at the next completed mark', () => {
  const receipts = [
    fill('buy', 'AAPL', 2, 20_000, '2026-11-27T17:59:59.999Z'),
    fill('sell', 'AAPL', 2, 24_000, '2026-11-27T18:00:00Z'),
  ];
  const benchmarkBars = [bar('2026-11-27T05:00:00Z', 580), bar('2026-11-30T05:00:00Z', 583)];
  const barsByTicker = new Map([['AAPL', [bar('2026-11-27T05:00:00Z', 110)]]]);
  assert.deepEqual(history({ receipts, benchmarkBars, barsByTicker, asOf: new Date('2026-12-01T20:00:00Z') }).points, [
    { date: '2026-11-27', nav: 25020, spyClose: 580 },
    { date: '2026-11-30', nav: 25040, spyClose: 583 },
  ]);
});

test('an unverified short-day candidate omits an ambiguous afternoon mark', () => {
  const receipts = [
    fill('buy', 'AAPL', 2, 20_000, '2029-11-23T17:00:00Z'),
    fill('sell', 'AAPL', 2, 24_000, '2029-11-23T19:00:00Z'),
  ];
  const benchmarkBars = [bar('2029-11-23T05:00:00Z', 580), bar('2029-11-26T05:00:00Z', 583)];
  const barsByTicker = new Map([['AAPL', [bar('2029-11-23T05:00:00Z', 110)]]]);
  assert.deepEqual(history({ receipts, benchmarkBars, barsByTicker, asOf: new Date('2029-11-27T20:00:00Z') }), {
    points: [
      { date: '2029-11-23', nav: null, spyClose: 580 },
      { date: '2029-11-26', nav: 25040, spyClose: 583 },
    ],
    attribution: [{ date: '2029-11-26', contributions: [] }],
    missingSessions: 1, missingBenchmarkSessions: 0, invalidLedger: false,
  });
});

test('same-time fills preserve ledger order and reconciliation includes current-day fills', () => {
  const timestamp = '2026-11-03T16:00:00Z';
  const receipts = [
    fill('buy', 'AAPL', 2, 2000, timestamp),
    fill('sell', 'AAPL', 2, 4000, timestamp),
    fill('buy', 'MSFT', 1, 1500, '2026-11-04T17:00:00Z'),
  ];
  const benchmarkBars = [bar('2026-11-03T05:00:00Z', 560)];
  const expectedAccount = { cashCents: 2_500_500, positions: [{ ticker: 'MSFT', quantity: 1 }] };
  assert.deepEqual(history({ receipts, benchmarkBars, expectedAccount }).points, [
    { date: '2026-11-03', nav: 25020, spyClose: 560 },
  ]);
  assert.equal(history({ receipts, benchmarkBars, expectedAccount: { ...expectedAccount, cashCents: 1 } }).invalidLedger, true);
  assert.equal(history({ receipts: [receipts[1], receipts[0]], benchmarkBars }).invalidLedger, true);
});

test('malformed filled receipts or an inconsistent account never produce points', () => {
  const malformed = fill('buy', 'AAPL', 1, undefined, '2026-11-03T16:00:00Z');
  assert.deepEqual(history({ receipts: [malformed] }), {
    points: [], attribution: [], missingSessions: 0, missingBenchmarkSessions: 0, invalidLedger: true,
  });
  assert.equal(history({ expectedAccount: { cashCents: 0, positions: [] } }).invalidLedger, true);
});

test('history requests and marks cover at most 30 days without truncating earlier fills', () => {
  const asOf = new Date('2026-12-15T22:00:00Z');
  const receipts = [
    fill('buy', 'AAPL', 10, 100_000, '2026-09-08T15:00:00Z'),
    fill('buy', 'MSFT', 2, 40_000, '2026-09-08T15:01:00Z'),
    fill('sell', 'MSFT', 2, 50_000, '2026-10-01T15:00:00Z'),
  ];
  const benchmarkBars = [
    bar('2026-11-13T05:00:00Z', 565),
    bar('2026-11-16T05:00:00Z', 570),
    bar('2026-12-14T05:00:00Z', 577),
    bar('2026-12-15T05:00:00Z', 582),
  ];
  const barsByTicker = new Map([
    ['AAPL', [bar('2026-11-16T05:00:00Z', 105), bar('2026-12-14T05:00:00Z', 120)]],
  ]);
  assert.deepEqual(equityHistoryRequirements({ receipts, asOf }), {
    fromDate: '2026-11-15', windowStartDate: '2026-11-15', throughDate: '2026-12-14',
    tickers: ['AAPL'], invalidLedger: false,
  });
  const result = history({ receipts, benchmarkBars, barsByTicker, asOf });
  assert.deepEqual(result.points.filter(point => point.nav !== null), [
    { date: '2026-11-16', nav: 25150, spyClose: 570 },
    { date: '2026-12-14', nav: 25300, spyClose: 577 },
  ]);
  assert.equal(result.points.length, 20);
  assert.equal(result.missingSessions, 18);
});
