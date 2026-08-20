---
name: market-quantity
description: Calculate the quantity of a supported crypto asset that can be bought for a fiat amount using the latest or a dated market price. Uses data/market.json first and retrieves a missing dated price from CoinGecko. Use when given a symbol or CoinGecko ID such as TAI, BTC, or tars-protocol, an amount such as 250, and optionally a YYYY-MM-DD simulation date.
license: MIT
metadata:
  author: sujithq
  version: "1.4.0"
---

# Market Quantity

Calculate a crypto quantity from the repository's latest or historical stored
market snapshot.

## Inputs

- Asset: a supported symbol or CoinGecko ID, matched case-insensitively.
- Invested amount: a positive number denominated in `data/market.json`'s `currency`.
- Date: optional `YYYY-MM-DD` date for an exact historical snapshot. Omit it to
  use the latest stored quote.

## Workflow

1. Run the calculator from the repository root:

   ```bash
  npm run market-quantity -- <asset> <amount> [date]
   ```

2. Read the JSON result.
3. Return the asset name and symbol, requested fiat amount as `investedAmount`,
   currency, unit price, calculated quantity, market timestamp, and source.
4. State whether the result used `data/market.json` or an online CoinGecko
  fallback. When a date was supplied, identify it as a historical simulation.

The calculation is:

$$
	ext{quantity} = \frac{\text{invested amount}}{\text{market price}}
$$

## Rules

- Use `data/portfolio.json` to resolve supported assets.
- Use `data/market.json` first. Do not make a network request when the latest or
  requested dated price is cached, even when that date is older than one year.
- When a requested dated price is not cached, retrieve that UTC day from
  CoinGecko's `market_chart/range` endpoint. Use the final valid sample within
  that date and return `priceOrigin: "online"` plus its `priceTimestamp`.
- CoinGecko's public API only exposes the latest 365 days. If an older date is
  not cached, report that limit and the earliest retrievable full UTC date
  without making a request that is guaranteed to fail.
- Do not write an online fallback result into `data/market.json`.
- Do not silently substitute another asset.
- Match a supplied date exactly. Do not silently use a nearby snapshot when the
  requested date is unavailable from both the cache and CoinGecko.
- Preserve enough decimal places for the result to reconstruct the requested
  invested amount accurately. Include the unrounded quantity when precision matters.
- If the asset, invested amount, or price is invalid, or CoinGecko cannot return the
  requested date, return the calculator error rather than estimating.

## Example

```bash
npm run market-quantity -- TAI 250
npm run market-quantity -- TAI 250 2026-03-15
```

The first command uses the latest stored TAI price. The second simulates the
quantity represented by EUR 250 on March 15, 2026, using the cached price when
available and CoinGecko otherwise.