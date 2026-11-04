const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadPortfolioHistory } = require('../lib/load-portfolio-history');

const asOf = new Date('2026-11-04T16:00:00Z');
const walletInitializedAt = new Date('2026-11-03T14:30:00Z');
const startingCashCents = 2_500_000;

function accountWithPositions(tickers) {
  return {
    cashCents: startingCashCents - tickers.length * 10_000,
    walletInitializedAt,
    receipts: tickers.map(ticker => ({
      ticker, status: 'filled', side: 'buy', quantity: 1, totalCents: 10_000,
      submittedAt: new Date('2026-11-03T15:00:00Z'),
    })),
    positions: tickers.map(ticker => ({ ticker, quantity: 1 })),
  };
}

test('history bounds upstream requests and reports a gap for an unrequested holding', async () => {
  const requested = [];
  const history = await loadPortfolioHistory(
    accountWithPositions(['AAPL', 'MSFT', 'NVDA', 'AMZN']),
    startingCashCents,
    async (ticker, fromDate, throughDate) => {
      requested.push([ticker, fromDate, throughDate]);
      return [{ t: Date.parse('2026-11-03T05:00:00Z'), c: ticker === 'SPY' ? 600 : 110 }];
    },
    asOf
  );
  assert.deepEqual(requested, ['SPY', 'AAPL', 'MSFT', 'NVDA'].map(ticker => [ticker, '2026-10-05', '2026-11-03']));
  assert.equal(history.status, 'partial');
  assert.match(history.message, /up to 3 other symbols plus SPY/);
  assert.deepEqual(history.points, [{ date: '2026-11-03', nav: null, spyClose: 600 }]);
  assert.deepEqual(history.attribution, []);
  assert.equal(history.missingSessions, 1);
});

test('history preserves an available NAV when SPY fails and reports a total outage separately', async () => {
  const account = accountWithPositions(['AAPL']);
  const failedRead = () => { throw new Error('Provider unavailable'); };
  const history = await loadPortfolioHistory(account, startingCashCents, async ticker => {
    if (ticker === 'SPY') return failedRead();
    return [{ t: Date.parse('2026-11-03T05:00:00Z'), c: 110 }];
  }, asOf);
  assert.equal(history.status, 'partial');
  assert.match(history.message, /SPY history is unavailable/);
  assert.deepEqual(history.points, [{ date: '2026-11-03', nav: 25010, spyClose: null }]);
  assert.equal(history.missingBenchmarkSessions, 1);

  const outage = await loadPortfolioHistory(account, startingCashCents, async () => failedRead(), asOf);
  assert.equal(outage.status, 'temporarily_unavailable');
  assert.deepEqual(outage.points, []);
  assert.deepEqual(outage.attribution, []);
});

const bar = (date, c) => ({ t: Date.parse(date + 'T05:00:00Z'), c });
const preparedCloseSnapshot = {
  windowStartDate: '2026-10-05',
  throughDate: '2026-11-03',
  series: [
    { ticker: 'SPY', bars: [bar('2026-11-03', 600)] },
    { ticker: 'AAPL', bars: [bar('2026-11-03', 110)] },
  ],
};

test('prepared history survives a cold instance and only requests any added symbol in the same window', async () => {
  const requested = [];
  const read = async (ticker, fromDate, throughDate) => {
    requested.push([ticker, fromDate, throughDate]);
    return [bar('2026-11-03', 125)];
  };
  const prepared = { ...accountWithPositions(['AAPL']), preparedCloseSnapshot };
  const first = await loadPortfolioHistory(prepared, startingCashCents, read, asOf);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.points, [{ date: '2026-11-03', nav: 25010, spyClose: 600 }]);
  assert.deepEqual(requested, []);

  const withNewHolding = { ...accountWithPositions(['AAPL', 'MSFT']), preparedCloseSnapshot };
  const afterBuying = await loadPortfolioHistory(withNewHolding, startingCashCents, read, asOf.getTime());
  assert.equal(afterBuying.status, 'ok');
  assert.deepEqual(afterBuying.points, [{ date: '2026-11-03', nav: 25035, spyClose: 600 }]);
  assert.deepEqual(requested, [['MSFT', '2026-10-05', '2026-11-03']]);
});

test('prepared history keeps verified closes during an outage and merges newer closing data by date', async () => {
  const prepared = { ...accountWithPositions(['AAPL']), preparedCloseSnapshot };
  const after = new Date('2026-11-06T16:00:00Z');
  const outage = await loadPortfolioHistory(prepared, startingCashCents, () => {
    throw new Error('Provider unavailable');
  }, after);
  assert.equal(outage.status, 'partial');
  assert.match(outage.message, /Some historical prices could not load/);
  assert.deepEqual(outage.points, [
    { date: '2026-11-03', nav: 25010, spyClose: 600 },
    { date: '2026-11-04', nav: null, spyClose: null },
    { date: '2026-11-05', nav: null, spyClose: null },
  ]);

  const refreshed = await loadPortfolioHistory(prepared, startingCashCents, async ticker => {
    if (ticker === 'SPY') return [bar('2026-11-05', 612), bar('2026-11-04', 607)];
    return [bar('2026-11-05', 120), bar('2026-11-04', 114)];
  }, after);
  assert.equal(refreshed.status, 'ok');
  assert.deepEqual(refreshed.points, [
    { date: '2026-11-03', nav: 25010, spyClose: 600 },
    { date: '2026-11-04', nav: 25014, spyClose: 607 },
    { date: '2026-11-05', nav: 25020, spyClose: 612 },
  ]);
  assert.deepEqual(refreshed.attribution, [
    { date: '2026-11-03', contributions: [] },
    { date: '2026-11-04', contributions: [{ ticker: 'AAPL', cents: 400 }] },
    { date: '2026-11-05', contributions: [{ ticker: 'AAPL', cents: 1000 }] },
  ]);
});
