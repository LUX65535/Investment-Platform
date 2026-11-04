const { hasPublishedSchedule, isScheduledEquitySession, marketDate } = require('./portfolio-equity-history');

const dayMs = 86_400_000;
const maxAgeDays = 8;
const olderSessionTtlMs = 5 * 60_000;
const partialTtlMs = 60_000;

function candidateSessions(now) {
  const today = marketDate(now);
  const midnight = Date.parse(today);
  const candidates = [];
  for (let age = 1; age <= maxAgeDays && candidates.length < 4; age++) {
    const date = new Date(midnight - age * dayMs);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const session = date.toISOString().slice(0, 10);
    if (!hasPublishedSchedule(session) || isScheduledEquitySession(session)) candidates.push(session);
  }
  return candidates;
}

function parseSession(data, session) {
  if (data?.status !== 'OK' || (data.adjusted !== undefined && data.adjusted !== true)) {
    throw new Error('Unexpected market summary status');
  }
  if (data.resultsCount === 0 && (data.results === undefined || data.results?.length === 0)) return null;
  if (!Array.isArray(data.results) || !data.results.length || data.resultsCount !== data.results.length) {
    throw new Error('Unexpected market summary rows');
  }

  const records = new Map();
  const timestamps = new Map();
  for (const bar of data.results) {
    if (typeof bar?.T !== 'string' || !/^[A-Z0-9][A-Z0-9._/-]{0,31}$/i.test(bar.T)
      || bar.otc === true || !Number.isFinite(bar.c) || bar.c <= 0) continue;
    if (Number.isFinite(bar.t) && !timestamps.has(bar.t)) {
      const date = new Date(bar.t);
      timestamps.set(bar.t, Number.isFinite(date.getTime()) ? marketDate(bar.t) : '');
    }
    if (timestamps.get(bar.t) !== session) continue;
    const volume = Number.isFinite(bar.v) && bar.v >= 0 ? bar.v : null;
    records.set(bar.T.toUpperCase(), { symbol: bar.T, close: bar.c, volume });
  }
  if (!records.size) throw new Error('No verifiable closes in market summary');
  return { date: session, records, reported: data.resultsCount };
}

function composeSnapshot(latest, previous, newestCandidate) {
  let comparable = 0;
  const rows = Array.from(latest.records, ([ticker, record]) => {
    const previousClose = previous?.records.get(ticker)?.close;
    const change = previousClose ? (record.close / previousClose - 1) * 100 : null;
    const validChange = Number.isFinite(change) ? change : null;
    if (validChange !== null) comparable++;
    return { ...record, change: validChange };
  });
  return {
    session: latest.date,
    previousSession: previous?.date ?? null,
    previousUnavailable: !previous,
    stale: latest.date !== newestCandidate,
    coverage: { reported: latest.reported, screened: rows.length, comparable },
    rows,
  };
}

function createMarketScreener(readSession, now = Date.now) {
  let cached;
  let lastGood;
  let inFlight;
  let retryAt = 0;
  let lastError;

  async function load(candidates, marketDay) {
    let latest;
    const newestCandidate = candidates[0];
    for (const date of candidates) {
      try {
        const session = parseSession(await readSession(date, marketDay), date);
        if (!session) {
          if (latest) return composeSnapshot(latest, null, newestCandidate);
          continue;
        }
        if (latest) return composeSnapshot(latest, session, newestCandidate);
        latest = session;
      } catch (error) {
        if (!latest) throw error;
        return composeSnapshot(latest, null, newestCandidate);
      }
    }
    if (latest) return composeSnapshot(latest, null, newestCandidate);
    throw Object.assign(new Error('No recent market sessions available'), { status: 503 });
  }

  async function read() {
    const time = now();
    const date = marketDate(time);
    if (cached?.date === date && cached.expires > time) return cached.snapshot;
    if (inFlight) return inFlight;
    if (retryAt > time) {
      if (lastGood && Date.parse(lastGood.session) >= time - maxAgeDays * dayMs) return { ...lastGood, stale: true };
      throw lastError;
    }

    const candidates = candidateSessions(time);
    inFlight = load(candidates, date).then(snapshot => {
      lastGood = snapshot;
      const ttl = snapshot.previousUnavailable ? partialTtlMs
        : snapshot.session === candidates[0] ? Infinity
        : olderSessionTtlMs;
      cached = {
        date,
        expires: now() + ttl,
        snapshot,
      };
      return snapshot;
    }).catch(error => {
      lastError = error;
      retryAt = Math.max(error.retryAt || 0, now() + partialTtlMs);
      if (lastGood && Date.parse(lastGood.session) >= now() - maxAgeDays * dayMs) return { ...lastGood, stale: true };
      throw error;
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return { read };
}

function describeMarketOverview(snapshot) {
  const breadth = { up: 0, down: 0, unchanged: 0 };
  const bySymbol = new Map();
  for (const row of snapshot.rows) {
    bySymbol.set(row.symbol.toUpperCase(), row);
    if (row.change === null) continue;
    if (row.change > 0) breadth.up++;
    else if (row.change < 0) breadth.down++;
    else breadth.unchanged++;
  }

  const benchmarks = ['SPY', 'QQQ', 'IWM']
    .map(symbol => bySymbol.get(symbol))
    .filter(Boolean);
  const sectors = ['XLC', 'XLY', 'XLP', 'XLE', 'XLF', 'XLV', 'XLI', 'XLB', 'XLRE', 'XLK', 'XLU']
    .map(symbol => ({ symbol, change: bySymbol.get(symbol)?.change ?? null }));
  const active = snapshot.rows.filter(row => row.volume > 0)
    .sort((a, b) => b.volume - a.volume || a.symbol.localeCompare(b.symbol))
    .slice(0, 4);
  return {
    session: snapshot.session,
    previousSession: snapshot.previousSession,
    stale: snapshot.stale,
    screened: snapshot.coverage.screened,
    comparable: snapshot.coverage.comparable,
    ...breadth,
    benchmarks,
    sectors,
    active,
  };
}

module.exports = { createMarketScreener, describeMarketOverview };
