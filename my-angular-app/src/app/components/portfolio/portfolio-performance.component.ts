import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { PortfolioPerformancePoint } from '../../services/portfolio.service';

interface ClosingPoint extends PortfolioPerformancePoint {
  time: number;
}

interface PlotPoint extends ClosingPoint {
  x: number;
  navReturn: number | null;
  spyReturn: number | null;
  navY: number | null;
  spyY: number | null;
}

interface Series {
  path: string;
  area: string;
  singles: { x: number; y: number }[];
}

interface PerformanceChart {
  points: PlotPoint[];
  first: PlotPoint;
  last: PlotPoint;
  lastValuation: ClosingPoint;
  compared: boolean;
  nav: Series;
  spy: Series;
  ticks: { value: number; y: number }[];
  gaps: PlotPoint[];
}

const width = 640;
const height = 160;
const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dollarFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const percentFormat = new Intl.NumberFormat('en-US', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 2 });

function validRows(points: readonly PortfolioPerformancePoint[]): ClosingPoint[] {
  const byDate = new Map<string, ClosingPoint>();
  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const time = Date.parse(`${point.date}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== point.date) continue;
    const nav = point.nav !== null && Number.isFinite(point.nav) && point.nav >= 0 ? point.nav : null;
    const spyClose = point.spyClose !== null && Number.isFinite(point.spyClose) && point.spyClose > 0 ? point.spyClose : null;
    byDate.set(point.date, { date: point.date, time, nav, spyClose });
  }
  return [...byDate.values()].sort((a, b) => a.time - b.time);
}

function lineSeries(points: PlotPoint[], axis: 'navY' | 'spyY'): Series {
  const commands: string[] = [];
  const areas: string[] = [];
  const singles: Series['singles'] = [];
  let segment = '';
  let start = '';
  for (const [index, point] of points.entries()) {
    const y = point[axis];
    if (y === null) continue;
    const connected = points[index - 1]?.[axis] != null;
    const x = point.x.toFixed(2);
    const command = `${connected ? 'L' : 'M'}${x} ${y.toFixed(2)}`;
    commands.push(command);
    if (!connected) {
      start = x;
      segment = command;
    } else {
      segment += ` ${command}`;
    }
    if (points[index + 1]?.[axis] == null) {
      if (connected) areas.push(`${segment} L${x} ${height - 16} L${start} ${height - 16} Z`);
      else singles.push({ x: point.x, y });
    }
  }
  return { path: commands.join(' '), area: areas.join(' '), singles };
}

function plotScale(values: number[], compared: boolean): { low: number; high: number; step: number } {
  let low = compared ? Math.min(0, ...values) : Math.min(...values);
  let high = compared ? Math.max(0, ...values) : Math.max(...values);
  if (high === low) {
    const padding = compared ? .01 : Math.max(1, high * .01);
    low = compared ? low - padding : Math.max(0, low - padding);
    high += padding;
  }
  const increment = Math.max(compared ? .0001 : .01, (high - low) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(increment));
  const factor = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= increment) ?? 10;
  const step = factor * magnitude;
  return { low: Math.floor(low / step) * step, high: Math.ceil(high / step) * step, step };
}

function makeChart(rows: ClosingPoint[], allowComparison: boolean): PerformanceChart | null {
  const lastValuation = rows.filter(row => row.nav !== null).at(-1);
  if (!lastValuation) return null;

  const baseline = allowComparison ? rows.find((row): row is ClosingPoint & { nav: number; spyClose: number } =>
    row.nav !== null && row.nav > 0 && row.spyClose !== null) : undefined;
  const compared = baseline !== undefined && rows.some(row => row.time > baseline.time && row.nav !== null && row.spyClose !== null);
  const chartRows = compared ? rows.filter(row => row.time >= baseline.time) : rows;
  const returns = chartRows.map(row => ({
    ...row,
    navReturn: compared && row.nav !== null ? row.nav / baseline.nav - 1 : null,
    spyReturn: compared && row.spyClose !== null ? row.spyClose / baseline.spyClose - 1 : null,
  }));
  const values = returns.flatMap(row => compared ? [row.navReturn, row.spyReturn] : [row.nav])
    .filter((value): value is number => value !== null);
  const { low, high, step } = plotScale(values, compared);
  const y = (value: number) => height - 16 - (value - low) / (high - low) * (height - 28);
  const plotY = (value: number | null) => value === null ? null : y(value);
  const start = chartRows[0].time;
  const duration = chartRows.at(-1)!.time - start;
  const points = returns.map(row => ({
    ...row,
    x: duration ? 8 + (width - 16) * (row.time - start) / duration : width / 2,
    navY: plotY(compared ? row.navReturn : row.nav),
    spyY: plotY(row.spyReturn),
  }));
  const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, index) => {
    const value = Number((low + index * step).toPrecision(10));
    return { value, y: y(value) };
  });

  return {
    points, first: points[0], last: points.at(-1)!, lastValuation, compared,
    nav: lineSeries(points, 'navY'), spy: lineSeries(points, 'spyY'), ticks,
    gaps: points.filter(point => point.navY === null || compared && point.spyY === null),
  };
}

@Component({
  standalone: true,
  selector: 'app-portfolio-performance',
  imports: [CommonModule],
  templateUrl: './portfolio-performance.component.html',
  styleUrls: ['./portfolio-performance.component.css'],
})
export class PortfolioPerformanceComponent {
  readonly width = width;
  readonly height = height;
  chart: PerformanceChart | null = null;
  private comparisonChart: PerformanceChart | null = null;
  private accountValueChart: PerformanceChart | null = null;
  private preferComparison = true;
  pointIndex = 0;
  @Input() loading = false;
  @Input() failed = false;
  @Input() message = '';
  @Input() missingSessions = 0;
  @Input() missingBenchmarkSessions = 0;
  @Output() retry = new EventEmitter<void>();

  @Input() set points(value: readonly PortfolioPerformancePoint[]) {
    const rows = validRows(value);
    const chart = makeChart(rows, true);
    this.comparisonChart = chart?.compared ? chart : null;
    this.accountValueChart = this.comparisonChart ? makeChart(rows, false) : chart;
    this.chart = (this.preferComparison ? this.comparisonChart : null) ?? this.accountValueChart;
    this.pointIndex = this.chart ? this.chart.points.length - 1 : 0;
  }

  get canCompare(): boolean {
    return this.comparisonChart !== null;
  }

  get selectedPoint(): PlotPoint | undefined {
    return this.chart?.points[this.pointIndex];
  }

  get selectedDescription(): string {
    const point = this.selectedPoint;
    if (!point) return '';
    const amount = point.nav === null ? 'unavailable' : dollarFormat.format(point.nav);
    const dateAndAmount = `${dateFormat.format(point.time)}, account value ${amount}`;
    if (!this.chart?.compared) return dateAndAmount;
    const navReturn = point.navReturn === null ? 'unavailable' : this.returnLabel(point.navReturn);
    const spyReturn = point.spyReturn === null ? 'unavailable' : this.returnLabel(point.spyReturn);
    return `${dateAndAmount}, portfolio return ${navReturn}, SPY return ${spyReturn}`;
  }

  selectChart(compared: boolean): void {
    const nextChart = compared ? this.comparisonChart : this.accountValueChart;
    if (!nextChart || this.chart === nextChart) return;
    const selectedDate = this.selectedPoint?.date;
    this.preferComparison = compared;
    this.chart = nextChart;
    this.pointIndex = Math.max(0, nextChart.points.findIndex(point => point.date === selectedDate));
  }

  retryHistory(heading: HTMLHeadingElement, event: Event): void {
    if (heading.ownerDocument.activeElement === event.currentTarget) heading.focus({ preventScroll: true });
    this.retry.emit();
  }

  returnLabel(value: number | null): string {
    return value === null ? '—' : percentFormat.format(value);
  }

  inspectPoint(event: Event): void {
    this.pointIndex = (event.target as HTMLInputElement).valueAsNumber;
  }

  inspectPointer(event: PointerEvent): void {
    const points = this.chart?.points;
    if (!points?.length) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * width;
    const next = points.findIndex(point => point.x >= x);
    if (next < 0) this.pointIndex = points.length - 1;
    else if (next === 0) this.pointIndex = 0;
    else this.pointIndex = x - points[next - 1].x <= points[next].x - x ? next - 1 : next;
  }
}
