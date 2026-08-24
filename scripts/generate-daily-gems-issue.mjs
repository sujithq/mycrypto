import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getDiamondQuantities } from '../.github/skills/diamond-quantities/scripts/rank-diamond-quantities.mjs';
import { resolveSupportedAssetById } from '../.github/skills/supported-asset-entry/scripts/resolve-supported-asset.mjs';
import { isValidProfile } from '../src/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INVESTED_AMOUNT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 1_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

function summarizeExclusions(excluded) {
  const counts = new Map();
  for (const item of Array.isArray(excluded) ? excluded : []) {
    const reason = String(item?.reason ?? 'Unknown exclusion reason.');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

function assertFinitePositive(value, label) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive number.`);
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

function renderRankingTable(assets, currency) {
  const rows = assets.map((asset) => [
    asset.rank,
    `${markdownCell(asset.symbol)} (${markdownCell(asset.name)})`,
    formatNumber(asset.quantity, 8),
    `${currency} ${formatPrice(asset.currentPrice)}`,
    `${currency} ${formatNumber(asset.marketCap, 0)}`,
    `${formatNumber(asset.priceChange7dPct)}% / ${formatNumber(asset.priceChange30dPct)}%`,
    `${formatNumber(asset.growthMultipleToReferenceMarketCap)}x`,
    formatNumber(asset.diamondScore),
  ].join(' | '));
  return [
    '| Rank | Asset | Reference quantity | Reference price | Market cap | 7d / 30d | Headroom | Score |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row} |`),
  ].join('\n');
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
  const manifestJson = JSON.stringify(adoptionPackage, null, 2);
  const exclusionLines = exclusionSummary.length > 0
    ? exclusionSummary.map(({ reason, count }) => `- ${count}: ${reason}`).join('\n')
    : '- None.';

  return `<!-- daily-gems:${date} -->
# Proposed real crypto-gems profile

Generated from live ${ranking.source} data at ${generatedAt}. This issue is an adoption package; it does not record a purchase or modify the repository.

> [!IMPORTANT]
> The quantities below are reference fills calculated from reported spot prices. Before publishing this as a real portfolio, replace them with actual executed quantities and adjust the buy date if needed. Fees, spread, and slippage are not included.

## Decision checklist

- [ ] Review the candidates, score inputs, and risks.
- [ ] Confirm a total allocation of ${currency} ${formatNumber(totalInvestment)}.
- [ ] Replace reference quantities with actual filled quantities.
- [ ] Add the missing registry entries below to \`data/portfolio.json\`.
- [ ] Save the profile below as \`${profilePath}\`.
- [ ] Refresh market data and run all checks.

## Ranked candidates

${renderRankingTable(ranking.assets, currency)}

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
- Ranking metric: \`${ranking.rankingMetric}\`
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
  { expectedAssetCount = DEFAULT_LIMIT } = {},
) {
  if (!ranking || !Array.isArray(ranking.assets)) {
    throw new Error('Diamond ranking is missing its assets array.');
  }
  if (ranking.assets.length !== expectedAssetCount) {
    throw new Error(`Expected ${expectedAssetCount} ranked assets but received ${ranking.assets.length}.`);
  }

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
  const profileId = `gems-${date}`;
  const profile = {
    id: profileId,
    name: `Crypto Gems - ${date}`,
    type: 'real',
    buyDate: date,
    portfolio: ranking.assets.map((asset, index) => ({
      ...registryEntries[index],
      investedAmount: Number(asset.investedAmount),
      quantity: Number(asset.quantity),
      buyDate: date,
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
  const exclusionSummary = summarizeExclusions(ranking.excluded);
  const adoptionPackage = {
    schemaVersion: 1,
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
      candidateCount: ranking.candidateCount,
      eligibleCount: ranking.eligibleCount,
      rankingMetric: ranking.rankingMetric,
      weights: ranking.weights,
      screen: ranking.screen,
      assets: ranking.assets,
    },
    exclusionSummary,
    validation: {
      profileType: 'real',
      repositorySchema: true,
      quantitiesAreReferenceFills: true,
    },
  };
  return {
    ...adoptionPackage,
    issueTitle: `[Daily Gems] ${date} - Proposed ${ranking.currency} ${formatNumber(totalInvestment)} real profile`,
    issueBody: renderDailyGemsIssue(adoptionPackage),
  };
}

export async function generateDailyGemsIssue(portfolioConfig, {
  investedAmount = DEFAULT_INVESTED_AMOUNT,
  limit = DEFAULT_LIMIT,
  candidateLimit = DEFAULT_CANDIDATE_LIMIT,
  metadataDelayMs = 1_000,
  getRanking = getDiamondQuantities,
  resolveById = resolveSupportedAssetById,
  sleepImpl = sleep,
} = {}) {
  const ranking = await getRanking(portfolioConfig, {
    investedAmount,
    limit,
    candidateLimit,
  });
  if (ranking.assets.length !== Number(limit)) {
    throw new Error(`Expected ${limit} ranked assets but received ${ranking.assets.length}.`);
  }

  const supportedIds = new Set((portfolioConfig.supportedAssets ?? []).map(({ id }) => id));
  const missingIds = ranking.assets.map(({ id }) => id).filter((id) => !supportedIds.has(id));
  const resolvedAssets = [];
  for (const [index, id] of missingIds.entries()) {
    resolvedAssets.push(await resolveById(id));
    if (metadataDelayMs > 0 && index < missingIds.length - 1) {
      await sleepImpl(metadataDelayMs);
    }
  }
  return buildDailyGemsAdoptionPackage(ranking, portfolioConfig, resolvedAssets, {
    expectedAssetCount: Number(limit),
  });
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
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main(args) {
  const { output, summaryOutput, ...generationOptions } = parseArguments(args);
  const portfolioConfig = JSON.parse(await readFile(
    path.join(root, 'data', 'portfolio.json'),
    'utf8',
  ));
  const result = await generateDailyGemsIssue(portfolioConfig, generationOptions);
  if (output) await writeFile(path.resolve(output), result.issueBody);
  else console.log(result.issueBody);
  if (summaryOutput) {
    await writeFile(path.resolve(summaryOutput), `${JSON.stringify({
      issueTitle: result.issueTitle,
      date: result.date,
      profilePath: result.profilePath,
    }, null, 2)}\n`);
  }
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}