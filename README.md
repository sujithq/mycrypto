# Crypto Allocation Desk

A no-backend GitHub Pages dashboard for a hypothetical, aggressive €500 crypto portfolio. It tracks daily EUR closes, calculates each holding’s evolution, publishes a configurable trailing status report, and lets visitors configure or reset their own allocation locally.

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
- Managed profiles can be simulations or real portfolios. Simulations use monthly or per-purchase baselines; real portfolios use manually entered quantities and actual cost values.
- `.github/workflows/update-market-data.yml` runs at 23:55 UTC, fetches the configured portfolio's EUR quotes from CoinGecko in one request, retains up to 366 closes, generates the trailing report, commits the data, and deploys the refreshed site.
- Each update adds or replaces that day’s UTC snapshot, so history accumulates from scheduled or local runs without separate per-asset requests.
- Browser profiles are validated, can include actual buy dates, and are stored only in `localStorage`.
- The management page can create, rename, edit, and delete browser-local simulations. It can also compose JSON for a file-based simulation or real portfolio without changing published profiles.
- `manage.html` generates complete profile-file JSON. Real holdings can be entered row by row or pasted as JSON using an asset ID or symbol, quantity, cost, and optional buy date. Assets may appear more than once when their buy dates differ. TARS AI (TAI) is included in the supported asset universe.
- `.github/workflows/deploy-pages.yml` validates and deploys every push to `main`.

Crypto markets never close. “Daily close” in this project means the automated 23:55 UTC snapshot.

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