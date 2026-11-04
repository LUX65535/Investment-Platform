const marketClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});

const historyCalendarDays = 30;

// NYSE's published 2025–2027 13:00 ET equity closes.
// https://www.nyse.com/markets/hours-calendars
const earlyCloses = new Set([
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24', '2027-11-26',
]);

function marketTime(timestamp) {
  const parts = marketClock.formatToParts(timestamp);
  const { year, month, day, hour } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}

function marketDate(timestamp) {
  return marketTime(timestamp).date;
}

function calendarDay(date) {
  return new Date(date + 'T00:00:00Z');
}

function daysBefore(date, days) {
  const day = calendarDay(date);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

function sessionClose(date) {
  if (earlyCloses.has(date)) return 13;
  if (date >= '2025-01-01' && date <= '2027-12-31') return 16;

  const monthDay = date.slice(5);
  const afterThanksgiving = monthDay >= '11-23' && monthDay <= '11-29' && calendarDay(date).getUTCDay() === 5;
  // Outside the published schedule, omit ambiguous afternoon marks on possible short days.
  return afterThanksgiving || ['07-02', '07-03', '12-24'].includes(monthDay) ? null : 16;
}

function eventTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

function readLedger({ receipts, walletInitializedAt, asOf }) {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : asOf;
  if (!Number.isFinite(asOfMs)) throw new TypeError('A valid as-of time is required.');
  const throughDate = daysBefore(marketDate(asOfMs), 1);
  const earliestDate = daysBefore(throughDate, historyCalendarDays - 1);
  const fills = [];
  const invalid = { fills: [], begin: null, fromDate: null, throughDate, asOfMs, invalidLedger: true };

  for (const receipt of receipts) {
    if (receipt?.status !== 'filled') continue;
    const timestamp = eventTimestamp(receipt.submittedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return invalid;
    if (timestamp > asOfMs) continue;

    const { side, ticker, quantity, totalCents } = receipt;
    if ((side !== 'buy' && side !== 'sell') || typeof ticker !== 'string' || !ticker
        || !Number.isSafeInteger(quantity) || quantity <= 0
        || !Number.isSafeInteger(totalCents) || totalCents <= 0) return invalid;
    fills.push({ side, ticker, quantity, totalCents, timestamp, ...marketTime(timestamp) });
  }
  // Stable sort preserves the stored ledger order for fills with the same timestamp.
  fills.sort((first, second) => first.timestamp - second.timestamp);

  let begin = fills[0] ?? null;
  if (walletInitializedAt != null) {
    const timestamp = eventTimestamp(walletInitializedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || (begin && timestamp > begin.timestamp)) return invalid;
    begin = timestamp <= asOfMs ? marketTime(timestamp) : null;
  }
  const fromDate = begin && (begin.date > earliestDate ? begin.date : earliestDate);
  return { fills, begin, fromDate, throughDate, asOfMs, invalidLedger: false };
}

function equityHistoryRequirements(options) {
  const { fills, fromDate, throughDate, invalidLedger } = readLedger(options);
  const sharesBeforeWindow = new Map();
  const tickers = new Set();
  const cutoff = sessionClose(throughDate) ?? 13;
  for (const fill of fills) {
    if (!fromDate || !beforeClose(fill, throughDate, cutoff)) break;
    if (fill.date >= fromDate) {
      tickers.add(fill.ticker);
    } else {
      const signedQuantity = fill.side === 'buy' ? fill.quantity : -fill.quantity;
      sharesBeforeWindow.set(fill.ticker, (sharesBeforeWindow.get(fill.ticker) ?? 0) + signedQuantity);
    }
  }
  for (const [ticker, shares] of sharesBeforeWindow) {
    if (shares > 0) tickers.add(ticker);
  }
  return { fromDate, throughDate, tickers: [...tickers].sort(), invalidLedger };
}

function dailyCloses(bars, fromDate, throughDate, asOfMs) {
  const closes = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (!Number.isSafeInteger(bar?.t) || bar.t <= 0 || bar.t > asOfMs || !Number.isFinite(bar.c) || bar.c <= 0) continue;
    const date = marketDate(bar.t);
    if (date < fromDate || date > throughDate) continue;
    const dayOfWeek = calendarDay(date).getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    // A provider should give one daily bar. Conflicting closes leave a gap.
    closes.set(date, closes.has(date) && closes.get(date) !== bar.c ? null : bar.c);
  }
  return closes;
}

function beforeClose(event, date, closeHour) {
  return event.date < date || (event.date === date && event.hour < closeHour);
}

function applyFill(account, fill) {
  const direction = fill.side === 'buy' ? 1 : -1;
  const cash = account.cashCents - direction * fill.totalCents;
  const shares = (account.holdings.get(fill.ticker) ?? 0) + direction * fill.quantity;
  if (!Number.isSafeInteger(cash) || cash < 0 || !Number.isSafeInteger(shares) || shares < 0) return false;

  account.cashCents = cash;
  if (shares) account.holdings.set(fill.ticker, shares);
  else account.holdings.delete(fill.ticker);
  return true;
}

function matchesAccount(replay, expectedAccount) {
  if (replay.cashCents !== expectedAccount.cashCents || !Array.isArray(expectedAccount.positions)) return false;
  const positions = new Map(expectedAccount.positions.map(position => [position.ticker, position.quantity]));
  return positions.size === expectedAccount.positions.length && replay.holdings.size === positions.size
    && [...positions].every(([ticker, quantity]) => replay.holdings.get(ticker) === quantity);
}

function emptyHistory(invalidLedger = false) {
  return { points: [], missingSessions: 0, missingBenchmarkSessions: 0, invalidLedger };
}

/**
 * Replays the stored paper ledger using unadjusted held-symbol closes.
 * This ledger has no corporate-action adjustments for splits or dividends.
 * Missing closes leave gaps. No trade price is substituted as a daily close.
 */
function reconstructEquityHistory({
  receipts, walletInitializedAt, startingCashCents, benchmarkBars, barsByTicker, asOf, expectedAccount,
}) {
  if (!Number.isSafeInteger(startingCashCents) || startingCashCents <= 0) throw new TypeError('Starting cash must be positive cents.');
  const timeline = readLedger({ receipts, walletInitializedAt, asOf });
  if (timeline.invalidLedger) return emptyHistory(true);
  const account = { cashCents: startingCashCents, holdings: new Map() };
  if (!timeline.begin) return emptyHistory(Boolean(expectedAccount && !matchesAccount(account, expectedAccount)));
  const result = emptyHistory();
  const { fills, begin, fromDate, throughDate, asOfMs } = timeline;

  const spyCloses = dailyCloses(benchmarkBars, fromDate, throughDate, asOfMs);
  const closesByTicker = new Map();
  const dates = new Set(spyCloses.keys());
  for (const ticker of new Set(fills.map(fill => fill.ticker))) {
    const closes = dailyCloses(barsByTicker.get(ticker) ?? [], fromDate, throughDate, asOfMs);
    closesByTicker.set(ticker, closes);
    for (const date of closes.keys()) dates.add(date);
  }

  let fillIndex = 0;
  for (const date of [...dates].sort()) {
    const close = sessionClose(date);
    const cutoff = close ?? 13;
    if (!beforeClose(begin, date, cutoff)) continue;

    while (fillIndex < fills.length && beforeClose(fills[fillIndex], date, cutoff)) {
      if (!applyFill(account, fills[fillIndex++])) return emptyHistory(true);
    }

    const spyClose = spyCloses.get(date) ?? null;
    let knownSession = spyCloses.has(date);
    let markedValue = 0;
    let priced = 0;
    for (const [ticker, quantity] of account.holdings) {
      const closes = closesByTicker.get(ticker);
      if (closes?.has(date)) knownSession = true;
      const closePrice = closes?.get(date);
      if (closePrice == null) continue;
      markedValue += quantity * closePrice;
      priced++;
    }
    // A bar for a previously sold symbol alone does not anchor a cash-only date.
    if (!knownSession) continue;

    const nextFill = fills[fillIndex];
    const uncertainCutoff = close === null && nextFill?.date === date && nextFill.hour < 16;
    const navCents = account.cashCents + Math.round((markedValue + markedValue * Number.EPSILON) * 100);
    const nav = uncertainCutoff || priced < account.holdings.size || !Number.isSafeInteger(navCents)
      ? null : navCents / 100;
    result.points.push({ date, nav, spyClose });
    if (nav === null) result.missingSessions++;
    if (spyClose === null) result.missingBenchmarkSessions++;
  }

  // Newer fills are needed for reconciliation even when no completed bar can use them.
  while (fillIndex < fills.length) {
    if (!applyFill(account, fills[fillIndex++])) return emptyHistory(true);
  }
  if (expectedAccount && !matchesAccount(account, expectedAccount)) return emptyHistory(true);
  return result;
}

module.exports = { equityHistoryRequirements, marketDate, reconstructEquityHistory };
