import { MarketBar } from '../../services/market-history.service';

export type StudyPoint = [number, number | null];
export const researchRanges = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'Max'] as const;
export const researchIntervals = ['1m', '5m', '15m', '1h', '1d', '1wk', '1mo'] as const;
export type ResearchRange = typeof researchRanges[number];
export type ResearchInterval = typeof researchIntervals[number];
export const intraday = (interval: ResearchInterval) => ['1m', '5m', '15m', '1h'].includes(interval);

export function intervalReason(range: ResearchRange, interval: ResearchInterval): string {
  if (interval === '1m' && !['1D', '5D'].includes(range)) return 'Minute bars are available for 1D and 5D ranges.';
  if (['5m', '15m'].includes(interval) && !['1D', '5D', '1M'].includes(range)) return 'Choose a range of 1M or shorter for this interval.';
  if (interval === '1h' && !['1D', '5D', '1M', '3M'].includes(range)) return 'Choose a range of 3M or shorter for hourly bars.';
  if (['1wk', '1mo'].includes(interval) && ['1D', '5D'].includes(range)) return 'Choose a range of at least 1M for weekly or monthly bars.';
  return '';
}

export function defaultInterval(range: ResearchRange): ResearchInterval {
  return range === '1D' ? '5m' : range === '5D' ? '15m' : ['5Y', 'Max'].includes(range) ? '1wk' : '1d';
}

function periodValid(period: number): boolean { return Number.isInteger(period) && period > 0; }

export function sma(values: number[], period: number): Array<number | null> {
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period];
    return periodValid(period) && index >= period - 1 ? total / period : null;
  });
}

export function ema(values: number[], period: number): Array<number | null> {
  if (!periodValid(period)) return values.map(() => null);
  let previous: number | null = null;
  const seed = sma(values, period);
  const alpha = 2 / (period + 1);
  return values.map((value, index) => {
    if (index < period - 1) return null;
    previous = previous === null ? seed[index]! : value * alpha + previous * (1 - alpha);
    return previous;
  });
}

/** Wilder smoothing, seeded with the first N price changes. */
export function rsi(values: number[], period = 14): Array<number | null> {
  let gain = 0;
  let loss = 0;
  return values.map((value, index) => {
    if (!index || !periodValid(period)) return null;
    const delta = value - values[index - 1];
    if (index <= period) {
      gain += Math.max(0, delta) / period;
      loss += Math.max(0, -delta) / period;
    } else {
      gain = (gain * (period - 1) + Math.max(0, delta)) / period;
      loss = (loss * (period - 1) + Math.max(0, -delta)) / period;
    }
    return index < period ? null : gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  });
}

export function bollinger(values: number[], period = 20, deviations = 2) {
  const middle = sma(values, period);
  const width = middle.map((mean, index) => mean === null ? null : Math.sqrt(values.slice(index - period + 1, index + 1)
    .reduce((sum, value) => sum + (value - mean) ** 2, 0) / period) * deviations);
  return { middle, upper: middle.map((value, index) => value === null ? null : value + width[index]!),
    lower: middle.map((value, index) => value === null ? null : value - width[index]!) };
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = values.map((_, index) => slowEma[index] === null || fastEma[index] === null ? null : fastEma[index]! - slowEma[index]!);
  const offset = line.findIndex(value => value !== null);
  const signal = values.map((): number | null => null);
  if (offset >= 0) ema(line.slice(offset) as number[], signalPeriod).forEach((value, index) => signal[offset + index] = value);
  return { line, signal, histogram: line.map((value, index) => value === null || signal[index] === null ? null : value - signal[index]!) };
}

const sessionDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Resets at each New York calendar session; uses provider bar VWAP, never invents volume. */
export function sessionVwap(bars: MarketBar[]): Array<number | null> {
  let session = '';
  let volume = 0;
  let weighted = 0;
  let complete = true;
  return bars.map(bar => {
    const day = sessionDate.format(new Date(bar.t));
    if (day !== session) { session = day; volume = 0; weighted = 0; complete = true; }
    if (typeof bar.v !== 'number' || !Number.isFinite(bar.v) || bar.v < 0 || (bar.v > 0 && (typeof bar.vw !== 'number' || !Number.isFinite(bar.vw) || bar.vw <= 0))) complete = false;
    if (complete && typeof bar.v === 'number' && bar.v > 0 && typeof bar.vw === 'number') { volume += bar.v; weighted += bar.vw * bar.v; }
    return complete && volume > 0 ? weighted / volume : null;
  });
}

export function points(bars: MarketBar[], values: Array<number | null>, visibleFrom = 0): StudyPoint[] {
  return bars.map((bar, index): StudyPoint => [bar.t, values[index] ?? null]).filter(point => point[0] >= visibleFrom);
}
