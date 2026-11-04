import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { NgbDropdownModule } from '@ng-bootstrap/ng-bootstrap';
import { finalize } from 'rxjs';
import { PortfolioService } from '../../services/portfolio.service';
import { ResearchRecentsService } from '../../services/research-recents.service';

@Component({
  selector: 'app-research-quick-switch',
  standalone: true,
  imports: [CommonModule, RouterLink, NgbDropdownModule],
  template: `
    <div ngbDropdown placement="bottom-start" (openChange)="$event && loadWatchlist()">
      <button ngbDropdownToggle type="button" class="switch-trigger" aria-label="Switch symbol">Switch</button>
      <div ngbDropdownMenu class="switch-menu">
        <h2 class="dropdown-header">Recently viewed</h2>
        <a *ngFor="let ticker of recentSymbols" ngbDropdownItem [routerLink]="['/search-details', ticker]">{{ ticker }}</a>
        <p *ngIf="!recentSymbols.length" class="switch-note">Other symbols you open will appear here.</p>
        <div class="dropdown-divider"></div>
        <h2 class="dropdown-header">Watchlist</h2>
        <p *ngIf="loading" class="switch-note" role="status">Loading watchlist...</p>
        <ng-container *ngIf="!loading">
          <p *ngIf="failed" class="switch-note" role="status">Watchlist unavailable.</p>
          <button *ngIf="failed" ngbDropdownItem type="button" (click)="$event.stopPropagation(); loadWatchlist()">Retry watchlist</button>
          <ng-container *ngIf="!failed">
            <a *ngFor="let ticker of savedSymbols" ngbDropdownItem [routerLink]="['/search-details', ticker]">{{ ticker }}</a>
            <p *ngIf="!savedSymbols.length" class="switch-note">No other saved symbols.</p>
          </ng-container>
        </ng-container>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .switch-trigger {
      min-height: 2.75rem;
      padding: .4rem .62rem;
      border: 1px solid var(--line);
      border-radius: .42rem;
      background: var(--surface);
      color: var(--ink);
      font-size: .78rem;
      font-weight: 650;
      white-space: nowrap;
    }
    .switch-trigger:hover, .switch-trigger[aria-expanded="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent-hover);
    }
    .switch-menu {
      width: min(15rem, calc(100vw - 2rem));
      max-height: min(24rem, 60vh);
      overflow: auto;
      border-color: var(--line);
      box-shadow: 0 8px 24px rgb(20 37 66 / 14%);
    }
    .switch-menu .dropdown-header { color: var(--muted); font-size: .73rem; font-weight: 700; }
    .switch-menu .dropdown-item {
      display: flex;
      min-height: 2.75rem;
      align-items: center;
      color: var(--ink);
      font-size: .85rem;
      font-weight: 650;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .switch-menu .dropdown-item:focus { background: var(--accent-soft); }
    .switch-note { margin: .2rem 1rem .65rem; color: var(--muted); font-size: .75rem; }
  `],
})
export class ResearchQuickSwitchComponent {
  @Input({ required: true }) activeTicker = '';

  private readonly recents = inject(ResearchRecentsService);
  private readonly portfolio = inject(PortfolioService);
  private readonly destroyRef = inject(DestroyRef);
  private watchlist: string[] = [];
  loading = false;
  failed = false;

  get recentSymbols(): string[] {
    return this.recents.symbols().filter(ticker => ticker !== this.activeTicker);
  }

  get savedSymbols(): string[] {
    return this.watchlist.filter(ticker => ticker !== this.activeTicker);
  }

  loadWatchlist(): void {
    if (this.loading) return;
    this.loading = true;
    this.failed = false;
    this.portfolio.getWatchlist().pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading = false),
    ).subscribe({
      next: items => this.watchlist = items.map(({ ticker }) => ticker),
      error: () => this.failed = true,
    });
  }
}
