# Investment Platform audit

The rework covers market research, the read-only embed, watchlist, and paper portfolio. Review the rendered routes at 320, 390, 768, and 1440 pixels. Use live AAPL, MSFT, and NVDA data for the read-only paths. Use fixtures for delays, malformed data, image failures, and orders so review cannot change the shared demo account.

Top News keeps publisher, timestamp, and headline visible when the provider omits artwork, repeats a promotional asset, or serves an image that fails to load or has banner dimensions. Review the image cases separately from the news endpoint's success status. Chart and quote timestamps are shown independently because their providers update at different times.

## Priorities after this pass

| Priority | Finding | Next step and acceptance criteria |
| --- | --- | --- |
| P1 | The public Full Demo has one wallet, watchlist, and portfolio shared across visitors. | Give each anonymous visitor a resettable sandbox with its own demo records and an expiry. Two fresh browser sessions should never see each other’s orders or watchlist changes. Keep the embed read-only. |
| P1 | An order may succeed after its response is lost, and the API does not enforce the quote currency. | Persist an idempotency key and order receipt in the same transaction as the wallet and position. Show pending/final status and verify currency on the server. Submitting the same key twice should move cash once, and a non-USD quote must never settle into the USD demo wallet. |
| P1 | Angular 17 and the charting dependency have unresolved advisories. | Upgrade the framework, Material, TypeScript, and chart integration together in a separate change. Require a clean install, production build, and browser checks across ticker research, watchlist, and paper portfolio. |
| P2 | Live market data can be delayed, unavailable, or quota-limited. | Add bounded shared caching and request limits, show source and quote timestamp, and provide a clearly labeled sample walkthrough when live data is down. Verify that a provider outage still lets an interviewer complete the walkthrough. |
| P2 | The demo does not guide a first-time visitor through a complete workflow. | Surface one starting action and three suggested steps: research a ticker, save it, then review a paper position. Add a clear reset action when sessions are isolated. |

For interviews, start from the portfolio’s read-only preview to explain the quote flow. Use the full demo to show watchlist and trading behavior. Until session isolation is implemented, use a protected demo environment when changing wallet or portfolio state.
