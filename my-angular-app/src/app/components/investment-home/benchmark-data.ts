import { MarketBar } from '../../services/market-history.service';

export const millisecondsPerDay = 86_400_000;

export interface BenchmarkClose {
  date: number;
  close: number;
  change: number | null;
}

export function distinctDailyCloses(bars: MarketBar[]): MarketBar[] {
  const byDay = new Map<number, MarketBar>();
  for (const bar of bars) {
    if (Number.isSafeInteger(bar.t) && bar.t > 0 && Number.isFinite(new Date(bar.t).getTime())) {
      byDay.set(Math.floor(bar.t / millisecondsPerDay), bar);
    }
  }
  return Array.from(byDay.values());
}

export function priceReturn(latest: MarketBar, start?: MarketBar): number | null {
  if (!start) return null;
  const change = (latest.c / start.c - 1) * 100;
  return Number.isFinite(change) ? change : null;
}

export function describeClose(bar: MarketBar, previous?: MarketBar): BenchmarkClose {
  return { date: bar.t, close: bar.c, change: priceReturn(bar, previous) };
}
