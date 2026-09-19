---
name: code-review
description: Review pull requests and diffs in this repository against its no-backend, static-dashboard conventions, covering pure model logic in src/model.js, sortable/accessible table markup in src/app.js and src/manage.js, profile and portfolio data invariants, test coverage under test/, and documentation upkeep. Use when asked to review a PR, diff, or set of changes in this repository.
license: MIT
metadata:
  author: sujithq
  version: "1.0.0"
---

# Code Review

Review changes in this repository (a no-backend GitHub Pages crypto portfolio
dashboard) against its established conventions before approving or requesting
changes.

## Workflow

1. Identify the diff to review (staged, unstaged, or a PR/branch comparison).
2. Read the changed files fully, not just the diff hunks, to understand
   surrounding conventions.
3. Check the diff against the rules below, grouped by area.
4. Run `npm run check` (runs `node --test` then `node scripts/build.mjs`) when
   `src/`, `scripts/`, `data/`, or `profiles/` files changed, and report
   failures.
5. Report only high-confidence, actionable findings. Do not comment on style
   choices that already match the surrounding file.

## Rules

### Model logic (`src/model.js`)

- Functions here must stay pure (no DOM, `fetch`, or `window` access) so they
  remain usable from both the browser bundle and `node --test`.
- Sorting and comparison helpers (e.g. `sortHoldings`) must keep missing or
  non-finite values sorted last and preserve the original array order for
  fully tied entries (stable sort), never mutate the input array in place.
- New or changed exported functions need matching cases in `test/model.test.mjs`.

### UI (`src/app.js`, `src/manage.js`)

- Any interactive sort control must update the corresponding `aria-sort`
  attribute on its `<th>` and expose a visible direction indicator; verify
  both the ascending and descending states are reachable.
- Reselecting or switching a portfolio must reset transient UI state (such as
  the active sort) back to the documented default instead of preserving it.
- Confirm asset-detail links (`?asset=` or similar) still resolve correctly
  after any row reordering.

### Data (`data/portfolio.json`, `profiles/*.json`)

- Profile filenames must match their `id` field (see
  `scripts/load-profiles.mjs`).
- Every holding `id` must exist in `supportedAssets`, and stored `symbol`
  values must match that asset's canonical registry symbol.
- `buyTimestamp` values must be UTC ISO-8601 instants ending in `Z`
  (`isValidTimestamp` in `src/model.js`).

### Tests and scripts

- Tests under `test/` must not perform real network requests; only
  `scripts/update-market-data.mjs` and the `.github/skills/*/scripts/*.mjs`
  live-lookup helpers are expected to call CoinGecko.
- New `npm run <name>` scripts backing a skill belong under
  `.github/skills/<skill-name>/scripts/` with a matching `SKILL.md`.

### Documentation

- When a change adds or depends on an external resource, API, or service,
  update `README.md` (and any affected `SKILL.md`) in the same PR.

### General

- Flag any secret, API key, or credential committed into source or config.
- Flag newly introduced security vulnerabilities (e.g. unsanitized HTML
  injection into the DOM, unsafe `eval`/`Function` usage).
- Do not flag pre-existing issues unrelated to the diff under review.
