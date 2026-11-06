/* Browser acceptance harness only. Never imported by app.js or a deployment. */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const { dateInMarket } = require('../lib/research-history');

if (process.env.VERCEL === '1') throw new Error('The fixture server must never run in a deployment.');
Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'preview', API_KEY: 'fixture-only',
  API_POLY_KEY: 'fixture-only', MONGO_URI: '', MONGO_DB_NAME: '' });

const DAY = 86_400_000;
const scenarios = ['normal', 'not-found', 'plan-limit', 'rate-limit', 'temporary-unavailable', 'empty', 'missing-volume'];
let scenario = 'normal';
let backend;
let providerCalls = 0;
const names = { SOXL: 'Direxion Daily Semiconductor Bull 3X Shares', AAPL: 'Apple Inc.',
  SPY: 'SPDR S&P 500 ETF Trust', MSFT: 'Microsoft Corporation', NVDA: 'NVIDIA Corporation' };

function profile(symbol) {
  return { ticker: symbol, name: names[symbol] || `${symbol} Fixture Security`, currency: 'USD',
    exchange: 'NASDAQ', country: 'US', ipo: '2010-03-11', logo: '', weburl: '',
    marketCapitalization: 100000, shareOutstanding: 1000, finnhubIndustry: 'Technology' };
}

function providerError(status) {
  return Object.assign(new Error('Fixture provider response'), { response: { status, headers: { 'retry-after': status === 429 ? '8' : '2' } } });
}

function fixtureBars(symbol, multiplier, timespan, from, to) {
  const start = /^\d{4}-/.test(from) ? Date.parse(from) : Number(from);
  const finish = Math.min(Date.now(), (/^\d{4}-/.test(to) ? Date.parse(to) + DAY : Number(to)));
  const base = symbol === 'SOXL' ? 38 : symbol === 'SPY' ? 520 : 185;
  const result = [];
  const minutes = timespan === 'minute' ? multiplier : timespan === 'hour' ? multiplier * 60 : 0;
  const add = timestamp => {
    const day = timestamp / DAY;
    const index = timestamp / 60_000;
    const close = Number((base + Math.sin(day / 18) * base * .065 + Math.sin(index / 37) * base * .008
      + (day - 19000) * base * .00004).toFixed(3));
    const open = Number((close + Math.cos(index / 29) * base * .003).toFixed(3));
    const spread = base * .004;
    const bar = { t: timestamp, o: open, h: Number((Math.max(open, close) + spread).toFixed(3)),
      l: Number((Math.min(open, close) - spread).toFixed(3)), c: close };
    if (scenario !== 'missing-volume') {
      bar.v = Math.round(15000 + (Math.sin(index) + 1) * 35000) + .5;
      bar.vw = Number(((open + close) / 2).toFixed(3));
      bar.n = 300;
    }
    result.push(bar);
  };
  for (let day = Math.floor(start / DAY) * DAY; day <= finish; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    // Known deterministic weekday fixture sessions, not an exchange calendar.
    if (timespan === 'week' && weekday !== 1) continue;
    if (timespan === 'month' && new Date(day).getUTCDate() > 3) continue;
    if (timespan === 'month' && result.length
      && new Date(result.at(-1).t).getUTCMonth() === new Date(day).getUTCMonth()) continue;
    if (minutes) {
      for (let minute = 14 * 60 + 30; minute < 21 * 60; minute += minutes) {
        const timestamp = day + minute * 60000;
        if (timestamp <= finish) add(timestamp);
      }
    } else if (day + 5 * 3600000 <= finish) add(day + 5 * 3600000);
  }
  return result;
}

axios.get = async (url, { params = {} } = {}) => {
  providerCalls++;
  const parsed = new URL(url);
  const aggregate = parsed.pathname.match(/^\/v2\/aggs\/ticker\/([^/]+)\/range\/(\d+)\/(minute|hour|day|week|month)\/([^/]+)\/([^/]+)$/);
  const reference = parsed.pathname.match(/^\/v3\/reference\/tickers\/([^/]+)$/);
  const symbol = params.symbol || (aggregate && decodeURIComponent(aggregate[1])) || (reference && decodeURIComponent(reference[1]));
  if (symbol === 'NOTFOUND' || scenario === 'not-found') {
    if (parsed.pathname.endsWith('/stock/profile2')) return { data: {} };
    throw providerError(404);
  }
  if (aggregate) {
    if (scenario === 'plan-limit') throw providerError(403);
    if (scenario === 'rate-limit') throw providerError(429);
    if (scenario === 'temporary-unavailable') throw providerError(503);
    const results = scenario === 'empty' ? [] : fixtureBars(symbol, Number(aggregate[2]), aggregate[3], aggregate[4], aggregate[5]);
    return { data: { status: 'DELAYED', ticker: symbol, adjusted: params.adjusted !== false, results, resultsCount: results.length } };
  }
  if (reference) return { data: { status: 'OK', results: { ticker: symbol, name: profile(symbol).name,
    currency_name: 'usd', type: symbol === 'SOXL' || symbol === 'SPY' ? 'ETF' : 'CS', primary_exchange: 'ARCX', locale: 'us', active: true } } };
  if (parsed.pathname.endsWith('/stock/profile2')) return { data: symbol === 'SOXL' ? {} : profile(symbol) };
  if (parsed.pathname.endsWith('/quote')) {
    const c = symbol === 'SOXL' ? 42.35 : symbol === 'SPY' ? 542.36 : 197.45;
    return { data: { c, d: 1.25, dp: .64, h: c + 2, l: c - 3, o: c - 1, pc: c - 1.25, t: Math.floor(Date.now() / 1000) } };
  }
  if (parsed.pathname.endsWith('/search')) {
    const result = Object.keys(names).filter(key => `${key} ${names[key]}`.toLowerCase().includes(String(params.q).toLowerCase()))
      .map(key => ({ description: names[key], displaySymbol: key, symbol: key, type: key === 'SOXL' ? 'ETP' : 'Common Stock' }));
    return { data: { count: result.length, result } };
  }
  if (parsed.pathname.includes('/aggs/grouped/')) return { data: { status: 'OK', resultsCount: 0, results: [] } };
  if (parsed.pathname.endsWith('/stock/insider-sentiment')) return { data: { symbol, data: [] } };
  if (['/stock/recommendation', '/stock/earnings', '/company-news', '/stock/peers'].some(endpoint => parsed.pathname.endsWith(endpoint))) return { data: [] };
  throw new Error('Unexpected outbound request in fixture server');
};

function resetBackend() {
  const before = new Set(process.listeners('SIGINT'));
  delete require.cache[require.resolve('../app')];
  backend = require('../app');
  for (const listener of process.listeners('SIGINT')) if (!before.has(listener)) process.removeListener('SIGINT', listener);
  providerCalls = 0;
}
resetBackend();

const server = express();
server.use(express.json());
server.get('/__fixture/status', (req, res) => res.json({ fixture: true, scenario, providerCalls, scenarios, date: dateInMarket(Date.now()) }));
server.post('/__fixture/scenario', (req, res) => {
  if (!scenarios.includes(req.body?.scenario)) return res.status(400).json({ error: 'Unknown fixture scenario', scenarios });
  scenario = req.body.scenario;
  resetBackend();
  return res.json({ fixture: true, scenario });
});
const browserFiles = path.join(__dirname, '../my-angular-app/dist/my-angular-app/browser');
server.get(['/', '/research-embed', '/search-details/:symbol?', '/screener', '/watchlist', '/portfolio'], (req, res) => {
  const index = path.join(browserFiles, 'index.html');
  if (!fs.existsSync(index)) return res.status(503).send('Build the Angular app before using this fixture server.');
  const controls = `<aside id="fixture-controls" style="position:fixed;z-index:2147483647;bottom:0;left:0;right:0;padding:7px 12px;background:#fff3bc;color:#4c3a00;border-top:2px solid #bc7c00;font:12px system-ui;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong>TEST FIXTURE · NOT LIVE MARKET DATA</strong><label>Scenario <select id="fixture-scenario">${scenarios.map(name => `<option${name === scenario ? ' selected' : ''}>${name}</option>`).join('')}</select></label><button id="fixture-apply" type="button">Apply + reload</button><button id="fixture-recover" type="button">Restore provider (then Retry)</button><span id="fixture-state">${scenario}</span></aside><script>document.getElementById('fixture-apply').onclick=async()=>{await fetch('/__fixture/scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:document.getElementById('fixture-scenario').value})});location.reload()};document.getElementById('fixture-recover').onclick=async()=>{await fetch('/__fixture/scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:'normal'})});document.getElementById('fixture-scenario').value='normal';document.getElementById('fixture-state').textContent='Provider restored; use chart Retry'};</script>`;
  res.set('Cache-Control', 'no-store').type('html').send(fs.readFileSync(index, 'utf8').replace('</body>', `${controls}</body>`));
});
server.use((req, res, next) => backend(req, res, next));
const port = Number(process.env.FIXTURE_PORT || 3108);
server.listen(port, '127.0.0.1', () => console.log(`TEST FIXTURE · NOT LIVE MARKET DATA · http://127.0.0.1:${port}/research-embed?ticker=SOXL`));
