import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { WatchlistComponent } from './components/watchlist/watchlist.component';
import { PortfolioComponent } from './components/portfolio/portfolio.component';

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
  { path: 'watchlist', title: 'Watchlist | Investment Platform', component: WatchlistComponent },
  { path: 'portfolio', title: 'Portfolio | Investment Platform', component: PortfolioComponent },
  { path: '', redirectTo: '/search-details', pathMatch: 'full' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
