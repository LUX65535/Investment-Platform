const { completedHistoryWindow, dailyCloses, sessionCloseAt } = require('./portfolio-equity-history');

const allocations = [
  { ticker: 'AAPL', percent: 42 },
  { ticker: 'MSFT', percent: 32 },
];

async function planPreparedPortfolio(startingCashCents, getHistoricalCloses, asOf = new Date()) {
  const asOfMs = asOf.getTime();
  const { windowStartDate, throughDate } = completedHistoryWindow(asOfMs);
  const symbols = ['SPY', ...allocations.map(({ ticker }) => ticker)];
  const closeMaps = await Promise.all(symbols.map(async ticker => dailyCloses(
    await getHistoricalCloses(ticker, windowStartDate, throughDate), windowStartDate, throughDate, asOfMs,
  )));
  const sessions = [...closeMaps[0].keys()].sort()
    .filter(date => closeMaps.every(closes => closes.get(date) != null))
    .map(date => ({ date, closedAt: sessionCloseAt(date) }))
    .filter(({ closedAt }) => closedAt !== null);
  if (sessions.length < 6) return null;

  const buys = allocations.map(({ ticker, percent }, index) => {
    const { date, closedAt } = sessions[index];
    const price = closeMaps[index + 1].get(date);
    const quantity = Math.floor(startingCashCents * percent / 100 / (price * 100));
    return { side: 'buy', ticker, quantity, price, closedAt };
  });
  if (buys.some(({ quantity }) => !Number.isSafeInteger(quantity) || quantity < 2)) return null;

  const { date, closedAt } = sessions[Math.floor(sessions.length / 2)];
  return {
    // Open the paper wallet before the first modeled close; historical marks can start that day.
    walletInitializedAt: new Date(buys[0].closedAt.getTime() - 60_000),
    orders: [...buys, {
      side: 'sell', ticker: buys[0].ticker, quantity: Math.floor(buys[0].quantity / 4) || 1,
      price: closeMaps[1].get(date), closedAt,
    }],
  };
}

module.exports = { planPreparedPortfolio };
