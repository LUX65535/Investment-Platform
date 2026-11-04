import { ViewportScroller } from '@angular/common';
import { Component, DestroyRef, ElementRef, OnInit, ViewChild, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';
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
  private cancelScrollRestore?: () => void;

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
    this.destroyRef.onDestroy(() => this.cancelScrollRestore?.());
    this.router.events.pipe(
      filter((event): event is Scroll | NavigationStart => event instanceof Scroll || event instanceof NavigationStart),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(event => {
      if (event instanceof NavigationStart) {
        this.cancelScrollRestore?.();
        return;
      }
      if (!(event.routerEvent instanceof NavigationEnd)) return;
      const path = event.routerEvent.urlAfterRedirects.split(/[?#]/, 1)[0];
      // A tab or chart range changes the query string within the same workspace.
      if (this.lastWorkspacePath && this.lastWorkspacePath !== path) {
        if (event.position) {
          this.restoreScrollPosition(event.position);
        } else {
          this.viewport.scrollToPosition([0, 0]);
          this.workspace.nativeElement.focus({ preventScroll: true });
        }
      }
      this.lastWorkspacePath = path;
    });
  }

  private restoreScrollPosition(position: [number, number]): void {
    const workspace = this.workspace.nativeElement;
    const scrollRoot = workspace.ownerDocument.scrollingElement;
    const canRestore = () => !scrollRoot || position[1] <= scrollRoot.scrollHeight - scrollRoot.clientHeight;
    if (canRestore() || typeof ResizeObserver === 'undefined') {
      this.viewport.scrollToPosition(position);
      return;
    }

    // Browser Back can arrive while asynchronous research or list content is still loading.
    const interactions = new AbortController();
    const observer = new ResizeObserver(() => {
      if (canRestore()) restore();
    });
    const timeout = window.setTimeout(() => restore(), 3000);
    const cancel = () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      interactions.abort();
      this.cancelScrollRestore = undefined;
    };
    const restore = () => {
      cancel();
      this.viewport.scrollToPosition(position);
    };

    this.cancelScrollRestore = cancel;
    for (const event of ['wheel', 'pointerdown', 'keydown']) {
      window.addEventListener(event, cancel, { passive: true, signal: interactions.signal });
    }
    observer.observe(workspace);
  }

}
