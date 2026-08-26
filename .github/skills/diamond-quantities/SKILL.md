---
name: diamond-quantities
description: Discover CoinGecko-listed crypto "diamonds" that have active direct-EUR or direct-USD markets on Revolut X in the EEA. Defaults to EUR, with optional USD or EUR-preferred mixed screening. Uses market-cap headroom, a maximum EUR 50 position for USD pairs, liquidity, momentum, and supply-risk analysis without using ATH. Returns 10 venue-verified candidates with an auditable composite score and local support status. Use when asked for crypto gems, diamonds, growth candidates, low-price opportunities, or maximum quantities with room to grow.
license: MIT
metadata:
  author: sujithq
  version: "1.4.0"
---

# Diamond Quantities

Discover liquid, lower-market-cap CoinGecko assets where EUR 50 buys a
meaningful quantity, the asset has measurable room to grow, and the exact asset
has an active direct-EUR or direct-USD Revolut X market in the EEA. EUR is the
default; USD-only and EUR-preferred mixed screening are explicit options. This
is a multi-factor screen and does not use all-time-high prices.

## Inputs

- Invested amount per asset: optional positive number, default `50`.
- Result limit: optional positive integer, default `10`.
- Market-cap candidate limit: optional positive integer up to `1000`, default
  `1000`. Active Revolut X base symbols are queried separately so venue-listed
  assets outside that market-cap window are still screened.
- Quote mode: optional `EUR`, `USD`, or `MIXED`, default `EUR`. Mixed mode uses
  an active EUR pair first and falls back to an active USD pair.

Values use `data/portfolio.json`'s configured currency. This skill requires that
currency to be EUR for valuation, allocation, and scoring. USD quote orders use
CoinGecko's live exchange-rate feed and cannot exceed a EUR 50 equivalent.

## Workflow

1. Run the ranking from the repository root:

   ```bash
   npm run diamond-quantities
   npm run diamond-quantities -- 50 10 1000
  npm run diamond-quantities -- 50 10 1000 usd
  npm run diamond-quantities -- 50 10 1000 mixed
   ```

2. Read the JSON result. The command retrieves the requested CoinGecko
  market-cap window, supplements it with every paginated CoinGecko row for
  active Revolut X base symbols, and retrieves Revolut X's public EEA pair and
  currency configuration. Requests to each external API are serialized and
  paced at one per second.
3. Return the ranked `assets`, their component scores, quantities, market data,
   and the EUR 1 billion reference-market-cap scenario.
4. Mention any important exclusions or data limitations.
5. State that this is a quantitative screen, not a prediction or investment
   recommendation.

## Eligibility Screen

A candidate must be returned by CoinGecko's live `/coins/markets` endpoint,
match Revolut X's public currency identity, and have all of the following:

- Canonical ID, symbol, and name.
- An active `SYMBOL/EUR` or `SYMBOL/USD` pair allowed by the requested mode in
  Revolut X's EEA configuration. Mixed mode prefers `SYMBOL/EUR`.
- An active Revolut X currency whose symbol and name identify the same asset;
  ambiguous symbol collisions fail closed unless covered by an explicit
  canonical CoinGecko-ID mapping.
- A quote order that satisfies the pair's minimum and available maximum order
  limits. USD amounts are converted from EUR using CoinGecko's live EUR/USD
  rate and remain capped at a EUR 50 equivalent.
- Positive current price.
- Market capitalization from EUR 10 million up to, but not including, EUR 1
  billion.
- At least EUR 100,000 in reported 24-hour volume.
- A volume-to-market-cap ratio of at least 1%.
- Complete 7-day and 30-day price changes.
- Usable circulating-supply, total-supply, maximum-supply, or fully diluted
  valuation data.
- A valid CoinGecko update timestamp.

Venue-symbol supplementation uses `include_tokens=all`, so symbol collisions
remain visible to the canonical name-and-symbol identity check and fail closed.
Supplemental pages continue until CoinGecko returns a short page.

## Ranking

The EUR 50 quantity is:

$$
\text{quantity} = \frac{50}{\text{current price}}
$$

Room to grow is measured against a EUR 1 billion reference market cap:

$$
\text{headroom multiple} = \frac{1{,}000{,}000{,}000}{\text{market cap}}
$$

The `diamondScore` is a weighted score from 0 to 100:

- 30% logarithmic market-cap headroom.
- 25% logarithmic EUR 50 quantity relative to other eligible candidates.
- 20% volume-to-market-cap liquidity.
- 15% combined 7-day and 30-day momentum.
- 10% circulating-supply ratio to penalize dilution risk.

Raw quantity is deliberately capped at 25% of the score because token unit
denominations are arbitrary. Liquidity, supply, and market-cap headroom prevent
an inactive low-price token from ranking solely because it prints a large unit
count.

## Rules

- Discover up to the latest 1000 assets ordered by market capitalization and
  supplement them with all CoinGecko rows matching active Revolut X base
  symbols in the requested quote mode.
- Treat Revolut X's public EEA pair configuration as the source of truth for
  direct EUR and USD tradability. A CoinGecko valuation alone is not sufficient.
- Default to EUR-only screening. Use USD only when explicitly requested; in
  mixed mode, prefer EUR and use USD as a fallback.
- Recheck pair status and order limits immediately before trading because venue
  configuration can change after a ranking is generated.
- Never use ATH price or ATH recovery in eligibility, scoring, or ranking.
- Never invent an asset. Suggest only canonical rows returned by CoinGecko that
  pass every eligibility check.
- Match returned IDs against `data/portfolio.json`'s `supportedAssets` and
  preserve local metadata when available.
- Mark new candidates with `isSupported: false` and `thesis: null`. Before
  adding one to a profile, use the `supported-asset-entry` skill to add verified
  metadata and a thesis to `data/portfolio.json`.
- Preserve enough quantity precision to reconstruct the invested amount.
- Report rejected live rows in `excluded` and `exclusionDetails`; report
  eligible candidates below the requested result limit in
  `eligibleButNotSelected`. Each exclusion detail reports `identityStatus` as
  `verified`, `mismatch`, or `not-checked`. Never silently estimate missing
  metrics.
- Treat the EUR 1 billion scenario as a comparison assuming unchanged token
  supply, not a price target or forecast.
- Do not modify portfolio, profile, or market files unless separately asked.

## Output

The command returns CoinGecko and Revolut X source metadata, discovery counts,
screening thresholds, score weights, ranked assets, eligible candidates below
the selection cutoff, and exclusions. Each selected asset includes this core
information:

```json
{
  "rank": 1,
  "id": "coin-id",
  "symbol": "COIN",
  "name": "Coin",
  "thesis": null,
  "isSupported": false,
  "tradingPair": "COIN/EUR",
  "tradingVenue": "Revolut X",
  "tradingRegion": "EEA",
  "tradingPairStatus": "active",
  "tradingCurrencyName": "Coin",
  "tradingQuoteCurrency": "EUR",
  "quoteOrderAmount": 50,
  "minOrderSizeQuote": 0.1,
  "maxOrderSizeQuote": 1000000,
  "investedAmount": 50,
  "quantity": 50000,
  "buyDate": "2026-08-24",
  "buyTimestamp": "2026-08-24T12:00:00.000Z",
  "currentPrice": 0.001,
  "marketCap": 10000000,
  "totalVolume": 2000000,
  "liquidityRatio": 0.2,
  "priceChange7dPct": 10,
  "priceChange30dPct": 20,
  "circulatingSupplyRatio": 0.9,
  "growthMultipleToReferenceMarketCap": 100,
  "potentialValueAtReferenceMarketCap": 5000,
  "diamondScore": 92.625
}
```