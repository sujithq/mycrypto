# Crypto Allocation Desk

A no-backend GitHub Pages dashboard for a hypothetical, aggressive €500 crypto portfolio. It tracks daily EUR closes, calculates each holding’s evolution, publishes a configurable trailing status report, and lets visitors configure or reset their own ten-asset allocation locally.

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

- `data/portfolio.json` defines the research portfolio, configurable asset universe, optional buy dates, and trailing chart/report timeframe.
- `.github/workflows/update-market-data.yml` runs at 23:55 UTC, fetches the configured portfolio's EUR quotes from CoinGecko in one request, retains up to 366 closes, generates the trailing report, commits the data, and deploys the refreshed site.
- Each update adds or replaces that day’s UTC snapshot, so history accumulates from scheduled or local runs without separate per-asset requests.
- Browser configuration is validated, can include actual buy dates, is stored only in `localStorage`, and is resettable to the researched model.
- `manage.html` is the shared management page for local portfolio selection and preparing JSON for the **Manage portfolio defaults** workflow. The default ten assets, actual buy values, optional buy dates, and timeframe can be updated without editing JSON by hand. TARS AI (TAI) is included in the supported asset universe.
- `.github/workflows/manage-portfolio.yml` validates and commits managed defaults. It gates execution through GitHub permissions/environment protection and checks that `PORTFOLIO_MANAGEMENT_SECRET` is configured without requesting, printing, or passing the secret value as workflow input.
- `.github/workflows/deploy-pages.yml` validates and deploys every push to `main`.

Crypto markets never close. “Daily close” in this project means the automated 23:55 UTC snapshot.

## Local development

Requires Node.js 20 or newer.

```bash
npm ci
npm test
npm run build
python3 -m http.server 8000
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

## Management setup

Create a GitHub environment named `portfolio-management`, restrict who can run or approve it, and add the existing `PORTFOLIO_MANAGEMENT_SECRET` secret there or at repository scope. The management workflow only verifies that the secret exists; it never exposes the value to the page, workflow inputs, logs, or committed files.