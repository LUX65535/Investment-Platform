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
  ngOnInit(): void {
    console.log('Before Added to watchlist')
    this.stockService.lastSearch$.subscribe(ticker => {
      if (ticker) {
        this.router.navigateByUrl(`/search-details/${ticker}`);
      }
    });
  }

}
