# Milk Route

Offline-first iPad PWA for a milk delivery route. Static files only — no server, no build step.

- Data stays on the iPad (localStorage). Back it up from Settings.
- Stops: Delivered, Bottles back, Not home (left at door / brought back), Spilled crate, notes.
- Daily summary: CSV export (stops + exception log) and webhook POST (JSON, queued offline, retried when online).

Webhook payload: `{ type, date, route, driver, totals, stops[], exceptions[] }`. Optional Bearer token header.
