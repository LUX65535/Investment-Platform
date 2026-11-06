import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MarketBar, ResearchHistory } from '../../services/market-history.service';
import { ResearchRecentsService } from '../../services/research-recents.service';
import { ChartSelection, MarketResearchChartComponent, defaultStudies } from '../market-research-chart/market-research-chart.component';

@Component({ standalone: true, selector: 'app-research-landing', imports: [CommonModule, RouterLink, MarketResearchChartComponent],
  templateUrl: './research-landing.component.html', styleUrls: ['./research-landing.component.css', './research-landing-sessions.css'] })
export class ResearchLandingComponent {
  readonly recentSymbols = inject(ResearchRecentsService).symbols;
  selection: ChartSelection = { range: '1M', interval: '1d' };
  studies = defaultStudies();
  recentBars: MarketBar[] = [];
  readonly examples = [
    { ticker: 'AAPL', name: 'Apple Inc.', shortName: 'Apple' },
    { ticker: 'MSFT', name: 'Microsoft Corporation', shortName: 'Microsoft' },
    { ticker: 'NVDA', name: 'NVIDIA Corporation', shortName: 'NVIDIA' },
    { ticker: 'AMZN', name: 'Amazon.com, Inc.', shortName: 'Amazon' },
    { ticker: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X Shares', shortName: 'Semiconductor ETF' },
  ];
  instrument = this.examples[0];
  selectInstrument(instrument: typeof this.instrument): void {
    if (this.instrument === instrument) return;
    this.instrument = instrument;
    this.recentBars = [];
  }
  acceptHistory(history: ResearchHistory): void {
    this.recentBars = history.results.filter(bar => bar.t >= history.visibleFrom && (history.visibleTo === null || bar.t <= history.visibleTo)).slice(-5).reverse();
  }
  selectRange(selection: ChartSelection): void { this.selection = selection; this.recentBars = []; }
  formatTime(time: number): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric',
      ...(['1m', '5m', '15m', '1h'].includes(this.selection.interval) ? { hour: '2-digit', minute: '2-digit' } as const : { year: 'numeric' } as const) }).format(time);
  }
}
