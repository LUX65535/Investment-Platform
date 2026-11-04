import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SearchDetailsComponent } from './components/search-details/search-details.component';
import { WatchlistComponent } from './components/watchlist/watchlist.component';
import { PortfolioComponent } from './components/portfolio/portfolio.component';

const routes: Routes = [
  { path: 'search-details', component: SearchDetailsComponent },
  { path: 'search-details/:ticker', component: SearchDetailsComponent },
  {
    path: 'research-embed',
    title: 'Market research | Investment Platform',
    loadComponent: () => import('./components/research-embed/research-embed.component')
      .then(module => module.ResearchEmbedComponent),
  },
  { path: 'watchlist', component: WatchlistComponent },
  { path: 'portfolio', component: PortfolioComponent },
  { path: '', redirectTo: '/search-details', pathMatch: 'full' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {}
