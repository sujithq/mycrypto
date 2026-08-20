# Local development

The dashboard can be developed and refreshed locally without running a GitHub
Actions workflow. Use Node.js 20 or newer.

## Start the dashboard

```bash
npm ci
npm run check
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000> in a browser. The static server is needed because
the dashboard loads its JSON files with `fetch()`.

## Refresh market data locally

Run the same data updater used by the scheduled workflow:

```bash
npm run update-data
```

The script fetches EUR quotes for the configured default portfolio from
CoinGecko in one combined request, updates `data/market.json`, and regenerates
`data/weekly-report.json`. Each run adds or replaces the current UTC snapshot,
so daily history accumulates over scheduled or local runs. Existing snapshots
are retained beyond one year even though the dashboard's chart and report use a
rolling 366-day display window.
Before requesting historical prices, the updater scans the stored UTC history
through yesterday for missing dates and missing supported-asset prices. It
refreshes every supported asset from the earliest gap through the current run.
When the cache has no gaps, it refreshes CoinGecko's latest 365-date public
window instead. Remote requests are clamped to that window while older cached
prices are preserved; an older uncached price cannot be recovered with the
public API.

The public CoinGecko API may rate-limit requests. The updater retries a failed
combined request with backoff.
Do not commit local data changes unless they are intended to update the
repository's published snapshot.

## Add a published profile

The combined management page at `manage.html` lets you edit a local browser
portfolio and generate JSON for a published profile. The local portfolio is
saved only in browser storage. To publish a profile:

1. Create the JSON manually or click **Generate profile JSON** in `manage.html`.
2. Save it as `profiles/<id>.json`; the filename must match the profile `id`.
3. Run `npm run check`, then commit and push the profile file.

The Pages build validates every profile and generates the published profile
index. Profiles committed in `profiles/` are selectable but read-only in the
application.

## Portfolio profiles

The dashboard includes file-based monthly profiles beginning with January 2026.
Each profile can define its own assets, allocations, and per-asset buy dates.
An optional profile buy date acts as the default for custom portfolio items
without an individual buy date. Profiles without custom portfolio content keep
the original behavior: their profile buy date applies to every default asset.
File-based profiles may also use the `real` type. Real holdings record their current
quantity and actual cost instead of requiring a €500 allocation. They can be
entered manually or pasted into the management page as a JSON array containing
`id` or `symbol`, `quantity`, `cost` (or `amount`), and an optional `buyDate`.
Switching profiles does not modify historical prices. Browser-local profiles can
be created, edited, and deleted on `manage.html`.

The management page generates one complete profile object. It does not write or
modify any published profile.
