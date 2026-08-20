# Crypto Allocation Desk

A no-backend GitHub Pages dashboard for configurable crypto portfolio profiles. It tracks daily EUR closes, calculates each holding’s evolution, publishes a trailing status report for every profile, and lets visitors manage their own allocation locally.

> **Educational use only.** Crypto assets are highly volatile and can lose their entire value. This project does not provide financial advice.

## Researched model allocation

The model uses liquid anchors (35%) and deliberately places the rest across higher-beta layer-one, DeFi, scaling, oracle, and decentralized-compute themes.

| Asset | Theme | Allocation |
| --- | --- | ---: |
| Bitcoin (BTC) | Macro anchor | €60 |
| Ethereum (ETH) | Smart-contract anchor | €115 |
| Solana (SOL) | High-throughput L1 | €70 |
| Hyperliquid (HYPE) | On-chain market infrastructure | €60 |
| Bittensor (TAO) | Decentralized machine intelligence | €50 |
| Sui (SUI) | Move-based L1 | €50 |
| Chainlink (LINK) | Oracle and interoperability infrastructure | €35 |
| Arbitrum (ARB) | Ethereum scaling | €25 |
| Render (RENDER) | Distributed GPU compute | €20 |
| Injective (INJ) | On-chain financial markets | €15 |
| **Total** | | **€500** |

The selection prioritizes distinct use cases rather than ten highly correlated base-layer tokens. The small-cap and token-specific positions carry substantial drawdown, liquidity, governance, unlock, regulatory, and execution risk. Allocation is a research model—not a recommendation.

Research and identifier references:

- [CoinGecko keyless API and rate limits](https://docs.coingecko.com/docs/keyless-public-api)
- [CoinGecko coin ID list](https://docs.coingecko.com/reference/coins-list)
- [Ethereum rollups and layer-two scaling](https://ethereum.org/en/layer-2/)
- [Chainlink documentation](https://docs.chain.link/)
- [Bittensor documentation](https://docs.learnbittensor.org/)
- [Render Network knowledge base](https://know.rendernetwork.com/)
- [Sui documentation](https://docs.sui.io/)

## How it works

- `data/portfolio.json` defines the research portfolio, configurable asset universe, and trailing chart/report timeframe.
- Each JSON file in `profiles/` defines one read-only selectable profile. The build validates the files and publishes their index.
- Managed profiles can be simulations or real portfolios. Simulations use monthly or per-purchase baselines; real portfolios use manually entered quantities and invested amounts.
- `.github/workflows/update-market-data.yml` runs hourly, fetches supported EUR quotes from CoinGecko, generates a trailing report for every published profile, commits changed data, and deploys the refreshed site.
- Each update adds or replaces that day’s UTC snapshot. Stored history is retained beyond one year so older cached prices remain available even after they leave CoinGecko's public 365-day retrieval window. The chart and report still use the configured 366-day display window.
- The dashboard can opt into browser-only live prices every 1, 5, 15, 30, or 60 minutes. Selecting an asset's `1D` range lazily loads and caches its rolling 24-hour CoinGecko series; while live prices are enabled, the open intraday chart follows the selected refresh interval. Settings, quotes, and per-asset intraday caches stay in `localStorage`; they do not change repository data or trigger a deployment.
- Browser profiles are validated, can include actual buy dates, and are stored only in `localStorage`.
- The management page can create, rename, edit, and delete browser-local simulations. It can also compose JSON for a file-based simulation or real portfolio without changing published profiles.
- `manage.html` generates complete profile-file JSON. Real holdings can be entered row by row or pasted as JSON using an asset ID or symbol, `quantity`, `investedAmount`, and an optional `buyDate`. Legacy `amount`, `cost`, and `actualCost` fields are accepted on import. Assets may appear more than once when their buy dates differ. TARS AI (TAI) is included in the supported asset universe.
- `.github/workflows/deploy-pages.yml` validates and deploys every push to `main`.

Crypto markets never close. The repository keeps the latest automated quote
captured for each UTC date. Optional live prices temporarily replace today's
point in the browser only.

## Local development

Requires Node.js 20 or newer.

```bash
npm ci
npm test
npm run build
python3 -m http.server 8000 --directory dist
```

Open <http://localhost:8000>. To fetch live data locally, run
`npm run update-data`. This uses the same updater as the scheduled workflow;
see [`docs/local-development.md`](docs/local-development.md) for data refresh,
history, and managed-default commands.

### Calculate an asset quantity

The repository includes the `market-quantity` agent skill for converting a fiat
amount into a supported crypto quantity using the latest stored market price:

```bash
npm run market-quantity -- TAI 250
npm run market-quantity -- TAI 250 2026-03-15
```

The command accepts a case-insensitive symbol or CoinGecko ID and returns JSON
with `investedAmount`, the price, calculated quantity, quote currency, source,
and snapshot time.
An optional `YYYY-MM-DD` third argument selects that exact historical snapshot
for simulations; without it, the latest stored quote is used. Dated lookups use
`data/market.json` first, then query CoinGecko when that asset and date are not
cached. Online fallback results are returned without modifying the market file.

## GitHub Pages setup

1. In **Settings → Pages**, choose **GitHub Actions** as the source.
2. Run **Update market data** once to create the initial history.
3. Run **Validate and deploy Pages** if the default branch is not named `main`.

Workflow dependencies are pinned to immutable commit SHAs. The application has no runtime package dependencies and sends no visitor data to third parties.

## Add a published profile

Create `profiles/<id>.json` manually, or use `manage.html` to compose and copy
the JSON. The filename must match the profile's lowercase `id`. Commit and push
the file; the Pages build validates it and makes it available in the dashboard's
profile selector. Published profile files are read-only in the application.