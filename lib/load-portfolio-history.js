const { equityHistoryRequirements, reconstructEquityHistory } = require('./portfolio-equity-history');

const benchmark = 'SPY';
const maxSymbolsPerRequest = 4;

function unavailable(status, message) {
  return { status, message, points: [], missingSessions: 0, missingBenchmarkSessions: 0 };
}

async function loadPortfolioHistory(sandbox, startingCashCents, getHistoricalCloses, asOf = new Date()) {
  if (sandbox.cashCents === null) {
    return unavailable('not_initialized', 'Initialize your paper wallet to start recording account history.');
  }

  const ledger = {
    receipts: sandbox.receipts,
    walletInitializedAt: sandbox.walletInitializedAt,
    asOf,
  };
  const { fromDate, windowStartDate, throughDate, tickers, invalidLedger } = equityHistoryRequirements(ledger);
  if (invalidLedger) {
    return unavailable('ledger_unavailable', 'The saved order records are insufficient to reconstruct this account.');
  }
  if (!fromDate || fromDate > throughDate) {
    return unavailable('insufficient', 'There are no completed trading sessions with a known account value yet.');
  }

  const tickersNeeded = new Set(tickers);
  const prioritized = new Set([
    benchmark,
    ...sandbox.positions.map(({ ticker }) => ticker).filter(ticker => tickersNeeded.has(ticker)),
    ...tickers,
  ]);
  const requested = [...prioritized].slice(0, maxSymbolsPerRequest);
  // The same market window lets accounts reuse public bars regardless of their start date.
  const responses = await Promise.allSettled(
    requested.map(ticker => getHistoricalCloses(ticker, windowStartDate, throughDate))
  );
  const closes = new Map();
  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === 'fulfilled') closes.set(requested[i], responses[i].value);
  }
  if (!closes.size) {
    return unavailable('temporarily_unavailable', 'Historical prices are temporarily unavailable. Try again in a moment.');
  }

  const history = reconstructEquityHistory({
    ...ledger,
    startingCashCents,
    benchmarkBars: closes.get(benchmark) ?? [],
    barsByTicker: closes,
    expectedAccount: { cashCents: sandbox.cashCents, positions: sandbox.positions },
  });
  if (history.invalidLedger) {
    return unavailable('ledger_unavailable', 'The saved orders do not reconcile with your cash and positions.');
  }

  const notices = [];
  if (prioritized.size > requested.length) {
    notices.push(`This history covers up to ${maxSymbolsPerRequest - 1} other symbols plus SPY. Sessions that need additional closing prices have gaps.`);
  }
  if (responses.some(result => result.status === 'rejected')) {
    notices.push('Some historical prices could not load. Refresh to try again.');
  }
  if (!closes.get(benchmark)?.length) {
    notices.push('SPY history is unavailable for this period.');
  }
  if (!history.points.length && !notices.length) {
    notices.push('There are no completed trading sessions with available prices in this period.');
  }

  return {
    ...history,
    status: notices.length || history.missingSessions || history.missingBenchmarkSessions ? 'partial' : 'ok',
    message: notices.join(' '),
  };
}

module.exports = { loadPortfolioHistory };
