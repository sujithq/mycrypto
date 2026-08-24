---
name: diamond-quantities
description: Discover CoinGecko-listed crypto "diamonds" using market-cap headroom, EUR 50 quantity, liquidity, momentum, and supply-risk analysis without using ATH. Returns 10 verified candidates with an auditable composite score and local support status. Use when asked for crypto gems, diamonds, growth candidates, low-price opportunities, or maximum quantities with room to grow.
license: MIT
metadata:
  author: sujithq
  version: "1.0.0"
---

# Diamond Quantities

Discover liquid, lower-market-cap CoinGecko assets where EUR 50 buys a
meaningful quantity and the asset has measurable room to grow. This is a
multi-factor screen and does not use all-time-high prices.

## Inputs

- Invested amount per asset: optional positive number, default `50`.
- Result limit: optional positive integer, default `10`.
- Candidate limit: optional positive integer up to `1000`, default `1000`.

Values use `data/portfolio.json`'s configured currency, which is EUR by default.

## Workflow

1. Run the ranking from the repository root:

   ```bash
   npm run diamond-quantities
   npm run diamond-quantities -- 50 10 1000
   ```

2. Read the JSON result.
3. Return the ranked `assets`, their component scores, quantities, market data,
   and the EUR 1 billion reference-market-cap scenario.
4. Mention any important exclusions or data limitations.
5. State that this is a quantitative screen, not a prediction or investment
   recommendation.

## Eligibility Screen

A candidate must be returned by CoinGecko's live `/coins/markets` endpoint and
have all of the following:

- Canonical ID, symbol, and name.
- Positive current price.
- Market capitalization from EUR 10 million up to, but not including, EUR 1
  billion.
- At least EUR 100,000 in reported 24-hour volume.
- A volume-to-market-cap ratio of at least 1%.
- Complete 7-day and 30-day price changes.
- Usable circulating-supply, total-supply, maximum-supply, or fully diluted
  valuation data.
- A valid CoinGecko update timestamp.

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

- Discover up to the latest 1000 assets ordered by market capitalization.
- Never use ATH price or ATH recovery in eligibility, scoring, or ranking.
- Never invent an asset. Suggest only canonical rows returned by CoinGecko that
  pass every eligibility check.
- Match returned IDs against `data/portfolio.json`'s `supportedAssets` and
  preserve local metadata when available.
- Mark new candidates with `isSupported: false` and `thesis: null`. Before
  adding one to a profile, use the `supported-asset-entry` skill to add verified
  metadata and a thesis to `data/portfolio.json`.
- Preserve enough quantity precision to reconstruct the invested amount.
- Report rejected live rows in `excluded`; never silently estimate missing
  metrics.
- Treat the EUR 1 billion scenario as a comparison assuming unchanged token
  supply, not a price target or forecast.
- Do not modify portfolio, profile, or market files unless separately asked.

## Output

The command returns source metadata, screening thresholds, score weights,
ranked assets, and exclusions. Each asset includes this core information:

```json
{
  "rank": 1,
  "id": "coin-id",
  "symbol": "COIN",
  "name": "Coin",
  "thesis": null,
  "isSupported": false,
  "investedAmount": 50,
  "quantity": 50000,
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