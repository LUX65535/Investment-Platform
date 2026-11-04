# Investment Platform audit

The rework covers market research, the read-only embed, watchlist, and paper portfolio. Review the rendered routes at 320, 390, 768, and 1440 pixels. Use live AAPL, MSFT, and NVDA data for the read-only paths. Use local fixtures for delays, malformed data, image failures, and orders.

Top News keeps publisher, timestamp, and headline visible when the provider omits artwork, repeats a promotional asset, or serves an image that fails to load or has banner dimensions. Review the image cases separately from the news endpoint's success status. Chart and quote timestamps are shown independently because their providers update at different times.

Paper account checks cover two independent browser cookies, lost responses after a committed fill, recovery with the original order ID, and USD currency validation. Verify that a repeated order returns the same receipt and deducts cash once. The browser retains unresolved order IDs for retries, and the server retains filled and rejected receipts through the sandbox's fixed 30-day lifetime.

## Priorities after this pass

| Priority | Finding | Next step and acceptance criteria |
| --- | --- | --- |
| P1 | Angular 17 and the charting dependency have unresolved advisories. | Upgrade the framework, Material, TypeScript, and chart integration together in a separate change. Require a clean install, production build, and browser checks across ticker research, watchlist, and paper portfolio. |
| P2 | Live market data can be delayed, unavailable, or quota-limited. | Add bounded shared caching and request limits, show source and quote timestamp, and provide a clearly labeled sample walkthrough when live data is down. Verify that a provider outage still lets an interviewer complete the walkthrough. |
| P2 | The demo does not guide a first-time visitor through a complete workflow. | Surface one starting action and three suggested steps: research a ticker, save it, then review a paper position. Add a clear reset action when sessions are isolated. |

For interviews, start from the portfolio’s read-only preview to explain the quote flow. Use the full demo to show a personal watchlist, a paper fill, and its receipt.
