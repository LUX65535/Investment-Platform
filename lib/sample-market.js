const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const anchor = Date.UTC(2025, 0, 1);
const newYorkOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' });

const companies = {
  AAPL: { name: 'Apple Inc.', industry: 'Consumer technology', base: 190, growth: .13, volume: 50_000_000, seed: 17 },
  MSFT: { name: 'Microsoft Corporation', industry: 'Software', base: 415, growth: .16, volume: 24_000_000, seed: 31 },
  NVDA: { name: 'NVIDIA Corporation', industry: 'Semiconductors', base: 129, growth: .25, volume: 150_000_000, seed: 47 },
  AMZN: { name: 'Amazon.com, Inc.', industry: 'Retail and cloud services', base: 215, growth: .11, volume: 36_000_000, seed: 59 },
  SPY: { name: 'SPDR S&P 500 ETF Trust', industry: 'Broad-market ETF', base: 577, growth: .09, volume: 66_000_000, seed: 73, fund: true },
};

const briefs = [
  ['pullback', 'Reading a price pullback', 'Use a short decline in the sample chart to compare the recent trend with the previous close.'],
  ['volume', 'Interpreting a change in trading volume', 'Compare volume bars across sample sessions and see how a larger bar changes the context of a price move.'],
  ['benchmark', 'Putting a stock move in market context', 'Compare price returns from a shared starting date. A gain can still trail the benchmark over the same window.'],
  ['order', 'Planning a simulated order', 'Review the sample quote, choose a share quantity, and check how a practice order changes the paper wallet.'],
];

const startOfDay = time => Math.floor(time / day) * day;
const dayNumber = date => (date - anchor) / day;
const toCents = price => Math.round(price * 100) / 100;
const dateLabel = time => new Date(time).toISOString().slice(0, 10);

function isWeekday(date) {
  const weekday = new Date(date).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

function previousWeekday(date) {
  do date -= day; while (!isWeekday(date));
  return date;
}

function variation(index, seed) {
  const mixed = Math.imul(index + 11, 0x45d9f3b) ^ Math.imul(seed, 0x119de1f3);
  return (Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b) >>> 0) / 0x100000000;
}

function dailyClose(company, date) {
  const index = dayNumber(date);
  const years = Math.max(-8, Math.min(8, index / 365));
  const broadTrend = .055 * Math.sin(index / 41) + .018 * Math.cos(index / 13);
  const scale = company.fund ? .36 : 1;
  const companyTrend = scale * (.049 * Math.sin(index / 29 + company.seed) + .021 * (variation(index, company.seed) - .5));
  return toCents(company.base * Math.exp(company.growth * years + broadTrend + companyTrend));
}

function sessionHours(date) {
  const zone = newYorkOffset.formatToParts(date + 12 * hour).find(part => part.type === 'timeZoneName').value;
  const offset = Number(zone.slice(3));
  // These are simulated weekday sessions. Holidays and abbreviated sessions are outside the demo calendar.
  return { open: date + (9.5 - offset) * hour, close: date + (16 - offset) * hour };
}

function sessionBars(company, date, session) {
  const index = dayNumber(date);
  const previousClose = dailyClose(company, previousWeekday(date));
  const target = dailyClose(company, date);
  const opening = toCents(previousClose * (1 + (variation(index, company.seed + 1) - .5) * .013));
  const bars = [];
  let open = opening;

  for (let time = session.open, slot = 0; time < session.close; time += hour, slot++) {
    const end = Math.min(time + hour, session.close);
    const progress = (end - session.open) / (session.close - session.open);
    const noise = (variation(index * 8 + slot, company.seed + 2) - .5) * .013;
    const close = toCents(opening + (target - opening) * progress + target * noise * Math.sin(Math.PI * progress));
    const wick = .0008 + .0034 * variation(index * 8 + slot, company.seed + 3);
    const high = toCents(Math.max(open, close) * (1 + wick));
    const low = toCents(Math.min(open, close) * (1 - wick));
    const volume = Math.round(company.volume * (end - time) / (session.close - session.open)
      * (.66 + .68 * variation(index * 8 + slot, company.seed + 4)));
    bars.push({ o: open, h: high, l: low, c: close, v: volume, vw: toCents((open + high + low + close) / 4),
      n: Math.round(volume / 85), t: time });
    open = close;
  }
  return { bars, previousClose };
}

function aggregateDay(bars, date) {
  const volume = bars.reduce((total, bar) => total + bar.v, 0);
  return {
    o: bars[0].o, h: Math.max(...bars.map(bar => bar.h)), l: Math.min(...bars.map(bar => bar.l)), c: bars.at(-1).c,
    v: volume, vw: toCents(bars.reduce((total, bar) => total + bar.v * bar.vw, 0) / volume),
    n: bars.reduce((total, bar) => total + bar.n, 0), t: date,
  };
}

function chartData(ticker, timespan, from, to, now) {
  const company = Object.hasOwn(companies, ticker) ? companies[ticker] : null;
  const results = [];
  if (company) {
    for (let date = Date.parse(from); date <= Math.min(Date.parse(to), startOfDay(now)); date += day) {
      if (!isWeekday(date)) continue;
      const session = sessionHours(date);
      if (now < (timespan === 'day' ? session.close : session.open + hour)) continue;
      const { bars } = sessionBars(company, date, session);
      if (timespan === 'day') results.push(aggregateDay(bars, date));
      else results.push(...bars.filter(bar => Math.min(bar.t + hour, session.close) <= now));
    }
  }
  return { ticker, adjusted: true, resultsCount: results.length, results };
}

function quote(company, now) {
  let date = startOfDay(now);
  if (!isWeekday(date) || now < sessionHours(date).open) date = previousWeekday(date);
  const session = sessionHours(date);
  const { bars, previousClose } = sessionBars(company, date, session);
  const completed = bars.filter(bar => Math.min(bar.t + hour, session.close) <= now);
  const open = bars[0].o;
  const current = completed.at(-1)?.c ?? open;
  const change = toCents(current - previousClose);
  return {
    c: current, d: change, dp: toCents(change / previousClose * 100), o: open, pc: previousClose,
    h: Math.max(open, ...completed.map(bar => bar.h)), l: Math.min(open, ...completed.map(bar => bar.l)),
    // The time identifies when this simulated snapshot was generated, not a live trade.
    t: Math.floor(now / minute) * 60,
  };
}

function search(query) {
  const term = query.toUpperCase();
  const result = Object.entries(companies).filter(([ticker, company]) => ticker.includes(term) || company.name.toUpperCase().includes(term))
    .map(([ticker, company]) => ({ displaySymbol: ticker, symbol: ticker, description: company.name, type: company.fund ? 'ETF' : 'Common Stock' }));
  return { count: result.length, result };
}

function profile(ticker, company) {
  return {
    name: company.name, ticker, currency: 'USD', country: 'US', exchange: 'US sample market',
    finnhubIndustry: company.industry, ipo: '', logo: '', phone: '', weburl: '',
  };
}

function news(ticker, now) {
  return briefs.map(([slug, headline, summary], index) => ({
    id: `${ticker}-${slug}`, sample: true, headline: `${ticker} sample brief: ${headline}`, summary,
    source: 'Demo research notes', datetime: Math.floor((startOfDay(now) - index * day) / 1000), image: '', url: '',
  }));
}

function monthlyInsights(ticker, company, now, recommendations) {
  const date = new Date(now);
  return Array.from({ length: 6 }, (_, index) => {
    const time = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index - 1, 1));
    const month = time.getUTCMonth() + 1;
    const year = time.getUTCFullYear();
    const mix = variation(year * 12 + month, company.seed);
    return recommendations
      ? { symbol: ticker, period: dateLabel(time), strongBuy: Math.round(6 + 6 * mix), buy: Math.round(10 - 3 * mix),
        hold: Math.round(4 + 6 * mix), sell: Math.round(3 - 2 * mix), strongSell: 1 }
      : { symbol: ticker, month, year, change: Math.round(12_000 * (mix - .5)), mspr: toCents(40 * (mix - .5)) };
  });
}

function earnings(ticker, company, now) {
  const date = new Date(now);
  const startOfQuarter = Math.floor(date.getUTCMonth() / 3) * 3;
  return Array.from({ length: 4 }, (_, index) => {
    const period = Date.UTC(date.getUTCFullYear(), startOfQuarter - 3 * index, 0);
    const estimate = toCents(1 + company.seed / 50 + .6 * variation(dayNumber(period), company.seed));
    const actual = toCents(estimate + .5 * (variation(dayNumber(period), company.seed + 1) - .5));
    return { symbol: ticker, period: dateLabel(period), estimate, actual, surprise: toCents(actual - estimate) };
  });
}

function sampleMarket(endpoint, params, now = Date.now()) {
  const chart = /^\/aggs\/ticker\/([^/]+)\/range\/1\/(day|hour)\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(endpoint);
  if (chart) return chartData(decodeURIComponent(chart[1]), chart[2], chart[3], chart[4], now);
  const ticker = params.symbol;
  const company = Object.hasOwn(companies, ticker) ? companies[ticker] : null;
  const hasCompanyInsights = company && !company.fund;
  switch (endpoint) {
    case '/search': return search(params.q);
    case '/quote': return company ? quote(company, now) : { c: 0, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, t: 0 };
    case '/stock/profile2': return company ? profile(ticker, company) : {};
    case '/stock/peers': return company ? Object.keys(companies).filter(symbol => symbol !== ticker) : [];
    case '/company-news': return company ? news(ticker, now) : [];
    case '/stock/recommendation': return hasCompanyInsights ? monthlyInsights(ticker, company, now, true) : [];
    case '/stock/insider-sentiment': return { symbol: ticker, data: hasCompanyInsights ? monthlyInsights(ticker, company, now, false) : [] };
    case '/stock/earnings': return hasCompanyInsights ? earnings(ticker, company, now) : [];
    default: throw new Error('Unsupported sample market endpoint');
  }
}

module.exports = sampleMarket;
