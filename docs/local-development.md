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

The standard build matches the production artifact and excludes the owner
management tool.

## Start the owner management tool

```bash
npm run build:manage
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000/manage.html>. This explicit build includes
`manage.html` and `src/manage.js` for local use. It is an inclusion switch, not
an authentication layer. The GitHub Pages workflows always run the standard
build, which omits both files.

## Refresh market data locally

Run the same data updater used by the scheduled workflow:

```bash
npm run update-data
```

A normal run reuses complete current quotes for up to five minutes. Once those
quotes are five minutes old, another run fetches fresh prices and replaces the
current UTC date's snapshot. Use `npm run update-data:force` to refresh current
quotes sooner. The scheduled workflow uses the forced command once daily at
05:45 UTC, before the 07:15 UTC gems scan.

The script fetches EUR quotes for the configured default portfolio from
CoinGecko in one combined request, updates `data/market.json`, and regenerates
`data/profile-reports.json` with a report for every published profile. Each run
adds or replaces the current UTC snapshot, so daily history accumulates over
scheduled or local runs. Existing snapshots are retained beyond one year even
though the dashboard's chart and reports use a rolling 366-day display window.
Before requesting historical prices, the updater scans the stored UTC history
through yesterday for missing dates and missing supported-asset prices. An
empty cache is filled for CoinGecko's latest 365-date public window. Later runs
skip historical requests when that window is complete; when a gap exists, only
assets missing from the affected range are fetched. Older cached prices are
preserved, and an older uncached price cannot be recovered with the public API.

The public CoinGecko API may rate-limit requests. The updater retries a failed
combined request with backoff.
Do not commit local data changes unless they are intended to update the
repository's published snapshot.

## Use live browser prices

The dashboard's **Live prices** switch fetches all supported EUR quotes while
the page is open and visible. Refresh intervals are 1, 5, 15, 30, or 60
minutes, with 5 minutes as the default. The setting and latest complete quote
set are stored in `localStorage`, so a fresh cache is restored immediately on
reload without another request.

Selecting `1D` in an asset detail view lazily requests that asset's rolling
24-hour CoinGecko market chart and stores the timestamped prices in
`crypto-allocation-desk.intraday-market-cache.v1`. A fresh per-asset cache is
used immediately on later visits. The active intraday chart refreshes at the
selected interval only while **Live prices** is enabled; otherwise selection
performs at most one refresh and does not start a timer.

Live quotes replace the current UTC date's point only in browser memory. They
do not write `data/market.json`, run a workflow, or deploy the site. Turning
the switch off immediately restores the repository snapshot. A failed request
keeps the last good browser cache and retries after the selected interval.
The daily repository refresh remains necessary for that fallback, one durable
UTC history point, and the published profile reports; hourly repository commits
are unnecessary while browser live prices provide intraday updates.

## Add a published profile

Run `npm run build:manage` to use `manage.html` for editing a browser-local
portfolio and generating JSON for a published profile. The local portfolio is
saved only in browser storage. To publish a profile:

1. Create the JSON manually or click **Generate profile JSON** in `manage.html`.
2. Save it as `profiles/<id>.json`; the filename must match the profile `id`.
3. Run `npm run check`, then commit and push the profile file.

The Pages build validates every profile and generates the published profile
index. Profiles committed in `profiles/` are selectable but read-only in the
application.

## Portfolio profiles

The dashboard includes file-based monthly profiles beginning with January 2026.
Each profile can define its own assets, allocations, per-asset buy dates, and
optional exact buy timestamps. Store `buyTimestamp` as an ISO-8601 UTC instant
ending in `Z`, for example `2026-08-24T12:00:00.000Z`. The dashboard renders
that instant in `Europe/Brussels`, so CET/CEST follows Brussels DST.
An optional profile buy date acts as the default for custom portfolio items
without an individual buy date. Profiles without custom portfolio content keep
the original behavior: their profile buy date applies to every default asset.
File-based profiles may also use the `real` type. Real holdings record their current
quantity and `investedAmount` instead of requiring a €500 allocation. They can be
entered manually or pasted into the management page as a JSON array containing
`id` or `symbol`, `quantity`, `investedAmount`, and optional `buyDate` and
`buyTimestamp` fields.
Legacy `amount`, `cost`, and `actualCost` fields are accepted when importing.
Switching profiles does not modify historical prices. Browser-local profiles can
be created, edited, and deleted with the local-only management build.

The management page generates one complete profile object. It does not write or
modify any published profile. Publishing requires saving the generated JSON in
the repository, committing it, and pushing with an authorized Git identity.

## Daily gems issues

The scheduled **Propose daily crypto gems** workflow creates or updates one
issue per UTC date. It has read-only access to repository contents and write
access to issues; it never updates `data/` or `profiles/` directly. Scheduled
and manual runs evaluate EUR, USD, and MIXED from one shared snapshot and
publish the three profile alternatives in one issue.

To inspect the generated adoption package locally without creating an issue:

```bash
npm run daily-gems-issue -- --output daily-gems-issue.md --summary-output daily-gems-summary.json
npm run daily-gems-issue -- --quote-mode all --output daily-gems-all.md --summary-output daily-gems-all-summary.json
npm run daily-gems-issue -- --quote-mode usd --output daily-gems-usd.md --summary-output daily-gems-usd-summary.json
npm run daily-gems-issue -- --quote-mode mixed --output daily-gems-mixed.md --summary-output daily-gems-mixed-summary.json
```

The issue contains complete `supportedAssets` additions and a `real` profile.
EUR is the default quote mode; `usd` uses direct-USD pairs, while `mixed`
prefers direct-EUR pairs and falls back to direct-USD pairs. Candidates must
have a verified Revolut currency identity and order limits that accept the
proposed quote amount. USD orders use CoinGecko's live EUR/USD rate and cannot
exceed a EUR 50 equivalent. Quantities are CoinGecko reference fills, and each
generated `buyTimestamp` records the shared snapshot time. Neither is evidence
of a completed trade.

Use `all` to match the workflow. It creates one body with three mode-qualified
profile paths, one deduplicated registry-addition set, and one daily issue
marker for the publisher.
Reconfirm each pair immediately before trading, replace reference quantities
and snapshot timestamps with actual fills before saving the profile, append only
the missing registry entries to `data/portfolio.json`, then run:

```bash
npm run update-data:force
npm run check
```
