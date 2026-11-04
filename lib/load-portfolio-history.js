const { dailyCloseBars, equityHistoryRequirements, reconstructEquityHistory } = require('./portfolio-equity-history');

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
  const asOfMs = Number(asOf);
  const snapshot = sandbox.preparedCloseSnapshot;
  const snapshotCoversWindow = snapshot?.throughDate === throughDate && snapshot.windowStartDate <= windowStartDate;
  const savedBars = new Map((snapshot?.series ?? []).map(({ ticker, bars }) => [ticker, bars]));
  const closes = new Map();
  for (const ticker of requested) {
    const saved = dailyCloseBars(savedBars.get(ticker), windowStartDate, throughDate, asOfMs);
    if (saved.size) closes.set(ticker, saved);
  }
  // A prepared ledger already holds a complete request's closing bars for this window.
  const missing = requested.filter(ticker => !snapshotCoversWindow || !closes.has(ticker));
  // The same market window lets accounts reuse public bars regardless of their start date.
  const responses = await Promise.allSettled(missing.map(async ticker => (
    getHistoricalCloses(ticker, windowStartDate, throughDate)
  )));
  const prices = new Map([...closes].map(([ticker, bars]) => [ticker, [...bars.values()]]));
  for (let i = 0; i < responses.length; i++) {
    const result = responses[i];
    if (result.status !== 'fulfilled') continue;
    const ticker = missing[i];
    const saved = closes.get(ticker);
    if (!saved) {
      prices.set(ticker, result.value);
      continue;
    }
    const fetched = dailyCloseBars(result.value, windowStartDate, throughDate, asOfMs);
    for (const [date, bar] of fetched) if (bar) saved.set(date, bar);
    prices.set(ticker, [...saved.values()]);
  }
  if (!prices.size) {
    return unavailable('temporarily_unavailable', 'Historical prices are temporarily unavailable. Try again in a moment.');
  }

  const history = reconstructEquityHistory({
    ...ledger,
    startingCashCents,
    benchmarkBars: prices.get(benchmark) ?? [],
    barsByTicker: prices,
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
  if (!prices.get(benchmark)?.length) {
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
