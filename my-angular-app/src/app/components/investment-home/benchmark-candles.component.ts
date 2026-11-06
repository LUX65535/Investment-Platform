import { CurrencyPipe, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { MarketBar, utcDayMonthsBefore } from '../../services/market-history.service';
import { millisecondsPerDay } from './benchmark-data';

interface Session {
  date: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

const plotWidth = 900;
const plotHeight = 250;
const priceTop = 10;
const priceBottom = 171;
const volumeTop = 196;
const volumeBottom = 245;
const inset = 8;
const dateLabel = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const shares = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const shortShares = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function positivePrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function availableSessions(bars: readonly MarketBar[]): Session[] {
  const sessions = new Map<number, Session>();
  const now = Date.now();
  for (const bar of bars) {
    if (!bar || !Number.isSafeInteger(bar.t) || bar.t <= 0 || bar.t > now || !positivePrice(bar.c)) continue;
    const date = Math.floor(bar.t / millisecondsPerDay) * millisecondsPerDay;
    const open = positivePrice(bar.o) ? bar.o : null;
    const high = positivePrice(bar.h) && bar.h >= Math.max(open ?? bar.c, bar.c) ? bar.h : null;
    const low = positivePrice(bar.l) && bar.l <= Math.min(open ?? bar.c, bar.c) ? bar.l : null;
    const volume = typeof bar.v === 'number' && Number.isFinite(bar.v) && bar.v >= 0 ? bar.v : null;
    sessions.set(date, { date, open, high, low, close: bar.c, volume });
  }
  return Array.from(sessions.values()).sort((a, b) => a.date - b.date);
}

function hasCandle(session: Session): session is Session & { open: number; high: number; low: number } {
  return session.open !== null && session.high !== null && session.low !== null;
}

function createPlot(sessions: Session[]) {
  if (!sessions.length) return null;
  const prices = sessions.flatMap(session => hasCandle(session) ? [session.low, session.high] : [session.close]);
  const rawLow = Math.min(...prices);
  const rawHigh = Math.max(...prices);
  const spread = rawHigh - rawLow || rawHigh * .035;
  const padding = spread * (rawHigh === rawLow ? .5 : .05);
  const low = Math.max(0, rawLow - padding);
  const high = rawHigh + padding;
  if (!Number.isFinite(high) || high <= low) return null;
  const targetStep = (high - low) / 4;
  const scale = 10 ** Math.floor(Math.log10(targetStep));
  const priceStep = ([1, 2, 2.5, 5, 10].find(factor => factor * scale >= targetStep) ?? 10) * scale;
  if (priceStep <= 0 || !Number.isFinite(priceStep)) return null;

  const priceY = (value: number) => priceBottom - (value - low) / (high - low) * (priceBottom - priceTop);
  const volumeHigh = Math.max(...sessions.map(session => session.volume ?? 0));
  const step = (plotWidth - inset * 2) / sessions.length;
  const width = Math.min(22, step * .7);
  const firstTick = Math.floor(high / priceStep);
  const lastTick = Math.ceil(low / priceStep);
  const priceTicks = Array.from({ length: firstTick - lastTick + 1 }, (_, index) => {
    const value = (firstTick - index) * priceStep;
    return { value, y: priceY(value) };
  });
  const marks = sessions.map((session, index) => {
    const x = inset + (index + .5) * step;
    const candle = hasCandle(session) ? {
      high: priceY(session.high),
      low: priceY(session.low),
      top: Math.min(priceY(session.open), priceY(session.close)),
      height: Math.max(1.8, Math.abs(priceY(session.close) - priceY(session.open))),
      direction: session.close > session.open ? 'up' : session.close < session.open ? 'down' : 'flat',
    } : null;
    const volume = session.volume !== null && volumeHigh > 0
      ? session.volume / volumeHigh * (volumeBottom - volumeTop)
      : 0;
    return { session, x, candle, closeY: priceY(session.close), volume };
  });
  return {
    width, priceTicks, marks, volumeHigh,
    closeOnly: marks.some(mark => !mark.candle),
    hasVolume: sessions.some(session => session.volume !== null),
    firstDate: sessions[0].date,
    middleDate: sessions.length > 3 ? sessions[Math.floor(sessions.length / 2)].date : null,
    lastDate: sessions.at(-1)!.date,
  };
}

@Component({
  selector: 'app-benchmark-candles',
  standalone: true,
  imports: [CurrencyPipe, DatePipe],
  templateUrl: './benchmark-candles.component.html',
  styleUrl: './benchmark-candles.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BenchmarkCandlesComponent {
  readonly bars = input<readonly MarketBar[]>([]);
  readonly months = signal<1 | 3>(1);
  private readonly selectedDate = signal<number | null>(null);
  private readonly allSessions = computed(() => availableSessions(this.bars()));
  readonly sessions = computed(() => {
    const sessions = this.allSessions();
    const last = sessions.at(-1);
    return last ? sessions.filter(session => session.date >= utcDayMonthsBefore(last.date, this.months())) : [];
  });
  readonly plot = computed(() => createPlot(this.sessions()));
  readonly partialRange = computed(() => {
    const plot = this.plot();
    return plot && plot.firstDate - utcDayMonthsBefore(plot.lastDate, this.months()) > 4 * millisecondsPerDay;
  });
  readonly selectedIndex = computed(() => {
    const sessions = this.sessions();
    const index = sessions.findIndex(session => session.date === this.selectedDate());
    return index >= 0 ? index : sessions.length - 1;
  });
  readonly selected = computed(() => this.sessions()[this.selectedIndex()]);
  readonly selectedValues = computed(() => {
    const session = this.selected();
    if (!session) return [];
    return [
      { label: 'Open', value: session.open },
      { label: 'High', value: session.high },
      { label: 'Low', value: session.low },
      { label: 'Close', value: session.close },
    ];
  });
  readonly selectedDescription = computed(() => {
    const session = this.selected();
    if (!session) return '';
    const prices = this.selectedValues().map(field => field.label + ' ' + (field.value === null ? 'unavailable' : usd.format(field.value)));
    const volume = session.volume === null ? 'Volume unavailable' : 'Volume ' + shares.format(session.volume) + ' shares';
    return [dateLabel.format(session.date), ...prices, volume].join(', ');
  });
  readonly viewBox = '0 0 ' + plotWidth + ' ' + plotHeight;
  readonly plotHeight = plotHeight;
  readonly volumeTop = volumeTop;
  readonly volumeBottom = volumeBottom;

  setRange(months: 1 | 3): void {
    this.months.set(months);
    if (this.selected()?.date !== this.selectedDate()) this.selectedDate.set(null);
  }

  chooseSession(event: PointerEvent): void {
    if (event.type === 'pointermove' && event.pointerType === 'touch') return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!bounds.width) return;
    const x = (event.clientX - bounds.left) / bounds.width * plotWidth;
    const index = Math.floor((x - inset) / (plotWidth - inset * 2) * this.sessions().length);
    this.selectIndex(index);
  }

  navigate(event: KeyboardEvent): void {
    const index = this.selectedIndex();
    const last = this.sessions().length - 1;
    const targets: Record<string, number> = {
      ArrowLeft: index - 1, ArrowDown: index - 1,
      ArrowRight: index + 1, ArrowUp: index + 1,
      PageDown: index - 5, PageUp: index + 5,
      Home: 0, End: last,
    };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    this.selectIndex(targets[event.key]);
  }

  fullVolume(value: number): string {
    return shares.format(value);
  }

  compactVolume(value: number): string {
    return shortShares.format(value);
  }

  private selectIndex(index: number): void {
    const sessions = this.sessions();
    if (!sessions.length) return;
    const last = sessions.length - 1;
    const position = Math.min(last, Math.max(0, index));
    this.selectedDate.set(position === last ? null : sessions[position].date);
  }
}
