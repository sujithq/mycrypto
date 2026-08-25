---
name: profile-validator
description: Validate a crypto portfolio profile by ID or JSON path against the repository model and supported asset registry. Checks profile metadata, filename, holdings, amounts, real quantities, simulated totals, canonical symbols, UTC timestamps, duplicate purchase lots, runtime enrichment, and backward-compatible legacy fields. Use when asked whether a profile is valid or why profile validation fails.
license: MIT
metadata:
  author: sujithq
  version: "1.0.0"
---

# Profile Validator

Validate one portfolio profile with the same local model used by repository
builds, plus actionable filename, symbol, and enrichment diagnostics.

## Input

- Profile: a profile ID such as `learn`, a bare JSON filename, or a relative or
  absolute JSON path.

## Workflow

1. Run the validator from the repository root:

   ```bash
   npm run validate-profile -- <profile-id-or-path>
   ```

2. Read the JSON result.
3. Report `valid` first, followed by failed `checks` and exact `errors`.
4. Report `warnings` separately. Warnings identify accepted legacy or redundant
   storage and do not make an otherwise valid profile fail.

## Rules

- Use only local `data/portfolio.json`, the requested profile, and `src/model.js`.
  Do not make network requests.
- Accept a profile ID by resolving it to `profiles/<id>.json`.
- Require a published profile filename to match its lowercase profile `id`.
- Verify every holding ID against `supportedAssets` and every stored symbol
  against that asset's canonical registry symbol.
- Require positive `investedAmount` values. Real profiles also require positive
  quantities; simulated profiles must total `totalInvestment`.
- Require `buyTimestamp` values to be ISO-8601 UTC instants ending in `Z`.
- Treat repeated asset purchases as separate lots only when their purchase keys
  are unique.
- Confirm runtime enrichment supplies each holding's `name` and `thesis`, and
  derives `buyDate` from a valid timestamp.
- Prefer compact timestamped real holdings containing only `id`, `symbol`,
  `investedAmount`, `quantity`, and `buyTimestamp`.
- Keep backward compatibility: date-only and verbose profiles may remain valid.
  Report derived, legacy, or redundant stored fields as warnings.
- Do not modify a profile unless the user separately asks for a fix.
- An invalid result exits with a nonzero status. Do not suppress or reinterpret
  the returned errors.

## Examples

```bash
npm run validate-profile -- learn
npm run validate-profile -- profiles/learn.json
```