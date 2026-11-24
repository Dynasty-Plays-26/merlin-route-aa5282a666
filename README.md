# Merlin Route

Offline-first iPad PWA for a delivery route (Merlin-branded). Static files only — no server, no build step.

- Data stays on the iPad (localStorage). Back it up from Settings.
- Stops: Delivered, Bottles back, Not home (left at door / brought back), Spilled crate, notes.
- Daily summary: CSV export (stops + exception log) and webhook POST (JSON, queued offline, retried when online).

Webhook payload: `{ type, date, route, driver, totals, stops[], exceptions[] }`. Optional Bearer token header.

The default Tower 01 roster ships in roster.js (approved by Don). Other rosters can load from a private `#load=` link.
