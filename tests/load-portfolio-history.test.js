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
});
