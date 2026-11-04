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
    missingSessions: 0, missingBenchmarkSessions: 1, invalidLedger: false,
  });
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
    points: [], missingSessions: 0, missingBenchmarkSessions: 0, invalidLedger: true,
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
