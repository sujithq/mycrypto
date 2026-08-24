---
name: top-ath-quantities
description: Discover CoinGecko-listed crypto assets and rank them by the value a EUR 50 position would have if each returned to its all-time high. Returns the top 10 with verified canonical IDs, latest prices, quantities, ATH metrics, and local support status. Use when asked for the latest top 10 ATH opportunities, maximum ATH value, ATH upside, or a EUR 50 crypto lottery basket.
license: MIT
metadata:
  author: sujithq
  version: "1.1.0"
---

# Top ATH Quantities

Discover the CoinGecko-listed assets with the highest potential value at their
historical all-time high, based on an equal investment at the latest market
price.

## Inputs

- Invested amount per asset: optional positive number, default `50`.
- Result limit: optional positive integer, default `10`.
- Candidate limit: optional positive integer up to `1000`, default `1000`.

Both values use `data/portfolio.json`'s configured currency, which is EUR by
default.

## Workflow

1. Run the ranking from the repository root:

   ```bash
   npm run top-ath-quantities
   npm run top-ath-quantities -- 50 10
  npm run top-ath-quantities -- 50 10 1000
   ```

2. Read the JSON result.
3. Return the ranked `assets`, their latest prices, quantities, ATH data, upside
   multiples, and potential values at ATH.
4. Mention any assets in `excluded` and their reasons.
5. State that the result is a live CoinGecko snapshot, not a prediction that an
   asset will regain its ATH.

For every verified CoinGecko market candidate, the calculations are:

$$
\text{quantity} = \frac{\text{invested amount}}{\text{current price}}
$$

$$
\text{potential value at ATH} = \text{quantity} \times \text{ATH}
$$

Assets are sorted by potential value at ATH from highest to lowest. With equal
investments, this is equivalent to sorting by the `ATH / current price` upside
multiple.

## Rules

- Discover up to the latest 1000 assets from CoinGecko's `/coins/markets`
  endpoint, ordered by market capitalization and requested with full precision.
- Suggest only assets returned by that live endpoint with a canonical ID,
  symbol, name, current price, ATH, positive market capitalization, positive
  trading volume, and valid update timestamp. Never invent or infer an asset.
- Match a returned canonical ID against `data/portfolio.json`'s
  `supportedAssets`. Preserve the local symbol, name, and thesis when matched.
- Mark a newly discovered asset with `isSupported: false` and `thesis: null`.
  Before adding one to a profile, use the `supported-asset-entry` skill to add
  verified metadata and a thesis to `data/portfolio.json`.
- Rank by `potentialValueAtAth`, not raw quantity. Token unit counts are not
  economically comparable across assets with different supplies and denominations.
- Preserve enough precision in `quantity` to reconstruct the invested amount.
- Include `id`, `symbol`, `name`, support status, `investedAmount`, `quantity`,
  and `buyDate`. Supported results also include their local thesis.
- Include the current price, ATH, ATH date, upside multiple, upside percentage,
  potential value at ATH, market capitalization, rank, volume, and quote update
  time so the ranking and existence check are auditable.
- Report missing or invalid current-price and ATH data in `excluded` rather than
  estimating it.
- Do not modify `data/portfolio.json`, a profile, or market data unless the user
  separately asks for those changes.
- Present ATH recovery values as a historical comparison, not expected returns
  or financial advice.

## Output

The command returns a JSON object with the quote currency, amount per asset,
snapshot time, source, ranking metric, ranked assets, and exclusions. A ranked
asset has this shape:

```json
{
  "rank": 1,
  "id": "coin-id",
  "symbol": "COIN",
  "name": "Coin",
  "thesis": null,
  "isSupported": false,
  "investedAmount": 50,
  "quantity": 1000,
  "buyDate": "2026-08-24",
  "currentPrice": 0.05,
  "ath": 1,
  "athDate": "2024-01-01T00:00:00.000Z",
  "upsideMultiple": 20,
  "upsideToAthPct": 1900,
  "potentialValueAtAth": 1000,
  "marketCap": 10000000,
  "marketCapRank": 500,
  "totalVolume": 1000000,
  "lastUpdated": "2026-08-24T07:30:00.000Z"
}
```