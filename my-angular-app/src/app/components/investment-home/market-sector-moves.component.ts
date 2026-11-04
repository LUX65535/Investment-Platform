import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

export interface SectorMove {
  symbol: string;
  change: number | null;
}

const sectorNames = new Map([
  ['XLC', 'Communication services'], ['XLY', 'Consumer discretionary'], ['XLP', 'Consumer staples'],
  ['XLE', 'Energy'], ['XLF', 'Financials'], ['XLV', 'Health care'], ['XLI', 'Industrials'],
  ['XLB', 'Materials'], ['XLRE', 'Real estate'], ['XLK', 'Technology'], ['XLU', 'Utilities'],
]);

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent', signDisplay: 'always', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

function describeExtreme(ordered: { label: string; symbol: string; change: number }[], extreme: number, startsSentence: boolean) {
  const tied = ordered.filter(row => row.change === extreme);
  const names = tied.map(row => row.label === row.symbol ? row.label : row.label.toLowerCase());
  const subject = names.length <= 2
    ? names.join(' and ')
    : names[0] + ' and ' + (names.length - 1) + ' other sectors';
  const direction = extreme > 0 ? 'gain' : 'decline';
  const verb = tied.length > 1 ? 'tied for the largest ' + direction : extreme > 0 ? 'led gains' : 'fell the most';
  const movement = Math.abs(extreme) < .005
    ? '(' + (extreme > 0 ? 'up' : 'down') + ' less than 0.01%)'
    : '(' + percent.format(extreme / 100).replace(/^-/, '−') + ')';
  return {
    label: startsSentence ? subject.charAt(0).toUpperCase() + subject.slice(1) : subject,
    verb,
    movement,
  };
}

@Component({
  selector: 'app-market-sector-moves',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink],
  templateUrl: './market-sector-moves.component.html',
  styleUrl: './market-sector-moves.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarketSectorMovesComponent {
  readonly rows = input.required<readonly SectorMove[]>();
  readonly session = input.required<string>();
  readonly ordered = computed(() => {
    const rows = this.rows().map(row => ({
      ...row,
      change: row.change !== null && Number.isFinite(row.change) ? row.change : null,
    }));
    const scale = Math.max(0, ...rows.map(row => Math.abs(row.change ?? 0)));
    return rows
      .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity) || a.symbol.localeCompare(b.symbol))
      .map(row => ({
        ...row,
        label: sectorNames.get(row.symbol) ?? row.symbol,
        width: scale ? Math.abs(row.change ?? 0) / scale * 50 : 0,
      }));
  });

  readonly reading = computed(() => {
    const rows = this.ordered();
    const reported = rows.filter((row): row is typeof row & { change: number } => row.change !== null);
    const first = reported[0]?.change ?? 0;
    const last = reported.at(-1)?.change ?? 0;
    const partial = reported.length < rows.length;
    return {
      gain: first > 0 ? describeExtreme(reported, first, !partial) : null,
      loss: last < 0 ? describeExtreme(reported, last, !partial && first <= 0) : null,
      partial,
      reportedCount: reported.length,
      total: rows.length,
    };
  });
}
