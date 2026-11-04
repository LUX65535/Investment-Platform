const marketClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});

const historyCalendarDays = 30;

// NYSE Group cash-equity calendars and the separately announced Jan. 9, 2025 closure.
// https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx
// https://www.nyse.com/trade/hours-calendars
// https://beta.nyse.com/publicdocs/nyse/markets/american-options/rule-interpretations/2025/National_Day_of_Mourning_20250102.pdf
const marketHolidays = new Set([
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04',
  '2028-09-04', '2028-11-23', '2028-12-25',
]);
const earlyCloses = new Set([
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24',
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

function hasPublishedSchedule(date) {
  return date >= '2025-01-01' && date <= '2028-12-31';
}

function isWeekend(date) {
  const dayOfWeek = calendarDay(date).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function isScheduledEquitySession(date) {
  return hasPublishedSchedule(date) && !isWeekend(date) && !marketHolidays.has(date);
}

function sessionClose(date) {
  if (earlyCloses.has(date)) return 13;
  if (hasPublishedSchedule(date)) return 16;

  const monthDay = date.slice(5);
  const afterThanksgiving = monthDay >= '11-23' && monthDay <= '11-29' && calendarDay(date).getUTCDay() === 5;
  // Outside the published schedule, omit ambiguous afternoon marks on possible short days.
  return afterThanksgiving || ['07-02', '07-03', '12-24'].includes(monthDay) ? null : 16;
}

function sessionCloseAt(date) {
  const close = sessionClose(date);
  if (close === null) return null;
  const midnight = calendarDay(date).getTime();
  // Compare noon UTC to the Eastern wall clock after any overnight DST change.
  const easternNoon = marketTime(midnight + 12 * 3_600_000).hour;
  return new Date(midnight + (close + 12 - easternNoon) * 3_600_000);
}

function completedHistoryWindow(asOfMs) {
  const throughDate = daysBefore(marketDate(asOfMs), 1);
  return { windowStartDate: daysBefore(throughDate, historyCalendarDays - 1), throughDate };
}

function eventTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

function readLedger({ receipts, walletInitializedAt, asOf }) {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : asOf;
  if (!Number.isFinite(asOfMs)) throw new TypeError('A valid as-of time is required.');
  const { windowStartDate, throughDate } = completedHistoryWindow(asOfMs);
  const fills = [];
  const invalid = { fills: [], begin: null, fromDate: null, windowStartDate, throughDate, asOfMs, invalidLedger: true };

  for (const receipt of receipts) {
    if (receipt?.status !== 'filled') continue;
    const timestamp = eventTimestamp(receipt.submittedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return invalid;
    if (timestamp > asOfMs) continue;

    const { side, ticker, quantity, totalCents } = receipt;
    if ((side !== 'buy' && side !== 'sell') || typeof ticker !== 'string' || !ticker
        || !Number.isSafeInteger(quantity) || quantity <= 0
        || !Number.isSafeInteger(totalCents) || totalCents <= 0) return invalid;
    fills.push({ side, ticker, quantity, totalCents, timestamp, source: receipt.source, ...marketTime(timestamp) });
  }
  // Stable sort preserves the stored ledger order for fills with the same timestamp.
  fills.sort((first, second) => first.timestamp - second.timestamp);

  let begin = fills[0] ?? null;
  if (walletInitializedAt != null) {
    const timestamp = eventTimestamp(walletInitializedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || (begin && timestamp > begin.timestamp)) return invalid;
    begin = timestamp <= asOfMs ? marketTime(timestamp) : null;
  }
  const fromDate = begin && (begin.date > windowStartDate ? begin.date : windowStartDate);
  return { fills, begin, fromDate, windowStartDate, throughDate, asOfMs, invalidLedger: false };
}

function equityHistoryRequirements(options) {
  const { fills, fromDate, windowStartDate, throughDate, invalidLedger } = readLedger(options);
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
  return { fromDate, windowStartDate, throughDate, tickers: [...tickers].sort(), invalidLedger };
}

function dailyCloseBars(bars, fromDate, throughDate, asOfMs) {
  const closes = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (!Number.isSafeInteger(bar?.t) || bar.t <= 0 || bar.t > asOfMs || !Number.isFinite(bar.c) || bar.c <= 0) continue;
    const date = marketDate(bar.t);
    if (date < fromDate || date > throughDate) continue;
    if (isWeekend(date) || marketHolidays.has(date)) continue;
    // A provider should give one daily bar. Conflicting closes leave a gap.
    closes.set(date, closes.has(date) && closes.get(date)?.c !== bar.c ? null : { t: bar.t, c: bar.c });
  }
  return closes;
}

function dailyCloses(bars, fromDate, throughDate, asOfMs) {
  return new Map([...dailyCloseBars(bars, fromDate, throughDate, asOfMs)]
    .map(([date, bar]) => [date, bar?.c ?? null]));
}

function beforeClose(event, date, closeHour) {
  if (event.date !== date) return event.date < date;
  if (event.hour < closeHour) return true;
  // A prepared fill is explicitly modeled at this closing price and belongs to the same closing mark.
  return event.source === 'prepared' && event.timestamp === sessionCloseAt(date)?.getTime();
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
  for (let date = fromDate; date <= throughDate; date = daysBefore(date, -1)) {
    if (isScheduledEquitySession(date)) dates.add(date);
  }
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
    // An unrelated bar cannot anchor a date outside the published calendar.
    if (!knownSession && !isScheduledEquitySession(date)) continue;

    const nextFill = fills[fillIndex];
    const uncertainCutoff = close === null && nextFill?.date === date && nextFill.hour < 16;
    const navCents = account.cashCents + Math.round((markedValue + markedValue * Number.EPSILON) * 100);
    const nav = !knownSession || uncertainCutoff || priced < account.holdings.size || !Number.isSafeInteger(navCents)
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

module.exports = { completedHistoryWindow, dailyCloseBars, equityHistoryRequirements, marketDate, reconstructEquityHistory, sessionCloseAt };
