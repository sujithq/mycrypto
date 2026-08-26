---
name: daily-gems-eligibility
description: Check whether one canonical CoinGecko asset passes the live daily-gems candidate screen on Revolut X in the EEA. Reports exact EUR, USD, and mixed-mode eligibility or rejection reasons using the production diamond ranker. Use when asked whether a coin, token, symbol, or CoinGecko ID is eligible for the daily gems issue or why it was excluded.
license: MIT
metadata:
  author: sujithq
  version: "1.0.0"
---

# Daily Gems Eligibility

Check one coin against the same live CoinGecko and Revolut X eligibility rules
used to generate the daily gems issue. This skill determines whether the asset
may enter a mode's eligible candidate pool. It does not predict whether the
asset will rank in that mode's final top 10.

## Inputs

- Asset: required CoinGecko ID or unambiguous symbol, matched
  case-insensitively. A locally supported symbol resolves to its configured
  canonical ID. Ambiguous external symbols require a CoinGecko ID.
- Quote mode: optional `ALL`, `EUR`, `USD`, or `MIXED`, default `ALL`. `ALL`
  checks the three daily-issue modes from one shared venue snapshot.
- Invested amount: optional positive EUR amount per asset, default `50`. Any
  mode that can place a USD order is capped at EUR 50.

## Workflow

1. Run the checker from the repository root:

   ```bash
  npm run daily-gems-eligibility -- <symbol-or-id> [quote-mode] [amount]
   ```

2. Read `eligible`, `eligibleInAllRequestedModes`, and each entry in `modes`.
3. For an eligible mode, report the verified trading pair and the live metrics
   that passed the screen.
4. For an excluded mode, report its exact `reason`, `identityStatus`, and any
   active ticker-matched `tradingPairs`.
5. Explain that eligibility admits the asset to the candidate pool; the full
   daily ranking can still place it below the top-10 cutoff.

Examples:

```bash
npm run daily-gems-eligibility -- polyswarm
npm run daily-gems-eligibility -- measurable-data-token USD
npm run daily-gems-eligibility -- layerzero EUR 50
```

## Eligibility Rules

The checker resolves one canonical asset, retrieves its complete live EUR
market row, retrieves Revolut X's EEA pair and currency configuration, and then
passes that row through `rankDiamondQuantities`. It therefore applies the same
requirements as the daily issue:

- Complete canonical CoinGecko ID, symbol, and name.
- An active requested-mode Revolut X pair in the EEA.
- Matching active CoinGecko and Revolut X currency identities.
- A EUR or converted USD quote order within the pair's limits.
- Positive current price.
- Market capitalization from EUR 10 million up to, but not including, EUR 1
  billion.
- At least EUR 100,000 in reported 24-hour volume.
- Volume-to-market-cap ratio of at least 1%.
- Complete 7-day and 30-day price changes.
- Usable circulating-supply or dilution data.
- Valid CoinGecko update timestamp.

## Rules

- Use a canonical CoinGecko ID when a symbol is ambiguous.
- Treat `identityStatus: "mismatch"` as a ticker collision, not as evidence that
  the requested CoinGecko asset trades on the venue.
- Treat `identityStatus: "not-checked"` as unresolved venue identity, not as a
  verified market.
- Do not infer eligibility from price, market capitalization, or a ticker alone.
- Do not use ATH data.
- Do not assign a daily rank or `diamondScore` from this isolated check. Ranking
  requires the complete candidate universe and occurs during issue generation.
- Recheck live eligibility immediately before acting because prices, metrics,
  pair status, currency identity, exchange rates, and order limits can change.
- Do not modify portfolio, profile, market, or issue files.

## Output

```json
{
  "asset": {
    "id": "coin-id",
    "symbol": "COIN",
    "name": "Coin",
    "isSupported": false
  },
  "checkedAt": "2026-08-26T12:00:00.000Z",
  "currency": "EUR",
  "investedAmount": 50,
  "requestedQuoteModes": ["EUR"],
  "eligible": true,
  "eligibleInAllRequestedModes": true,
  "modes": [
    {
      "quoteCurrencyMode": "EUR",
      "eligible": true,
      "reason": null,
      "identityStatus": "verified",
      "tradingPairs": ["COIN/EUR"],
      "candidate": {
        "tradingPair": "COIN/EUR",
        "quoteOrderAmount": 50,
        "currentPrice": 0.01,
        "marketCap": 20000000,
        "totalVolume": 2000000,
        "liquidityRatio": 0.1
      }
    }
  ]
}
```

This is a live quantitative eligibility check, not an investment
recommendation.