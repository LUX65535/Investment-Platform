const { validateAggregates } = require('./market-aggregates');

const DAY = 86_400_000;
const HISTORY_FLOOR = Date.parse('2003-09-10');
const WARMUP_BARS = 250;
const intervals = {
  '1m': { multiplier: 1, timespan: 'minute', warmupDays: 4 },
  '5m': { multiplier: 5, timespan: 'minute', warmupDays: 8 },
  '15m': { multiplier: 15, timespan: 'minute', warmupDays: 20 },
  '1h': { multiplier: 1, timespan: 'hour', warmupDays: 55 },
  '1d': { multiplier: 1, timespan: 'day', warmupDays: 390 },
  '1wk': { multiplier: 1, timespan: 'week', warmupDays: 1800 },
  '1mo': { multiplier: 1, timespan: 'month', warmupDays: 7700 },
};
const ranges = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'Max'];
const marketDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const marketClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function dateInMarket(timestamp) {
  const parts = Object.fromEntries(marketDate.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateString(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

function candlePeriodStart(calendarDate, interval) {
  const date = new Date(calendarDate);
  if (interval === '1mo') date.setUTCDate(1);
  if (interval === '1wk') date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return date.getTime();
}

/** Interpret a UTC calendar-date marker as midnight in New York, including DST. */
function marketDayStart(calendarDate) {
  const wanted = Date.parse(dateString(calendarDate));
  let timestamp = wanted;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(marketClock.formatToParts(timestamp).map(part => [part.type, part.value]));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = wanted - observed;
    if (!correction) return timestamp;
    timestamp += correction;
  }
  throw new Error('Could not resolve the New York session boundary');
}

function monthsBefore(timestamp, months) {
  const date = new Date(timestamp);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, end));
  return date.getTime();
}

function availableIntervals(range) {
  if (!ranges.includes(range)) return [];
  return Object.keys(intervals).filter(interval => {
    if (interval === '1m') return ['1D', '5D'].includes(range);
    if (interval === '5m' || interval === '15m') return ['1D', '5D', '1M'].includes(range);
    if (interval === '1h') return ['1D', '5D', '1M', '3M'].includes(range);
    if (interval === '1wk' || interval === '1mo') return !['1D', '5D'].includes(range);
    return true;
  });
}

function researchError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function historyRequest(range, interval, now = Date.now()) {
  if (!ranges.includes(range) || !availableIntervals(range).includes(interval)) {
    throw researchError('INVALID_HISTORY_REQUEST', 'Choose an available range and candle interval.', 400);
  }
  const to = Date.parse(dateInMarket(now));
  let visibleFrom;
  if (range === '1D' || range === '5D') visibleFrom = to - (range === '1D' ? 10 : 18) * DAY;
  else if (range === 'YTD') visibleFrom = Date.UTC(new Date(to).getUTCFullYear(), 0, 1);
  else if (range === 'Max') visibleFrom = HISTORY_FLOOR;
  else visibleFrom = monthsBefore(to, { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '5Y': 60 }[range]);
  const config = intervals[interval];
  const from = Math.max(HISTORY_FLOOR, visibleFrom - config.warmupDays * DAY);
  // Dates in provider paths are calendar markers; chart cutoffs are actual
  // instants. UTC midnight would include the preceding EST evening session.
  return { range, interval, ...config, from, to, visibleDate: visibleFrom,
    visibleFrom: marketDayStart(visibleFrom), now };
}

function isPlanLimit(error) {
  return error.response?.status === 403 || error.code === 'DATA_PLAN_LIMIT';
}

/** Keep only verified provider fields; missing volume/VWAP must not become zero. */
function researchBar(bar) {
  if (!Number.isInteger(bar.t)) throw new Error('Invalid research timestamp');
  for (const field of ['o', 'h', 'l', 'c']) {
    if (!Number.isFinite(bar[field]) || bar[field] <= 0) throw new Error('Invalid research OHLC bar');
  }
  if (bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c, bar.h)) {
    throw new Error('Inconsistent research OHLC bar');
  }
  const result = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
  for (const field of ['v', 'vw', 'n']) {
    if (bar[field] === undefined) continue;
    if (!Number.isFinite(bar[field]) || bar[field] < 0 || (field === 'vw' && bar[field] === 0)
      || (field === 'n' && !Number.isInteger(bar[field]))) {
      throw new Error('Invalid research volume field');
    }
    result[field] = bar[field];
  }
  // Provider VWAP may be outside high/low because its eligible trades differ.
  return result;
}

function nextPage(nextUrl, prefix) {
  let url;
  try { url = new URL(nextUrl); } catch { throw new Error('Invalid aggregate pagination'); }
  if (url.protocol !== 'https:' || !['api.polygon.io', 'api.massive.com'].includes(url.hostname)
    || url.port || url.username || url.password || !url.pathname.startsWith(`/v2${prefix}`)) {
    throw new Error('Invalid aggregate pagination target');
  }
  const suffix = url.pathname.slice(`/v2${prefix}`.length);
  if (!/^(?:\d{4}-\d{2}-\d{2}|\d{1,16})\/(?:\d{4}-\d{2}-\d{2}|\d{1,16})$/.test(suffix)) {
    throw new Error('Invalid aggregate pagination range');
  }
  const params = {};
  for (const [key, value] of url.searchParams) {
    if (key === 'apiKey') continue;
    if (!['cursor', 'adjusted', 'sort', 'limit'].includes(key) || Object.hasOwn(params, key)) {
      throw new Error('Invalid aggregate pagination parameters');
    }
    params[key] = value;
  }
  if (!params.cursor || params.cursor.length > 4096) throw new Error('Missing aggregate pagination cursor');
  return { endpoint: url.pathname.slice(3), params: { ...params, adjusted: true, sort: 'asc', limit: 50_000 } };
}

function createResearchHistory(readPage) {
  async function fetchBars(symbol, request, from) {
    const prefix = `/aggs/ticker/${encodeURIComponent(symbol)}/range/${request.multiplier}/${request.timespan}/`;
    const validatePage = data => {
      if (data?.status === 'NOT_AUTHORIZED' || data?.status === 'FORBIDDEN') {
        throw researchError('DATA_PLAN_LIMIT', 'The data provider does not include this history in the current plan.', 403);
      }
      validateAggregates(data);
      if (data.ticker !== undefined && data.ticker !== symbol) throw new Error('Aggregate symbol does not match');
      if (data.adjusted !== undefined && data.adjusted !== true) throw new Error('Unexpected unadjusted research prices');
      for (const row of data.results || []) researchBar(row);
      if (data.next_url) nextPage(data.next_url, prefix);
    };
    let page = { endpoint: `${prefix}${dateString(from)}/${dateString(request.to)}`,
      params: { adjusted: true, sort: 'asc', limit: 50_000 } };
    const visited = new Set();
    const rows = new Map();
    let delayed = false;
    for (let index = 0; index < 8; index++) {
      const key = JSON.stringify(page);
      if (visited.has(key)) throw new Error('Repeated aggregate pagination');
      visited.add(key);
      // Cache-owning readers must validate identity, adjustment, rows and the
      // pagination target before storing a successful provider response.
      const data = await readPage(page.endpoint, page.params,
        request.timespan === 'minute' || request.timespan === 'hour' ? 30_000 : 300_000, validatePage);
      validatePage(data);
      delayed ||= data.status === 'DELAYED';
      for (const row of data.results || []) {
        const bar = researchBar(row);
        if (bar.t > request.now) continue;
        const previous = rows.get(bar.t);
        if (previous && JSON.stringify(previous) !== JSON.stringify(bar)) throw new Error('Conflicting aggregate pages');
        rows.set(bar.t, bar);
      }
      if (rows.size > 25_000) throw researchError('HISTORY_TOO_LARGE', 'Choose a shorter range or a larger candle interval.', 400);
      if (!data.next_url) return { rows: [...rows.values()].sort((a, b) => a.t - b.t), delayed };
      page = nextPage(data.next_url, prefix);
    }
    throw researchError('HISTORY_TOO_LARGE', 'Choose a shorter range or a larger candle interval.', 400);
  }

  return async function history(symbol, range, interval, now = Date.now()) {
    const request = historyRequest(range, interval, now);
    let result;
    let warmupLimited = false;
    // Some plans cover the visible window but not 250 older weekly/monthly bars.
    // Try a bounded two-year warmup before giving up all earlier study history.
    const starts = [...new Set([request.from,
      Math.max(request.from, Math.min(request.visibleFrom, request.to - 728 * DAY)),
      request.visibleFrom])].filter(from => from <= request.visibleFrom);
    for (let index = 0; index < starts.length; index++) {
      try {
        result = await fetchBars(symbol, request, starts[index]);
        warmupLimited = index > 0;
        break;
      } catch (error) {
        if (!isPlanLimit(error) || index === starts.length - 1) throw error;
      }
    }
    const rows = result.rows;
    let visibleFrom = request.visibleFrom;
    let shortSessionCount = false;
    if (range === '1D' || range === '5D') {
      const sessions = [...new Set(rows.map(bar => dateInMarket(bar.t)))];
      const requestedSessions = range === '1D' ? 1 : 5;
      shortSessionCount = sessions.length < requestedSessions;
      const firstSession = sessions[Math.max(0, sessions.length - requestedSessions)];
      visibleFrom = firstSession ? rows.find(bar => dateInMarket(bar.t) === firstSession).t : visibleFrom;
    } else if (interval === '1wk' || interval === '1mo') {
      // Keep the actual candle containing the range boundary, without fabricating
      // a partial candle from its closing price.
      visibleFrom = marketDayStart(candlePeriodStart(request.visibleDate, interval));
    }
    let visibleIndex = rows.findIndex(bar => bar.t >= visibleFrom);
    if (visibleIndex === -1) visibleIndex = rows.length;
    let warmupBars = Math.min(visibleIndex, WARMUP_BARS);
    let results = rows.slice(Math.max(0, visibleIndex - warmupBars));
    const visible = results.filter(bar => bar.t >= visibleFrom);
    let complete = false;
    let coverageMessage;
    if (!visible.length) {
      // Old warmup observations must not masquerade as an empty range's prices.
      results = [];
      warmupBars = 0;
    } else {
      const firstDate = dateInMarket(visible[0].t);
      const lastDate = dateInMarket(visible.at(-1).t);
      // Closed weekends and adjacent holidays do not imply truncated history.
      // The last weekly/monthly timestamp identifies the start of its candle.
      const grace = 4 * DAY;
      const startsLate = Date.parse(firstDate) - Date.parse(dateInMarket(visibleFrom)) > grace;
      const endsEarly = candlePeriodStart(request.to, interval) - Date.parse(lastDate) > grace;
      complete = !shortSessionCount && !startsLate && !endsEarly;
      if (!complete) {
        coverageMessage = `Available bars for the requested ${range} range run from ${firstDate} to ${lastDate}. Return uses this available period.`;
      } else if (warmupLimited) {
        coverageMessage = 'Earlier indicator history is outside the data plan.';
      }
    }
    return {
      symbol, range, interval, results, visibleFrom, visibleTo: visible.at(-1)?.t ?? null,
      availableIntervals: availableIntervals(range),
      availability: { status: visible.length ? 'available' : 'empty',
        ...(visible.length ? {} : { message: 'No eligible trades were returned for this range.' }) },
      coverage: {
        from: results[0]?.t ?? null, to: results.at(-1)?.t ?? null,
        requestedFrom: request.visibleFrom, warmupBars, requestedWarmupBars: WARMUP_BARS,
        warmupLimited: warmupLimited || warmupBars < WARMUP_BARS,
        complete, adjustment: 'split', extendedHours: request.timespan === 'minute' || request.timespan === 'hour',
        ...(coverageMessage ? { message: coverageMessage } : {}),
      },
      source: { name: 'Massive', delayed: result.delayed, realTime: false,
        message: 'Provider historical aggregates; availability depends on the data plan. Split-adjusted, not dividend-adjusted.' },
    };
  };
}

module.exports = { createResearchHistory, historyRequest, availableIntervals, dateInMarket, marketDayStart, researchBar, nextPage, isPlanLimit };
