import { MarketBar } from '../../services/market-history.service';
import { bollinger, defaultInterval, ema, intervalReason, macd, points, researchIntervals, researchRanges, rsi, sessionVwap, sma } from './market-studies';

describe('Research study calculations', () => {
  const bar = (t: number, c: number, v = 100): MarketBar => ({ t, c, o: c, h: c, l: c, v, vw: c, n: 1 });
  it('seeds EMA with a real SMA and leaves warm-up values blank', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([10, 10], 20)).toEqual([null, null]);
  });
  it('computes Wilder RSI against a published worked price sequence and handles flat prices', () => {
    const values = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00];
    const actual = rsi(values);
    expect(actual.slice(0, 14).every(value => value === null)).toBeTrue();
    expect(actual[14]!).toBeCloseTo(70.464135, 5);
    expect(actual[15]!).toBeCloseTo(66.249619, 5);
    expect(rsi(Array(16).fill(10))[15]).toBe(50);
    expect(rsi(Array.from({ length: 16 }, (_, i) => i + 1))[15]).toBe(100);
  });
  it('uses population deviation for Bollinger and real MACD signal warmup', () => {
    const bb = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(bb.middle[4]).toBe(3);
    expect(bb.upper[4]!).toBeCloseTo(3 + 2 * Math.sqrt(2), 10);
    expect(bb.lower[4]!).toBeCloseTo(3 - 2 * Math.sqrt(2), 10);
    const calculated = macd(Array.from({ length: 60 }, (_, i) => i));
    expect(calculated.line[24]).toBeNull();
    expect(calculated.line[25]!).toBeCloseTo(7, 10);
    expect(calculated.signal[32]).toBeNull();
    expect(calculated.signal[33]!).toBeCloseTo(7, 10);
    expect(calculated.histogram[59]!).toBeCloseTo(0, 10);
  });
  it('resets VWAP at New York midnight and never substitutes zero for missing volume', () => {
    const bars = [bar(Date.parse('2026-11-03T04:00:00Z'), 100, 1), bar(Date.parse('2026-11-03T04:30:00Z'), 200, 3), bar(Date.parse('2026-11-03T05:30:00Z'), 10, 5)];
    expect(sessionVwap(bars)).toEqual([100, 175, 10]);
    const missing = { ...bars[1], v: undefined } as unknown as MarketBar;
    expect(sessionVwap([bars[0], missing, bars[2]])).toEqual([100, null, 10]);
  });
  it('calculates on prior bars before clipping the displayed range', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i + 1, i + 1));
    expect(points(bars, sma(bars.map(value => value.c), 20), 25)[0]).toEqual([25, 15.5]);
  });
  it('offers all requested periods without fabricating unsupported fine intervals', () => {
    expect(researchRanges).toEqual(['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'Max']);
    expect(researchIntervals).toEqual(['1m', '5m', '15m', '1h', '1d', '1wk', '1mo']);
    expect(intervalReason('1Y', '1m')).toBeTruthy();
    expect(intervalReason('1D', '1wk')).toBeTruthy();
    expect(intervalReason('3M', '1h')).toBe('');
    expect(defaultInterval('1D')).toBe('5m');
  });
});
