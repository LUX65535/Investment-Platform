import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, DestroyRef, ElementRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MarketResearchChartComponent } from '../market-research-chart/market-research-chart.component';



import { distinctUntilChanged, map, Subject, switchMap } from 'rxjs';

import { MarketQuoteService, quoteRefreshMs } from '../../services/market-quote.service';
import { activeRefreshes } from '../../services/market-refresh';

interface Quote {
  c: number;
  d: number | null;
  dp: number | null;
  t: number;
}

const defaultTicker = 'AAPL';
const tickerPattern = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/;
const quoteTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/New_York',
  timeZoneName: 'short',
});

@Component({
  selector: 'app-research-embed',
  standalone: true,
  imports: [CommonModule, FormsModule, MarketResearchChartComponent],
  templateUrl: './research-embed.component.html',
  styleUrls: ['./research-embed.component.css'],
})
export class ResearchEmbedComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly marketQuotes = inject(MarketQuoteService);
  private readonly quoteRequests = new Subject<{ symbol: string; refresh: boolean }>();
  private embeddedVisible = true;


  readonly exampleTickers = ['AAPL', 'MSFT', 'NVDA'];
  ticker = defaultTicker;
  tickerInput = defaultTicker;
  inputError = '';
  quote: Quote | null = null;
  quoteLoading = true;
  quoteFailed = false;
  quotePrevious = false;

  get quoteTime(): string {
    return this.quote ? quoteTimeFormat.format(this.quote.t * 1000) : '';
  }

  get quoteIsoTime(): string | null {
    return this.quote ? new Date(this.quote.t * 1000).toISOString() : null;
  }

  ngOnInit(): void {
    this.quoteRequests.pipe(
      switchMap(({ symbol, refresh }) => this.marketQuotes.read(symbol, refresh)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ quote, previous }) => {
      this.quote = quote ? { ...quote, d: Number.isFinite(quote.d) ? quote.d : null,
        dp: Number.isFinite(quote.dp) ? quote.dp : null } : null;
      this.quoteLoading = false;
      this.quoteFailed = !quote;
      this.quotePrevious = previous;
    });

    this.route.queryParamMap.pipe(
      map(params => params.get('ticker')?.trim().toUpperCase() || defaultTicker),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(symbol => {
      this.inputError = '';
      if (!tickerPattern.test(symbol)) {
        this.inputError = 'This link has an invalid U.S. ticker. Showing AAPL.';
        symbol = defaultTicker;
      }
      this.tickerInput = symbol;
      this.load(symbol);
    });

    const browser = this.document.defaultView;
    if (browser && browser !== browser.top && typeof IntersectionObserver !== 'undefined') {
      this.embeddedVisible = false;
      const observer = new IntersectionObserver(entries => this.embeddedVisible = Boolean(entries[0]?.isIntersecting));
      observer.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    }
    activeRefreshes(this.document, quoteRefreshMs).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.embeddedVisible) this.retryQuote(false);
    });

  }

  selectTicker(value: string): void {
    const symbol = value.trim().toUpperCase();
    if (!tickerPattern.test(symbol)) {
      this.inputError = 'Enter a U.S. stock symbol, such as AAPL or BRK.B.';
      return;
    }

    this.inputError = '';
    this.tickerInput = symbol;
    const linkedSymbol = this.route.snapshot.queryParamMap.get('ticker')?.trim().toUpperCase() || defaultTicker;
    if (symbol !== linkedSymbol) {
      void this.router.navigate([], { relativeTo: this.route, queryParams: { ticker: symbol } });
    } else this.retryQuote();
  }

  retryQuote(refresh = true): void {
    if (this.quoteLoading || this.document.hidden || this.document.defaultView?.navigator.onLine === false) return;
    this.quoteLoading = true;
    this.quoteRequests.next({ symbol: this.ticker, refresh });
  }

  private load(symbol: string): void {
    if (this.ticker !== symbol) {
      this.quote = null;
    }
    this.ticker = symbol;
    this.quoteFailed = false;
    this.quotePrevious = false;
    this.quoteLoading = true;
    this.quoteRequests.next({ symbol, refresh: true });

  }
}
