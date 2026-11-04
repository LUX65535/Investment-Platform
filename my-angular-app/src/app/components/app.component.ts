import { ViewportScroller } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, Scroll } from '@angular/router';
import { filter } from 'rxjs';
import { StockService } from '../services/stock.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})


export class AppComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private lastWorkspacePath = '';

  @ViewChild('workspace', { static: true }) private workspace!: ElementRef<HTMLElement>;

  constructor(
    private stockService: StockService,
    private router: Router,
    private viewport: ViewportScroller,
  ) {}

  get skipLink(): string {
    return this.router.url.split('#', 1)[0] + '#workspace';
  }

  get embeddedResearch(): boolean {
    return this.router.isActive('/research-embed', {
      paths: 'exact',
      queryParams: 'ignored',
      matrixParams: 'ignored',
      fragment: 'ignored',
    });
  }

  ngOnInit(): void {
    this.stockService.lastSearch$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(ticker => {
      if (ticker) {
        this.router.navigateByUrl(`/search-details/${ticker}`);
      }
    });

    this.viewport.setHistoryScrollRestoration('manual');
    this.router.events.pipe(
      filter((event): event is Scroll => event instanceof Scroll),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(event => {
      if (!(event.routerEvent instanceof NavigationEnd)) return;
      const path = event.routerEvent.urlAfterRedirects.split(/[?#]/, 1)[0];
      // A tab or chart range changes the query string within the same workspace.
      if (this.lastWorkspacePath && this.lastWorkspacePath !== path) {
        this.viewport.scrollToPosition(event.position ?? [0, 0]);
        if (!event.position) this.workspace.nativeElement.focus({ preventScroll: true });
      }
      this.lastWorkspacePath = path;
    });
  }

}
