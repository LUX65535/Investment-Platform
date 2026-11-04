import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const loadResearch = () => import('./components/search-details/search-details.component')
  .then(module => module.SearchDetailsComponent);

const routes: Routes = [
  { path: 'search-details', title: 'Research | Investment Platform', loadComponent: loadResearch },
  { path: 'search-details/:ticker', title: 'Stock research | Investment Platform', loadComponent: loadResearch },
  {
    path: 'research-embed',
    title: 'Market research | Investment Platform',
    loadComponent: () => import('./components/research-embed/research-embed.component')
      .then(module => module.ResearchEmbedComponent),
  },
  {
    path: 'screener',
    title: 'Market screener | Investment Platform',
    loadComponent: () => import('./components/market-screener/market-screener.component')
      .then(module => module.MarketScreenerComponent),
  },
  {
    path: 'watchlist',
    title: 'Watchlist | Investment Platform',
    loadComponent: () => import('./components/watchlist/watchlist.component').then(module => module.WatchlistComponent),
  },
  {
    path: 'portfolio',
    title: 'Portfolio | Investment Platform',
    loadComponent: () => import('./components/portfolio/portfolio.component').then(module => module.PortfolioComponent),
  },
  {
    path: '',
    pathMatch: 'full',
    title: 'Market overview | Investment Platform',
    loadComponent: () => import('./components/investment-home/investment-home.component')
      .then(module => module.InvestmentHomeComponent),
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
