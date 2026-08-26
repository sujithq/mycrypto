import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  getDiamondQuantities,
  getDiamondQuantitiesForQuoteModes,
} from '../.github/skills/diamond-quantities/scripts/rank-diamond-quantities.mjs';
import { isValidProfile } from '../src/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INVESTED_AMOUNT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 1_000;
const DEFAULT_QUOTE_CURRENCY_MODE = 'EUR';
const MAX_USD_INVESTMENT_EUR = 50;
const CONSOLIDATED_QUOTE_CURRENCY_MODES = ['EUR', 'USD', 'MIXED'];
const MAX_GITHUB_ISSUE_BODY_CHARACTERS = 65_536;
const REPLACEMENT_SUMMARY_RESERVE_CHARACTERS = 8_000;
const MAX_GENERATED_ISSUE_BODY_CHARACTERS = MAX_GITHUB_ISSUE_BODY_CHARACTERS
  - REPLACEMENT_SUMMARY_RESERVE_CHARACTERS;
const MAX_BELOW_CUTOFF_ROWS = 20;
const MAX_EXCLUSION_EXAMPLES = 20;

function normalizeCategory(value) {
  return String(value ?? '')
    .replace(/[`|<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function formatNumber(value, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-IE', {
    maximumFractionDigits,
  }).format(Number(value));
}

function formatPrice(value) {
  return new Intl.NumberFormat('en-IE', {
    maximumSignificantDigits: 8,
  }).format(Number(value));
}

function normalizedExclusionReason(value) {
  const reason = String(value ?? 'Unknown exclusion reason.');
  if (/^No active .+ market in .+\.$/.test(reason)) {
    return 'No active requested-mode market on the configured venue.';
  }
  if (/ returned invalid .+ quote-order limits\.$/.test(reason)) {
    return 'The active venue market returned invalid quote-order limits.';
  }
  if (reason.includes(' is below the ') && reason.includes(' minimum quote order of ')) {
    return 'The requested quote amount is below the active market minimum.';
  }
  if (reason.includes(' exceeds the ') && reason.includes(' maximum quote order of ')) {
    return 'The requested quote amount exceeds the active market maximum.';
  }
  if (reason.includes(' currency identity for ') && reason.endsWith(' is not active and complete.')) {
    return 'The active venue currency identity is incomplete.';
  }
  if (reason.startsWith('CoinGecko identity ') && reason.includes(' does not match ')) {
    return 'CoinGecko identity does not match the active venue currency identity.';
  }
  return reason;
}

function representativeExclusions(details) {
  const uniqueById = new Map(details.map((detail) => [detail.id, detail]));
  const uniqueDetails = [...uniqueById.values()];
  const byMarketCap = [...uniqueDetails]
    .sort((left, right) => Number(right.marketCap ?? -1) - Number(left.marketCap ?? -1));
  const bySymbol = [...uniqueDetails]
    .sort((left, right) => String(left.symbol).localeCompare(String(right.symbol)));
  const examples = new Map();
  for (const detail of [
    ...byMarketCap.slice(0, MAX_EXCLUSION_EXAMPLES / 2),
    ...bySymbol.slice(0, MAX_EXCLUSION_EXAMPLES / 2),
  ]) {
    examples.set(detail.id, detail);
  }
  return [...examples.values()].slice(0, MAX_EXCLUSION_EXAMPLES);
}

function summarizeExclusions(excluded, exclusionDetails = []) {
  const counts = new Map();
  for (const item of Array.isArray(excluded) ? excluded : []) {
    const reason = normalizedExclusionReason(item?.reason);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const activePairDetailsByReason = new Map();
  for (const detail of Array.isArray(exclusionDetails) ? exclusionDetails : []) {
    if (!Array.isArray(detail?.tradingPairs) || detail.tradingPairs.length === 0) continue;
    const reason = normalizedExclusionReason(detail.reason);
    const details = activePairDetailsByReason.get(reason) ?? [];
    details.push(detail);
    activePairDetailsByReason.set(reason, details);
  }
  return [...counts]
    .map(([reason, count]) => {
      const details = activePairDetailsByReason.get(reason) ?? [];
      const examples = representativeExclusions(details);
      return {
        reason,
        count,
        ...(examples.length > 0 ? {
          activePairExamples: examples.map(({ id, symbol, name, tradingPairs }) => ({
            id,
            symbol,
            name,
            tradingPairs,
          })),
          activePairExampleCount: details.length,
        } : {}),
      };
    })
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function exclusionSummaryLine({
  reason,
  count,
  activePairExamples = [],
  activePairExampleCount = 0,
}) {
  const examples = activePairExamples
    .map(({ symbol, tradingPairs }) => `\`${markdownCell(symbol)}\` (${tradingPairs.map(markdownCell).join('/')})`)
    .join(', ');
  const omittedCount = Math.max(0, activePairExampleCount - activePairExamples.length);
  const exampleText = examples
    ? ` Active-pair examples: ${examples}${omittedCount > 0 ? `, plus ${omittedCount} more` : ''}.`
    : '';
  return `- ${count}: ${reason}${exampleText}`;
}

function assertFinitePositive(value, label) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
}

function assertRevolutXQuoteEligibility(ranking) {
  const venue = ranking?.tradingVenue;
  const quoteCurrencies = Array.isArray(venue?.quoteCurrencies)
    ? venue.quoteCurrencies
    : [];
  if (venue?.name !== 'Revolut X' || venue?.region !== 'EEA'
    || quoteCurrencies.length === 0
    || !quoteCurrencies.every((currency) => currency === 'EUR' || currency === 'USD')
    || !venue?.source || !venue?.identitySource) {
    throw new Error('Diamond ranking must be verified against Revolut X EEA direct EUR or USD markets.');
  }
  if (quoteCurrencies.includes('USD')) {
    assertFinitePositive(venue.usdPerEur, 'USD per EUR exchange rate');
    if (!venue.exchangeRateSource) {
      throw new Error('USD rankings must include an exchange-rate source.');
    }
  }

  for (const asset of ranking.assets) {
    const quoteCurrency = String(asset.tradingQuoteCurrency ?? '').toUpperCase();
    const expectedPair = `${String(asset.symbol).toUpperCase()}/${quoteCurrency}`;
    if (asset.tradingVenue !== 'Revolut X' || asset.tradingRegion !== 'EEA'
      || asset.tradingPair !== expectedPair || asset.tradingPairStatus !== 'active'
      || !quoteCurrencies.includes(quoteCurrency) || !asset.tradingCurrencyName) {
      throw new Error(`${asset.id} is missing active Revolut X EEA quote-pair verification.`);
    }
    assertFinitePositive(asset.quoteOrderAmount, `${asset.id} quote order amount`);
    assertFinitePositive(asset.minOrderSizeQuote, `${asset.id} minimum ${quoteCurrency} order`);
    if (Number(asset.quoteOrderAmount) < Number(asset.minOrderSizeQuote)
      || (asset.maxOrderSizeQuote !== null
        && (!Number.isFinite(Number(asset.maxOrderSizeQuote))
          || Number(asset.quoteOrderAmount) > Number(asset.maxOrderSizeQuote)))) {
      throw new Error(`${asset.id} cannot accept the proposed ${quoteCurrency} order size on Revolut X.`);
    }
    const expectedQuoteOrderAmount = quoteCurrency === 'USD'
      ? Number(asset.investedAmount) * Number(venue.usdPerEur)
      : Number(asset.investedAmount);
    if (Math.abs(Number(asset.quoteOrderAmount) - expectedQuoteOrderAmount) > 0.000001) {
      throw new Error(`${asset.id} quote order amount does not match its EUR allocation.`);
    }
    if (quoteCurrency === 'USD'
      && Number(asset.investedAmount) > MAX_USD_INVESTMENT_EUR) {
      throw new Error(`${asset.id} USD order exceeds the EUR ${MAX_USD_INVESTMENT_EUR} maximum.`);
    }
  }
}

export function createAssetThesis(entry, context, rankedAsset) {
  const categories = [...new Set((context?.categories ?? [])
    .map(normalizeCategory)
    .filter(Boolean))]
    .slice(0, 2);
  const focus = categories.length > 0
    ? `classified by CoinGecko under ${categories.join(' and ')}`
    : 'that passed the workflow\'s lower-market-cap, liquidity, and momentum screens';
  return `Speculative exposure to ${entry.name}, ${focus}, with material volatility, liquidity, token-supply, and project-execution risk.`;
}

function resolveRankedAssetMetadata(rankings, missingIds) {
  const missingIdSet = new Set(missingIds);
  const resolvedById = new Map();
  for (const ranking of rankings) {
    if (ranking?.source !== 'CoinGecko') {
      throw new Error('Diamond ranking must use canonical CoinGecko market data.');
    }
    for (const asset of ranking.assets ?? []) {
      if (!missingIdSet.has(asset.id)) continue;
      const entry = {
        id: String(asset.id ?? '').trim(),
        symbol: String(asset.symbol ?? '').trim().toUpperCase(),
        name: String(asset.name ?? '').trim(),
      };
      if (!entry.id || !entry.symbol || !entry.name) {
        throw new Error(`CoinGecko ranking returned incomplete metadata for ${entry.id || 'an unregistered asset'}.`);
      }
      const existing = resolvedById.get(entry.id)?.entry;
      if (existing && (existing.symbol !== entry.symbol || existing.name !== entry.name)) {
        throw new Error(`CoinGecko rankings returned conflicting metadata for ${entry.id}.`);
      }
      resolvedById.set(entry.id, {
        entry,
        source: 'CoinGecko',
        context: { categories: [], description: '' },
      });
    }
  }
  return missingIds.map((id) => {
    const resolved = resolvedById.get(id);
    if (!resolved) throw new Error(`Missing ranked CoinGecko metadata for ${id}.`);
    return resolved;
  });
}

async function resolveMissingAssetMetadata(rankings, missingIds, resolveByIds, onProgress) {
  if (resolveByIds) {
    onProgress(`Verifying ${missingIds.length} unregistered ${missingIds.length === 1 ? 'asset' : 'assets'} in one CoinGecko request.`);
    const resolvedAssets = await resolveByIds(missingIds);
    onProgress(`Verified ${resolvedAssets.length} canonical CoinGecko ${resolvedAssets.length === 1 ? 'entry' : 'entries'}.`);
    return resolvedAssets;
  }
  onProgress(`Reusing canonical metadata for ${missingIds.length} unique unregistered ${missingIds.length === 1 ? 'asset' : 'assets'} from the shared live CoinGecko snapshot.`);
  return resolveRankedAssetMetadata(rankings, missingIds);
}

function renderRankingTable(assets, currency) {
  const rows = assets.map((asset) => [
    asset.rank,
    `${markdownCell(asset.symbol)} (${markdownCell(asset.name)})`,
    formatNumber(asset.quantity, 8),
    `${currency} ${formatPrice(asset.currentPrice)}`,
    `${currency} ${formatNumber(asset.marketCap, 0)}`,
    `${formatNumber(asset.priceChange7dPct)}% / ${formatNumber(asset.priceChange30dPct)}%`,
    `${markdownCell(asset.tradingPair)} (${markdownCell(asset.tradingPairStatus)}, ${markdownCell(asset.tradingRegion)})`,
    `${markdownCell(asset.tradingQuoteCurrency)} ${formatNumber(asset.quoteOrderAmount)}`,
    `${formatNumber(asset.growthMultipleToReferenceMarketCap)}x`,
    formatNumber(asset.diamondScore),
  ].join(' | '));
  return [
    '| Rank | Asset | Reference quantity | Reference price | Market cap | 7d / 30d | Revolut X market | Quote order | Headroom | Score |',
    '| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
}

function renderSelectionCutoffAudit(ranking) {
  const candidates = Array.isArray(ranking.eligibleButNotSelected)
    ? ranking.eligibleButNotSelected
    : [];
  if (candidates.length === 0) return '';
  const cutoffScore = ranking.assets.at(-1)?.diamondScore;
  const displayedCandidates = candidates.slice(0, MAX_BELOW_CUTOFF_ROWS);
  const rows = displayedCandidates.map((asset) => {
    const scores = asset.componentScores ?? {};
    return `| ${asset.rank} | ${markdownCell(asset.symbol)} (${markdownCell(asset.name)}) | ${markdownCell(asset.tradingPair)} | ${formatNumber(asset.diamondScore)} | ${formatNumber(scores.marketCapHeadroom)} / ${formatNumber(scores.quantity)} / ${formatNumber(scores.liquidity)} / ${formatNumber(scores.momentum)} / ${formatNumber(scores.supply)} |`;
  });
  const remainingCandidates = candidates.slice(displayedCandidates.length);
  const remainingIndex = remainingCandidates.length > 0
    ? `\n\nRemaining eligible ranks: ${remainingCandidates
      .map(({ rank, symbol }) => `${rank}:\`${markdownCell(symbol)}\``)
      .join(', ')}.`
    : '';
  return `### Eligible candidates below the selection cutoff

These assets passed every eligibility screen but ranked below the selected ${ranking.assets.length}. The cutoff score was ${formatNumber(cutoffScore)}.

| Overall rank | Asset | Revolut X market | Score | Headroom / quantity / liquidity / momentum / supply |
| ---: | --- | --- | ---: | ---: |
${rows.join('\n')}
${remainingIndex}`;
}

function activePairExclusions(ranking) {
  const referenceMarketCap = Number(ranking?.screen?.referenceMarketCap);
  const minMarketCap = Number(ranking?.screen?.minMarketCap);
  const hasFiniteValue = (value) => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
  const passesMarketCapFloor = (detail) => Number.isFinite(minMarketCap)
    && hasFiniteValue(detail.marketCap)
    && Number(detail.marketCap) >= minMarketCap;
  return (Array.isArray(ranking?.exclusionDetails) ? ranking.exclusionDetails : [])
    .filter((detail) => Array.isArray(detail?.tradingPairs)
      && detail.tradingPairs.length > 0
      && (!Number.isFinite(referenceMarketCap)
        || !hasFiniteValue(detail.marketCap)
        || Number(detail.marketCap) < referenceMarketCap))
    .sort((left, right) => Number(passesMarketCapFloor(right)) - Number(passesMarketCapFloor(left))
      || ['verified', 'mismatch', 'not-checked'].indexOf(left.identityStatus)
        - ['verified', 'mismatch', 'not-checked'].indexOf(right.identityStatus)
      || String(left.symbol).localeCompare(String(right.symbol))
      || String(left.id).localeCompare(String(right.id)));
}

function activePairExclusionDispositions(ranking) {
  const exclusions = activePairExclusions(ranking);
  const exclusionsByDisposition = new Map();
  for (const detail of exclusions) {
    const identityStatus = detail.identityStatus ?? 'not-checked';
    const reason = normalizedExclusionReason(detail.reason);
    const key = JSON.stringify([identityStatus, reason]);
    const disposition = exclusionsByDisposition.get(key) ?? {
      identityStatus,
      reason,
      pairs: new Map(),
    };
    const marketCapUnavailable = detail.marketCap === null || detail.marketCap === undefined
      || detail.marketCap === '' || !Number.isFinite(Number(detail.marketCap));
    for (const pair of new Set(detail.tradingPairs.map(markdownCell))) {
      disposition.pairs.set(pair, disposition.pairs.get(pair) || marketCapUnavailable);
    }
    exclusionsByDisposition.set(key, disposition);
  }
  return [...exclusionsByDisposition.values()]
    .map((disposition) => ({
      ...disposition,
      pairs: [...disposition.pairs].sort((left, right) => left[0].localeCompare(right[0])),
    }))
    .sort((left, right) => right.pairs.length - left.pairs.length
      || left.reason.localeCompare(right.reason)
      || left.identityStatus.localeCompare(right.identityStatus));
}

function renderActivePairExclusionAudit(ranking) {
  const dispositions = activePairExclusionDispositions(ranking);
  if (dispositions.length === 0) return '';
  const lines = dispositions.map(({ identityStatus, reason, pairs }) => {
    const entries = pairs.map(([pair, marketCapUnavailable]) =>
      `\`${pair}\`${marketCapUnavailable ? ' (market cap unavailable)' : ''}`);
    return `- ${markdownCell(reason)} [identity ${identityStatus}]: ${entries.join(', ')}.`;
  });
  return `<details>
<summary>Searchable active-market exclusion index</summary>

Every active requested-mode Revolut X pair associated with a CoinGecko row below the reference market cap that failed a later check is indexed here. Pair tokens are deduplicated within each disposition. Identity mismatches and not-checked identities are not treated as the venue asset.

${lines.join('\n')}

</details>`;
}

function activePairExclusionFingerprint(ranking) {
  const dispositions = activePairExclusionDispositions(ranking);
  if (dispositions.length === 0) return null;
  return JSON.stringify(dispositions.map(({ identityStatus, reason, pairs }) => [
    identityStatus,
    reason,
    pairs,
  ]));
}

export function renderDailyGemsIssue(adoptionPackage) {
  const {
    date,
    generatedAt,
    currency,
    totalInvestment,
    profilePath,
    supportedAssetsToAdd,
    profile,
    ranking,
    exclusionSummary,
  } = adoptionPackage;
  const registryJson = JSON.stringify(supportedAssetsToAdd, null, 2);
  const profileJson = JSON.stringify(profile, null, 2);
  const manifestJson = JSON.stringify({
    schemaVersion: adoptionPackage.schemaVersion,
    date,
    quoteCurrencyMode: ranking.tradingVenue.quoteCurrencyMode,
    profilePath,
  }, null, 2);
  const exclusionLines = exclusionSummary.length > 0
    ? exclusionSummary.map(exclusionSummaryLine).join('\n')
    : '- None.';
  const quoteCurrencies = ranking.tradingVenue.quoteCurrencies;
  const quoteMarketDescription = quoteCurrencies.length === 1
    ? `direct-${quoteCurrencies[0]}`
    : `direct ${quoteCurrencies.join(' or ')}`;
  const exchangeRateLine = quoteCurrencies.includes('USD')
    ? `- EUR/USD conversion: ${formatNumber(ranking.tradingVenue.usdPerEur, 6)} USD per EUR (${ranking.tradingVenue.exchangeRateSource})\n`
    : '';

  return `<!-- daily-gems:${date} -->
# Proposed real crypto-gems profile

Generated from live ${ranking.source} data at ${generatedAt}. Every candidate was also verified against an active ${quoteMarketDescription} market on ${ranking.tradingVenue.name} in ${ranking.tradingVenue.region}. This issue is an adoption package; it does not record a purchase or modify the repository.

> [!IMPORTANT]
> The quantities below are reference fills calculated from reported spot prices, and the per-asset UTC timestamps record the market snapshot rather than completed trades. Before publishing this as a real portfolio, replace them with actual executed quantities and UTC execution timestamps, then adjust the buy date if needed. Fees, spread, and slippage are not included.

> [!WARNING]
> Revolut X market availability and order limits can change. Recheck each pair immediately before placing an order; a listing verified at generation time is not an execution guarantee.

## Decision checklist

- [ ] Review the candidates, score inputs, and risks.
- [ ] Confirm a total allocation of ${currency} ${formatNumber(totalInvestment)}.
- [ ] Reconfirm every listed ${ranking.tradingVenue.name} pair is active in ${ranking.tradingVenue.region} and accepts its listed quote-order amount; any USD order must remain worth no more than EUR ${MAX_USD_INVESTMENT_EUR}.
- [ ] Replace reference quantities and UTC snapshot timestamps with actual fills.
- [ ] Add the missing registry entries below to \`data/portfolio.json\`.
- [ ] Save the profile below as \`${profilePath}\`.
- [ ] Refresh market data and run all checks.

## Ranked candidates

${renderRankingTable(ranking.assets, currency)}

${renderSelectionCutoffAudit(ranking)}

${renderActivePairExclusionAudit(ranking)}

The ${currency} 1 billion market-cap values are comparison scenarios assuming unchanged supply. They are not forecasts or price targets.

## 1. Update the supported-asset registry

Append these objects to \`supportedAssets\` in \`data/portfolio.json\`. Do not add them to \`defaultPortfolio\`. An empty array means every candidate is already registered.

\`\`\`json
${registryJson}
\`\`\`

## 2. Create the real profile

After confirming actual fills, save this object as \`${profilePath}\`:

\`\`\`json
${profileJson}
\`\`\`

## 3. Refresh and validate

\`\`\`bash
npm run update-data:force
npm run check
\`\`\`

Suggested commit:

\`feat(profiles): add ${date} crypto gems profile\`

## Screening audit

- Candidates inspected: ${ranking.candidateCount}
- Candidates eligible: ${ranking.eligibleCount}
- Discovery: top ${ranking.discovery?.marketCapCandidateLimit ?? ranking.candidateCount} CoinGecko market-cap rows plus ${ranking.discovery?.supplementalCandidateCount ?? 0} additional active-venue symbol matches
- Execution venue: ${ranking.tradingVenue.name} (${ranking.tradingVenue.region}), direct ${quoteCurrencies.join('/')} pairs only
- Pair configuration: ${ranking.tradingVenue.source}
- Currency identities: ${ranking.tradingVenue.identitySource}
${exchangeRateLine}- Ranking metric: \`${ranking.rankingMetric}\`
- Weights: ${Object.entries(ranking.weights).map(([name, weight]) => `${name} ${weight * 100}%`).join(', ')}
- Screen: market cap ${currency} ${formatNumber(ranking.screen.minMarketCap, 0)} to below ${currency} ${formatNumber(ranking.screen.referenceMarketCap, 0)}; minimum volume ${currency} ${formatNumber(ranking.screen.minTotalVolume, 0)}; minimum volume/market-cap ratio ${formatNumber(ranking.screen.minLiquidityRatio * 100)}%

Exclusions:

${exclusionLines}

<details>
<summary>Machine-readable adoption manifest</summary>

\`\`\`json
${manifestJson}
\`\`\`

</details>

This quantitative screen is not financial advice. Crypto assets can lose all value.
`;
}

export function buildDailyGemsAdoptionPackage(
  ranking,
  portfolioConfig,
  resolvedAssets = [],
  {
    expectedAssetCount = DEFAULT_LIMIT,
    profileId: profileIdInput,
    profileName: profileNameInput,
    renderIssue = true,
  } = {},
) {
  if (!ranking || !Array.isArray(ranking.assets)) {
    throw new Error('Diamond ranking is missing its assets array.');
  }
  if (ranking.assets.length !== expectedAssetCount) {
    throw new Error(`Expected ${expectedAssetCount} ranked assets but received ${ranking.assets.length}.`);
  }
  assertRevolutXQuoteEligibility(ranking);

  const generatedAt = new Date(ranking.observedAt).toISOString();
  const date = generatedAt.slice(0, 10);
  const supportedById = new Map((portfolioConfig.supportedAssets ?? [])
    .map((entry) => [entry.id, entry]));
  const resolvedById = new Map(resolvedAssets.map((result) => [result?.entry?.id, result]));
  const rankedIds = ranking.assets.map(({ id }) => id);
  if (new Set(rankedIds).size !== rankedIds.length) {
    throw new Error('Diamond ranking contains duplicate asset IDs.');
  }

  const registryEntries = ranking.assets.map((asset) => {
    assertFinitePositive(asset.investedAmount, `${asset.id} invested amount`);
    assertFinitePositive(asset.quantity, `${asset.id} quantity`);
    const supported = supportedById.get(asset.id);
    if (supported) return supported;

    const resolved = resolvedById.get(asset.id);
    if (!resolved || resolved.source !== 'CoinGecko' || resolved.entry?.id !== asset.id) {
      throw new Error(`Missing verified CoinGecko metadata for ${asset.id}.`);
    }
    if (!resolved.entry.symbol || !resolved.entry.name) {
      throw new Error(`CoinGecko returned incomplete metadata for ${asset.id}.`);
    }
    return {
      ...resolved.entry,
      thesis: createAssetThesis(resolved.entry, resolved.context, asset),
    };
  });

  const supportedAssetsToAdd = registryEntries.filter(({ id }) => !supportedById.has(id));
  const quoteCurrencyMode = String(
    ranking.tradingVenue.quoteCurrencyMode ?? DEFAULT_QUOTE_CURRENCY_MODE,
  ).toLowerCase();
  const profileId = profileIdInput ?? `gems-${quoteCurrencyMode}-${date}`;
  const profile = {
    id: profileId,
    name: profileNameInput ?? `Crypto Gems - ${date}`,
    type: 'real',
    portfolio: ranking.assets.map((asset, index) => ({
      id: asset.id,
      symbol: registryEntries[index].symbol,
      investedAmount: Number(asset.investedAmount),
      quantity: Number(asset.quantity),
      buyTimestamp: generatedAt,
    })),
  };
  const transientSupportedIds = new Set([
    ...supportedById.keys(),
    ...supportedAssetsToAdd.map(({ id }) => id),
  ]);
  if (!isValidProfile(
    profile,
    transientSupportedIds,
    portfolioConfig.defaultPortfolio ?? [],
    portfolioConfig.totalInvestment,
  )) {
    throw new Error('Generated real profile failed repository validation.');
  }

  const totalInvestment = profile.portfolio
    .reduce((total, { investedAmount }) => total + investedAmount, 0);
  const exclusionSummary = summarizeExclusions(ranking.excluded, ranking.exclusionDetails);
  const adoptionPackage = {
    schemaVersion: 3,
    date,
    generatedAt,
    source: ranking.source,
    currency: ranking.currency,
    totalInvestment,
    profilePath: `profiles/${profileId}.json`,
    supportedAssetsToAdd,
    profile,
    ranking: {
      source: ranking.source,
      tradingVenue: ranking.tradingVenue,
      investedAmountPerAsset: ranking.investedAmountPerAsset,
      candidateCount: ranking.candidateCount,
      eligibleCount: ranking.eligibleCount,
      rankingMetric: ranking.rankingMetric,
      weights: ranking.weights,
      screen: ranking.screen,
      assets: ranking.assets,
      discovery: ranking.discovery ?? null,
      eligibleButNotSelected: ranking.eligibleButNotSelected ?? [],
      exclusionDetails: ranking.exclusionDetails ?? [],
    },
    exclusionSummary,
    validation: {
      profileType: 'real',
      repositorySchema: true,
      quantitiesAreReferenceFills: true,
      revolutXEligibleQuoteMarkets: true,
      usdOrdersCappedAtEur50: true,
    },
  };
  if (!renderIssue) return adoptionPackage;
  const issueBody = renderDailyGemsIssue(adoptionPackage);
  if (issueBody.length > MAX_GENERATED_ISSUE_BODY_CHARACTERS) {
    throw new Error(`Daily gems issue body has ${issueBody.length} characters and exceeds the ${MAX_GENERATED_ISSUE_BODY_CHARACTERS}-character generation limit reserved for publication changes.`);
  }
  return {
    ...adoptionPackage,
    issueTitle: `[Daily Gems] ${date} - Proposed ${ranking.currency} ${formatNumber(totalInvestment)} real profile`,
    issueBody,
  };
}

function renderConsolidatedModeSection(adoptionPackage, duplicateExclusionAuditMode = null) {
  const { currency, profilePath, profile, ranking, exclusionSummary } = adoptionPackage;
  const mode = ranking.tradingVenue.quoteCurrencyMode;
  const modeLabel = mode === 'MIXED' ? 'MIXED (EUR preferred)' : `${mode}-only`;
  const quoteCurrencies = ranking.tradingVenue.quoteCurrencies;
  const exchangeRateLine = quoteCurrencies.includes('USD')
    ? `- EUR/USD conversion: ${formatNumber(ranking.tradingVenue.usdPerEur, 6)} USD per EUR (${ranking.tradingVenue.exchangeRateSource})\n`
    : '';
  const displayedExclusions = exclusionSummary.slice(0, 8);
  const omittedExclusions = exclusionSummary.slice(displayedExclusions.length);
  const omittedCount = omittedExclusions
    .reduce((total, { count }) => total + count, 0);
  const exclusionLines = [
    ...displayedExclusions.map(exclusionSummaryLine),
    ...(omittedExclusions.length > 0
      ? [`- ${omittedCount}: ${omittedExclusions.length} additional exclusion reasons omitted from this compact issue.`]
      : []),
  ].join('\n') || '- None.';
  const activePairExclusionAudit = duplicateExclusionAuditMode
    ? `<details>
<summary>Searchable active-market exclusion index</summary>

The asset dispositions match the ${duplicateExclusionAuditMode} option; see that option's table above.

</details>`
    : renderActivePairExclusionAudit(ranking);

  return `## ${modeLabel} option

Target profile: \`${profilePath}\`

${renderRankingTable(ranking.assets, currency)}

${renderSelectionCutoffAudit(ranking)}

${activePairExclusionAudit}

### ${modeLabel} profile JSON

After confirming actual fills, save this profile as \`${profilePath}\`:

\`\`\`json
${JSON.stringify(profile, null, 2)}
\`\`\`

### ${modeLabel} screening audit

- Candidates inspected: ${ranking.candidateCount}
- Candidates eligible: ${ranking.eligibleCount}
- Discovery: top ${ranking.discovery?.marketCapCandidateLimit ?? ranking.candidateCount} CoinGecko market-cap rows plus ${ranking.discovery?.supplementalCandidateCount ?? 0} additional active-venue symbol matches
- Execution pairs: direct ${quoteCurrencies.join('/')} on ${ranking.tradingVenue.name} (${ranking.tradingVenue.region})
${exchangeRateLine}- Ranking metric: \`${ranking.rankingMetric}\`

Exclusions:

${exclusionLines}`;
}

export function renderConsolidatedDailyGemsIssue(consolidatedPackage) {
  const {
    date,
    generatedAt,
    currency,
    totalInvestmentPerProfile,
    supportedAssetsToAdd,
    modePackages,
  } = consolidatedPackage;
  const overviewRows = modePackages.map(({ profilePath, ranking }) => {
    const eurHoldings = ranking.assets.filter(({ tradingQuoteCurrency }) =>
      tradingQuoteCurrency === 'EUR').length;
    const usdHoldings = ranking.assets.length - eurHoldings;
    return `| ${ranking.tradingVenue.quoteCurrencyMode} | ${ranking.eligibleCount} | ${eurHoldings} | ${usdHoldings} | \`${profilePath}\` |`;
  });
  const profilePaths = modePackages.map(({ profilePath }) => profilePath);
  const compactManifest = {
    schemaVersion: consolidatedPackage.schemaVersion,
    date,
    quoteCurrencyModes: consolidatedPackage.quoteCurrencyModes,
    profilePaths,
  };
  const firstModeByExclusionFingerprint = new Map();
  const modeSections = modePackages.map((adoptionPackage) => {
    const fingerprint = activePairExclusionFingerprint(adoptionPackage.ranking);
    const duplicateMode = fingerprint
      ? firstModeByExclusionFingerprint.get(fingerprint) ?? null
      : null;
    if (fingerprint && !duplicateMode) {
      firstModeByExclusionFingerprint.set(
        fingerprint,
        adoptionPackage.ranking.tradingVenue.quoteCurrencyMode,
      );
    }
    return renderConsolidatedModeSection(adoptionPackage, duplicateMode);
  });

  return `<!-- daily-gems:${date} -->
# Proposed EUR, USD, and mixed crypto-gems profiles

Generated from one shared live CoinGecko and Revolut X snapshot at ${generatedAt}. This issue compares three independently validated execution modes: EUR-only, USD-only, and mixed with EUR preferred. It does not record a purchase or modify the repository.

> [!IMPORTANT]
> Each option allocates ${currency} ${formatNumber(totalInvestmentPerProfile)} using reference fills. Its per-asset UTC timestamps identify the shared market snapshot, not completed trades. Choose one profile, then replace its quantities and timestamps with actual fills before publishing it. Fees, spread, and slippage are not included.

> [!WARNING]
> Revolut X market availability, exchange rates, and order limits can change. Recheck each selected pair immediately before ordering. Every USD order is capped at a EUR ${MAX_USD_INVESTMENT_EUR} equivalent.

## Decision checklist

- [ ] Compare the EUR-only, USD-only, and mixed rankings below.
- [ ] Choose one profile; do not combine the three ${currency} ${formatNumber(totalInvestmentPerProfile)} allocations unless separately intended.
- [ ] Reconfirm every selected Revolut X pair and quote-order amount.
- [ ] Replace reference quantities and UTC snapshot timestamps with actual fills.
- [ ] Add the required registry entries below to \`data/portfolio.json\`.
- [ ] Save only the chosen profile at its listed path.
- [ ] Refresh market data and run all checks.

## Options overview

| Mode | Eligible candidates | EUR holdings | USD holdings | Profile path |
| --- | ---: | ---: | ---: | --- |
${overviewRows.join('\n')}

${modeSections.join('\n\n')}

## Supported-asset registry additions

Append these deduplicated objects to \`supportedAssets\` in \`data/portfolio.json\`. Do not add them to \`defaultPortfolio\`. The set covers all three options; adding an unused entry only registers the asset and does not add it to a portfolio.

\`\`\`json
${JSON.stringify(supportedAssetsToAdd, null, 2)}
\`\`\`

## Refresh and validate

\`\`\`bash
npm run update-data:force
npm run check
\`\`\`

Suggested commit:

\`feat(profiles): add ${date} crypto gems profile\`

<details>
<summary>Machine-readable option summary</summary>

\`\`\`json
${JSON.stringify(compactManifest, null, 2)}
\`\`\`

</details>

This quantitative screen is not financial advice. Crypto assets can lose all value.
`;
}

export function buildConsolidatedDailyGemsAdoptionPackage(
  rankings,
  portfolioConfig,
  resolvedAssets = [],
  { expectedAssetCount = DEFAULT_LIMIT } = {},
) {
  if (!Array.isArray(rankings) || rankings.length !== CONSOLIDATED_QUOTE_CURRENCY_MODES.length) {
    throw new Error('Consolidated daily gems require EUR, USD, and MIXED rankings.');
  }
  const rankingByMode = new Map(rankings.map((ranking) => [
    ranking?.tradingVenue?.quoteCurrencyMode,
    ranking,
  ]));
  if (rankingByMode.size !== CONSOLIDATED_QUOTE_CURRENCY_MODES.length
    || !CONSOLIDATED_QUOTE_CURRENCY_MODES.every((mode) => rankingByMode.has(mode))) {
    throw new Error('Consolidated daily gems require one ranking for each of EUR, USD, and MIXED.');
  }

  const modePackages = CONSOLIDATED_QUOTE_CURRENCY_MODES.map((mode) => {
    const ranking = rankingByMode.get(mode);
    const date = new Date(ranking.observedAt).toISOString().slice(0, 10);
    const result = buildDailyGemsAdoptionPackage(
      ranking,
      portfolioConfig,
      resolvedAssets,
      {
        expectedAssetCount,
        profileId: `gems-${mode.toLowerCase()}-${date}`,
        profileName: `Crypto Gems ${mode} - ${date}`,
        renderIssue: false,
      },
    );
    return result;
  });
  const dates = new Set(modePackages.map(({ date }) => date));
  if (dates.size !== 1) {
    throw new Error('Consolidated rankings must use the same UTC date.');
  }
  const supportedAssetsById = new Map();
  for (const { supportedAssetsToAdd } of modePackages) {
    for (const entry of supportedAssetsToAdd) supportedAssetsById.set(entry.id, entry);
  }
  const [firstPackage] = modePackages;
  const consolidatedPackage = {
    schemaVersion: 4,
    date: firstPackage.date,
    generatedAt: firstPackage.generatedAt,
    source: firstPackage.source,
    currency: firstPackage.currency,
    quoteCurrencyModes: [...CONSOLIDATED_QUOTE_CURRENCY_MODES],
    totalInvestmentPerProfile: firstPackage.totalInvestment,
    profilePaths: modePackages.map(({ profilePath }) => profilePath),
    supportedAssetsToAdd: [...supportedAssetsById.values()],
    modePackages,
    validation: {
      oneDailyIssue: true,
      sharedMarketSnapshot: new Set(modePackages.map(({ generatedAt }) => generatedAt)).size === 1,
      repositorySchema: true,
      quantitiesAreReferenceFills: true,
      usdOrdersCappedAtEur50: true,
    },
  };
  const issueBody = renderConsolidatedDailyGemsIssue(consolidatedPackage);
  if (issueBody.length > MAX_GENERATED_ISSUE_BODY_CHARACTERS) {
    throw new Error(`Consolidated issue body has ${issueBody.length} characters and exceeds the ${MAX_GENERATED_ISSUE_BODY_CHARACTERS}-character generation limit reserved for publication changes.`);
  }
  return {
    ...consolidatedPackage,
    issueTitle: `[Daily Gems] ${firstPackage.date} - EUR, USD, and MIXED profile options`,
    issueBody,
  };
}

export async function generateConsolidatedDailyGemsIssue(portfolioConfig, {
  investedAmount = DEFAULT_INVESTED_AMOUNT,
  limit = DEFAULT_LIMIT,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
  getRankings = getDiamondQuantitiesForQuoteModes,
  resolveByIds,
  onProgress = () => {},
} = {}) {
  onProgress(`Screening one live snapshot for EUR, USD, and MIXED modes with ${limit} positions each.`);
  const rankings = await getRankings(
    portfolioConfig,
    CONSOLIDATED_QUOTE_CURRENCY_MODES,
    { investedAmount, limit, candidateLimit },
  );
  const incompleteRanking = rankings.find(({ assets }) => assets.length !== Number(limit));
  if (incompleteRanking) {
    throw new Error(`Expected ${limit} ${incompleteRanking.tradingVenue.quoteCurrencyMode} assets but received ${incompleteRanking.assets.length}.`);
  }
  onProgress('Selected complete EUR, USD, and MIXED rankings from the shared snapshot.');
  const supportedIds = new Set((portfolioConfig.supportedAssets ?? []).map(({ id }) => id));
  const missingIds = [...new Set(rankings
    .flatMap(({ assets }) => assets.map(({ id }) => id))
    .filter((id) => !supportedIds.has(id)))];
  const resolvedAssets = await resolveMissingAssetMetadata(
    rankings,
    missingIds,
    resolveByIds,
    onProgress,
  );
  const result = buildConsolidatedDailyGemsAdoptionPackage(
    rankings,
    portfolioConfig,
    resolvedAssets,
    { expectedAssetCount: Number(limit) },
  );
  onProgress(`Consolidated three validated profiles into one ${result.issueBody.length}-character issue.`);
  return result;
}

export async function generateDailyGemsIssue(portfolioConfig, {
  investedAmount = DEFAULT_INVESTED_AMOUNT,
  limit = DEFAULT_LIMIT,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
  quoteCurrencyMode = DEFAULT_QUOTE_CURRENCY_MODE,
  getRanking = getDiamondQuantities,
  resolveByIds,
  onProgress = () => {},
} = {}) {
  const requestedQuoteMode = String(quoteCurrencyMode).trim().toUpperCase();
  const normalizedQuoteMode = requestedQuoteMode === 'DOLLAR' || requestedQuoteMode === 'DOLLARS'
    ? 'USD'
    : requestedQuoteMode === 'MIX' ? 'MIXED' : requestedQuoteMode;
  const quoteDescription = normalizedQuoteMode === 'MIXED'
    ? 'EUR-preferred EUR/USD'
    : normalizedQuoteMode;
  onProgress(`Screening up to ${candidateLimit} CoinGecko candidates against Revolut X EEA ${quoteDescription} markets for ${limit} positions.`);
  const ranking = await getRanking(portfolioConfig, {
    investedAmount,
    limit,
    candidateLimit,
    quoteCurrencyMode,
  });
  if (ranking.assets.length !== Number(limit)) {
    throw new Error(`Expected ${limit} ranked assets but received ${ranking.assets.length}.`);
  }

  onProgress(`Selected ${ranking.assets.length} assets from ${ranking.eligibleCount} candidates with verified direct ${quoteDescription} markets.`);
  const supportedIds = new Set((portfolioConfig.supportedAssets ?? []).map(({ id }) => id));
  const missingIds = ranking.assets.map(({ id }) => id).filter((id) => !supportedIds.has(id));
  const resolvedAssets = await resolveMissingAssetMetadata(
    [ranking],
    missingIds,
    resolveByIds,
    onProgress,
  );
  const result = buildDailyGemsAdoptionPackage(ranking, portfolioConfig, resolvedAssets, {
    expectedAssetCount: Number(limit),
  });
  onProgress(`Validated ${result.profile.portfolio.length} holdings for ${result.profilePath}.`);
  return result;
}

function parseArguments(args) {
  const options = {};
  const values = [...args];
  while (values.length > 0) {
    const argument = values.shift();
    const value = values.shift();
    if (!value) throw new Error(`${argument} requires a value.`);
    if (argument === '--output') options.output = value;
    else if (argument === '--summary-output') options.summaryOutput = value;
    else if (argument === '--amount') options.investedAmount = value;
    else if (argument === '--limit') options.limit = value;
    else if (argument === '--candidate-limit') options.candidateLimit = value;
    else if (argument === '--quote-mode') options.quoteCurrencyMode = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main(args) {
  const { output, summaryOutput, ...generationOptions } = parseArguments(args);
  const progress = (message) => console.error(`[daily-gems] ${message}`);
  progress('Loading portfolio configuration.');
  const portfolioConfig = JSON.parse(await readFile(
    path.join(root, 'data', 'portfolio.json'),
    'utf8',
  ));
  const quoteCurrencyMode = String(
    generationOptions.quoteCurrencyMode ?? DEFAULT_QUOTE_CURRENCY_MODE,
  ).trim().toUpperCase();
  const generateIssue = quoteCurrencyMode === 'ALL'
    ? generateConsolidatedDailyGemsIssue
    : generateDailyGemsIssue;
  const result = await generateIssue(portfolioConfig, {
    ...generationOptions,
    onProgress: progress,
  });
  if (output) {
    const outputPath = path.resolve(output);
    await writeFile(outputPath, result.issueBody);
    progress(`Wrote ${Buffer.byteLength(result.issueBody)}-byte issue body to ${outputPath}.`);
  }
  else console.log(result.issueBody);
  if (summaryOutput) {
    const summaryPath = path.resolve(summaryOutput);
    await writeFile(summaryPath, `${JSON.stringify({
      issueTitle: result.issueTitle,
      date: result.date,
      ...(result.profilePath ? { profilePath: result.profilePath } : {}),
      ...(result.profilePaths ? { profilePaths: result.profilePaths } : {}),
      ...(result.quoteCurrencyModes ? { quoteCurrencyModes: result.quoteCurrencyModes } : {}),
    }, null, 2)}\n`);
    progress(`Wrote publication summary to ${summaryPath}.`);
  }
  progress('Daily gems adoption package is ready.');
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}