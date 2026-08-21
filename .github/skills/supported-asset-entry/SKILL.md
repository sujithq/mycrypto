---
name: supported-asset-entry
description: Return a complete data/portfolio.json supportedAssets entry from a crypto symbol or CoinGecko ID. Uses the local registry first, then verifies canonical metadata with CoinGecko and produces id, symbol, name, and thesis. Use when asked for coin info, a missing supported asset, or JSON to add a coin to supportedAssets.
license: MIT
metadata:
  author: sujithq
  version: "1.0.0"
---

# Supported Asset Entry

Return one insertion-ready `supportedAssets` JSON object for a crypto symbol or
CoinGecko ID.

## Input

- Asset: a symbol or CoinGecko ID, matched case-insensitively.

## Workflow

1. Run the resolver from the repository root:

   ```bash
   npm run supported-asset-entry -- <asset>
   ```

2. Read the JSON result.
3. When `source` is `local`, return `entry` unchanged.
4. When `source` is `CoinGecko`, use `context.categories` and
   `context.description` to add a concise `thesis` to `entry`.
5. Return only the completed object unless an error or ambiguity needs to be
   explained:

   ```json
   {
     "id": "canonical-coingecko-id",
     "symbol": "SYMBOL",
     "name": "Asset Name",
     "thesis": "Concise, factual investment-rationale sentence with relevant risk."
   }
   ```

## Rules

- Use `data/portfolio.json` first. Preserve an existing entry exactly, including
  its thesis, and do not make a network request for it.
- Treat an exact CoinGecko ID as stronger than a symbol match.
- Never silently choose among assets sharing a symbol. Return the resolver's
  canonical ID choices and ask for one of those IDs.
- Never substitute a similarly named asset or invent an ID.
- Keep the canonical CoinGecko ID and name. Return the symbol in uppercase.
- For a new asset, write one neutral, specific thesis sentence grounded in the
  returned categories or description. Mention material speculative,
  project-specific, liquidity, or ecosystem risk when relevant.
- Do not copy promotional claims, make price predictions, or present the thesis
  as financial advice.
- Do not include `source` or `context` in the final `supportedAssets` object.
- Do not modify `data/portfolio.json` unless the user separately asks for the
  entry to be added.

## Examples

```bash
npm run supported-asset-entry -- BTC
npm run supported-asset-entry -- dogwifcoin
```