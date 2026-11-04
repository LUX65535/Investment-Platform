import { APP_INITIALIZER, NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { CommonModule, DecimalPipe } from '@angular/common';

import { AppComponent } from './components/app.component';
import { AppRoutingModule } from './app-routing.module';
import { WatchlistComponent } from './components/watchlist/watchlist.component';
import { PortfolioComponent } from './components/portfolio/portfolio.component';
import { MarketModeService } from './services/market-mode.service';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

@NgModule({
  declarations: [
    AppComponent,
    WatchlistComponent,
    PortfolioComponent
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    RouterModule,
    FormsModule,
    BrowserAnimationsModule,
    AppRoutingModule,
    MatProgressSpinnerModule,
    NgbModule,
    CommonModule,
  ],
  providers: [
    DecimalPipe, provideAnimationsAsync('noop'), provideAnimationsAsync(),
    { provide: APP_INITIALIZER, multi: true, deps: [MarketModeService], useFactory: (market: MarketModeService) => () => market.load() },
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
