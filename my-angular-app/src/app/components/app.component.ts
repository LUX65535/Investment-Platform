import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { StockService } from '../services/stock.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})


export class AppComponent implements OnInit {

  constructor(private stockService: StockService, private router: Router) {}
  isCollapsed = true;

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
    this.stockService.lastSearch$.subscribe(ticker => {
      if (ticker) {
        this.router.navigateByUrl(`/search-details/${ticker}`);
      }
    });
  }

}
