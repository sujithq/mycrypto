import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConsolidatedDailyGemsAdoptionPackage,
  buildDailyGemsAdoptionPackage,
  generateConsolidatedDailyGemsIssue,
  generateDailyGemsIssue,
} from '../scripts/generate-daily-gems-issue.mjs';

const portfolioConfig = {
  currency: 'eur',
  totalInvestment: 100,
  defaultPortfolio: [],
  supportedAssets: [{
    id: 'established',
    symbol: 'EST',
    name: 'Established',
    thesis: 'Existing registry thesis.',
  }],
};

function rankedAsset(overrides) {
  return {
    rank: 1,
    id: 'new-coin',
    symbol: 'NEW',
    name: 'New Coin',
    thesis: null,
    isSupported: false,
    tradingPair: 'NEW/EUR',
    tradingVenue: 'Revolut X',
    tradingRegion: 'EEA',
    tradingPairStatus: 'active',
    tradingCurrencyName: 'New Coin',
    tradingQuoteCurrency: 'EUR',
    quoteOrderAmount: 50,
    minOrderSizeQuote: 0.1,
    maxOrderSizeQuote: 1_000_000,
    investedAmount: 50,
    quantity: 50_000,
    buyDate: '2026-08-24',
    buyTimestamp: '2026-08-24T12:00:00.000Z',
    currentPrice: 0.001,
    marketCap: 10_000_000,
    marketCapRank: 500,
    totalVolume: 2_000_000,
    liquidityRatio: 0.2,
    priceChange7dPct: 10,
    priceChange30dPct: 20,
    circulatingSupply: 90_000_000,
    supplyDenominator: 100_000_000,
    supplyBasis: 'maxSupply',
    circulatingSupplyRatio: 0.9,
    referenceMarketCap: 1_000_000_000,
    growthMultipleToReferenceMarketCap: 100,
    potentialValueAtReferenceMarketCap: 5_000,
    componentScores: {
      marketCapHeadroom: 100,
      quantity: 100,
      liquidity: 100,
      momentum: 62.5,
      supply: 90,
    },
    diamondScore: 93.375,
    lastUpdated: '2026-08-24T11:59:00.000Z',
    ...overrides,
  };
}

function ranking() {
  return {
    currency: 'EUR',
    investedAmountPerAsset: 50,
    requestedLimit: 2,
    candidateCount: 1_000,
    eligibleCount: 600,
    observedAt: '2026-08-24T12:00:00.000Z',
    source: 'CoinGecko',
    tradingVenue: {
      name: 'Revolut X',
      region: 'EEA',
      source: 'https://revx.revolut.com/api/1.0/public/configuration/pairs?region=EEA',
      identitySource: 'https://revx.revolut.com/api/1.0/public/configuration/currencies?region=EEA',
      quoteCurrencyMode: 'EUR',
      quoteCurrencies: ['EUR'],
      quoteCurrency: 'EUR',
      usdPerEur: null,
      exchangeRateSource: null,
    },
    rankingMetric: 'diamondScore',
    weights: {
      marketCapHeadroom: 0.3,
      quantity: 0.25,
      liquidity: 0.2,
      momentum: 0.15,
      supply: 0.1,
    },
    screen: {
      minMarketCap: 10_000_000,
      referenceMarketCap: 1_000_000_000,
      minTotalVolume: 100_000,
      minLiquidityRatio: 0.01,
      maxUsdInvestmentEur: 50,
    },
    assets: [
      rankedAsset({ rank: 1 }),
      rankedAsset({
        rank: 2,
        id: 'established',
        symbol: 'EST',
        name: 'API Name',
        isSupported: true,
        tradingPair: 'EST/EUR',
        tradingCurrencyName: 'Established',
        quantity: 25,
        currentPrice: 2,
      }),
    ],
    eligibleButNotSelected: [],
    excluded: [
      { id: 'dry-one', reason: 'Trading volume is below 100000.' },
      { id: 'dry-two', reason: 'Trading volume is below 100000.' },
    ],
    exclusionDetails: [],
  };
}

const resolvedNewCoin = {
  entry: { id: 'new-coin', symbol: 'NEW', name: 'New Coin' },
  source: 'CoinGecko',
  context: {
    categories: ['Layer 1', 'Smart Contract Platform'],
    description: 'A test network.',
  },
};

function rankingForMode(mode) {
  const result = structuredClone(ranking());
  const includesUsd = mode !== 'EUR';
  result.tradingVenue = {
    ...result.tradingVenue,
    quoteCurrencyMode: mode,
    quoteCurrencies: mode === 'MIXED' ? ['EUR', 'USD'] : [mode],
    quoteCurrency: mode === 'MIXED' ? null : mode,
    usdPerEur: includesUsd ? 1.2 : null,
    exchangeRateSource: includesUsd
      ? 'https://api.coingecko.com/api/v3/exchange_rates'
      : null,
  };
  result.assets = result.assets.map((asset, index) => {
    const quoteCurrency = mode === 'USD' || (mode === 'MIXED' && index === 0)
      ? 'USD'
      : 'EUR';
    return {
      ...asset,
      tradingPair: `${asset.symbol}/${quoteCurrency}`,
      tradingQuoteCurrency: quoteCurrency,
      quoteOrderAmount: quoteCurrency === 'USD' ? 60 : 50,
    };
  });
  return result;
}

test('builds a complete adoption package for a valid real profile', () => {
  const result = buildDailyGemsAdoptionPackage(
    ranking(),
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.equal(result.profilePath, 'profiles/gems-eur-2026-08-24.json');
  assert.equal(result.profile.type, 'real');
  assert.equal(result.profile.portfolio.length, 2);
  assert.equal(Object.hasOwn(result.profile, 'buyDate'), false);
  assert.deepEqual(result.profile.portfolio[0], {
    id: 'new-coin',
    symbol: 'NEW',
    investedAmount: 50,
    quantity: 50_000,
    buyTimestamp: '2026-08-24T12:00:00.000Z',
  });
  assert.deepEqual(Object.keys(result.profile.portfolio[1]), [
    'id',
    'symbol',
    'investedAmount',
    'quantity',
    'buyTimestamp',
  ]);
  assert.equal(result.totalInvestment, 100);
  assert.equal(result.validation.repositorySchema, true);
  assert.equal(result.validation.revolutXEligibleQuoteMarkets, true);
  assert.equal(result.validation.usdOrdersCappedAtEur50, true);
  assert.deepEqual(result.supportedAssetsToAdd.map(({ id }) => id), ['new-coin']);
  assert.match(result.supportedAssetsToAdd[0].thesis, /Layer 1 and Smart Contract Platform/);
  assert.equal(result.ranking.assets[0].tradingPair, 'NEW/EUR');
  assert.equal(result.ranking.investedAmountPerAsset, 50);
  assert.deepEqual(result.exclusionSummary, [
    { reason: 'Trading volume is below 100000.', count: 2 },
  ]);
  assert.match(result.issueBody, /data\/portfolio\.json/);
  assert.match(result.issueBody, /profiles\/gems-eur-2026-08-24\.json/);
  assert.match(result.issueBody, /"type": "real"/);
  assert.match(result.issueBody, /snapshot rather than completed trades/);
  assert.match(result.issueBody, /Machine-readable adoption manifest/);
  assert.match(result.issueBody, /active direct-EUR market on Revolut X in EEA/);
  assert.match(result.issueBody, /NEW\/EUR \(active, EEA\)/);
  assert.doesNotMatch(result.issueBody, /EUR NaN/);
  assert.doesNotMatch(result.issueBody, /"type": "simulated"/);
});

test('publishes why eligible and active-pair assets missed selection', () => {
  const auditedRanking = ranking();
  auditedRanking.eligibleButNotSelected = [{
    rank: 3,
    id: 'near-cutoff',
    symbol: 'NEAR',
    name: 'Near Cutoff',
    tradingPair: 'NEAR/EUR',
    marketCap: 20_000_000,
    diamondScore: 80,
    componentScores: {
      marketCapHeadroom: 90,
      quantity: 80,
      liquidity: 70,
      momentum: 60,
      supply: 50,
    },
  }];
  auditedRanking.exclusionDetails = [{
    id: 'dry-one',
    symbol: 'DRY',
    name: 'Dry One',
    marketCap: 12_000_000,
    tradingPairs: ['DRY/EUR'],
    identityStatus: 'verified',
    reason: 'Trading volume is below 100000.',
  }, {
    id: 'measurable-data-token',
    symbol: 'MDT',
    name: 'Measurable Data',
    marketCap: 13_000_000,
    tradingPairs: ['MDT/USD'],
    identityStatus: 'mismatch',
    reason: 'CoinGecko identity Measurable Data (MDT) does not match Revolut X META DANCE (MDT).',
  }];

  const result = buildDailyGemsAdoptionPackage(
    auditedRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.match(result.issueBody, /Eligible candidates below the selection cutoff/);
  assert.match(result.issueBody, /\| 3 \| NEAR \(Near Cutoff\) \| NEAR\/EUR \| 80 \|/);
  assert.match(result.issueBody, /Active-pair examples: `DRY` \(DRY\/EUR\)\./);
  assert.match(result.issueBody, /Searchable active-market exclusion index/);
  assert.match(result.issueBody, /Trading volume is below 100000\. \[identity verified\]: `DRY\/EUR`\./);
  assert.match(result.issueBody, /CoinGecko identity does not match the active venue currency identity\. \[identity mismatch\]: `MDT\/USD`\./);
  assert.doesNotMatch(result.issueBody, /"ranking":/);
  assert.ok(result.issueBody.length <= 57_536);
  assert.deepEqual(result.ranking.eligibleButNotSelected, auditedRanking.eligibleButNotSelected);
});

test('renders a null exclusion market cap as unavailable', () => {
  const auditedRanking = ranking();
  auditedRanking.excluded = [{
    id: 'missing-cap',
    reason: 'Market capitalization is below 10000000.',
  }];
  auditedRanking.exclusionDetails = [{
    id: 'missing-cap',
    symbol: 'NOCAP',
    name: 'No Cap',
    marketCap: null,
    tradingPairs: ['NOCAP/EUR'],
    identityStatus: 'verified',
    reason: 'Market capitalization is below 10000000.',
  }];

  const result = buildDailyGemsAdoptionPackage(
    auditedRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.match(result.issueBody, /`NOCAP\/EUR` \(market cap unavailable\)/);
  assert.doesNotMatch(result.issueBody, /NOCAP[^\n]*EUR 0/);
});

test('keeps every below-cutoff and active-market exclusion ticker searchable', () => {
  const auditedRanking = ranking();
  auditedRanking.eligibleButNotSelected = Array.from({ length: 45 }, (_, index) => ({
    rank: index + 3,
    id: `eligible-${index}`,
    symbol: `ELIG${index}`,
    name: `Eligible ${index}`,
    tradingPair: `ELIG${index}/EUR`,
    marketCap: 20_000_000,
    diamondScore: 80 - index / 10,
    componentScores: {
      marketCapHeadroom: 90,
      quantity: 80,
      liquidity: 70,
      momentum: 60,
      supply: 50,
    },
  }));
  auditedRanking.excluded = Array.from({ length: 140 }, (_, index) => ({
    id: `excluded-${index}`,
    reason: 'Trading volume is below 100000.',
  }));
  auditedRanking.exclusionDetails = Array.from({ length: 140 }, (_, index) => ({
    id: `excluded-${index}`,
    symbol: `EXCL${index}`,
    name: `Excluded ${index}`,
    marketCap: 12_000_000,
    tradingPairs: [`EXCL${index}/EUR`],
    identityStatus: 'verified',
    reason: 'Trading volume is below 100000.',
  }));

  const result = buildDailyGemsAdoptionPackage(
    auditedRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  for (const { symbol } of auditedRanking.eligibleButNotSelected) {
    assert.match(result.issueBody, new RegExp(`\\b${symbol}\\b`));
  }
  for (const { symbol } of auditedRanking.exclusionDetails) {
    assert.match(result.issueBody, new RegExp(`\\b${symbol}\\b`));
  }
  assert.doesNotMatch(result.issueBody, /additional eligible candidates|active-market exclusions omitted/);
  assert.ok(result.issueBody.length <= 57_536);
});

test('rejects a generated issue that would consume the publication reserve', () => {
  const oversizedRanking = ranking();
  const excludedCandidateCount = 4_000;
  oversizedRanking.excluded = Array.from({ length: excludedCandidateCount }, (_, index) => ({
    id: `excluded-${index}`,
    reason: 'Trading volume is below 100000.',
  }));
  oversizedRanking.exclusionDetails = Array.from({ length: excludedCandidateCount }, (_, index) => ({
    id: `excluded-${index}`,
    symbol: `EXCLUSION${index}`,
    name: `Excluded active market candidate ${index}`,
    marketCap: 12_000_000,
    tradingPairs: [`EXCLUSION${index}/EUR`],
    identityStatus: 'verified',
    reason: 'Trading volume is below 100000.',
  }));

  assert.throws(() => buildDailyGemsAdoptionPackage(
    oversizedRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  ), /generation limit reserved for publication changes/);
});

test('resolves only candidates missing from the local registry', async () => {
  const resolvedIds = [];
  const progress = [];
  const result = await generateDailyGemsIssue(portfolioConfig, {
    limit: 2,
    getRanking: async () => ranking(),
    resolveByIds: async (ids) => {
      resolvedIds.push(...ids);
      return [resolvedNewCoin];
    },
    onProgress: (message) => progress.push(message),
  });

  assert.deepEqual(resolvedIds, ['new-coin']);
  assert.deepEqual(progress, [
    'Screening up to 1000 CoinGecko candidates against Revolut X EEA EUR markets for 2 positions.',
    'Selected 2 assets from 600 candidates with verified direct EUR markets.',
    'Verifying 1 unregistered asset in one CoinGecko request.',
    'Verified 1 canonical CoinGecko entry.',
    'Validated 2 holdings for profiles/gems-eur-2026-08-24.json.',
  ]);
  assert.equal(result.issueTitle, '[Daily Gems] 2026-08-24 - Proposed EUR 100 real profile');
});

test('forwards mixed quote mode to the ranker', async () => {
  const mixedRanking = ranking();
  mixedRanking.tradingVenue = {
    ...mixedRanking.tradingVenue,
    quoteCurrencyMode: 'MIXED',
    quoteCurrencies: ['EUR', 'USD'],
    quoteCurrency: null,
    usdPerEur: 1.2,
    exchangeRateSource: 'https://api.coingecko.com/api/v3/exchange_rates',
  };
  const progress = [];
  let rankingOptions;

  await generateDailyGemsIssue(portfolioConfig, {
    limit: 2,
    quoteCurrencyMode: 'mixed',
    getRanking: async (_portfolioConfig, options) => {
      rankingOptions = options;
      return mixedRanking;
    },
    resolveByIds: async () => [resolvedNewCoin],
    onProgress: (message) => progress.push(message),
  });

  assert.equal(rankingOptions.quoteCurrencyMode, 'mixed');
  assert.equal(
    progress[0],
    'Screening up to 1000 CoinGecko candidates against Revolut X EEA EUR-preferred EUR/USD markets for 2 positions.',
  );
  assert.equal(
    progress[1],
    'Selected 2 assets from 600 candidates with verified direct EUR-preferred EUR/USD markets.',
  );
});

test('publishes mixed EUR and USD quote orders with the EUR 50 USD cap', () => {
  const mixedRanking = ranking();
  mixedRanking.tradingVenue = {
    ...mixedRanking.tradingVenue,
    quoteCurrencyMode: 'MIXED',
    quoteCurrencies: ['EUR', 'USD'],
    quoteCurrency: null,
    usdPerEur: 1.2,
    exchangeRateSource: 'https://api.coingecko.com/api/v3/exchange_rates',
  };
  mixedRanking.assets[0] = rankedAsset({
    rank: 1,
    tradingPair: 'NEW/USD',
    tradingQuoteCurrency: 'USD',
    quoteOrderAmount: 60,
  });

  const result = buildDailyGemsAdoptionPackage(
    mixedRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.ranking.assets[0].tradingPair, 'NEW/USD');
  assert.equal(result.ranking.assets[0].tradingQuoteCurrency, 'USD');
  assert.equal(result.ranking.assets[0].quoteOrderAmount, 60);
  assert.match(result.issueBody, /active direct EUR or USD market/);
  assert.match(result.issueBody, /EUR\/USD conversion: 1.2 USD per EUR/);
  assert.match(result.issueBody, /NEW\/USD \(active, EEA\) \| USD 60/);
});

test('builds one compact issue for EUR, USD, and mixed profile options', () => {
  const rankings = ['EUR', 'USD', 'MIXED'].map(rankingForMode);
  rankings[1].exclusionDetails = [{
    id: 'dry-one',
    symbol: 'DRY',
    name: 'Dry One',
    marketCap: 12_000_000,
    tradingPairs: ['DRY/USD'],
    identityStatus: 'verified',
    reason: 'Trading volume is below 100000.',
  }];
  rankings[2].exclusionDetails = [{
    ...rankings[1].exclusionDetails[0],
    tradingPairs: ['DRY/EUR', 'DRY/USD'],
  }];
  const result = buildConsolidatedDailyGemsAdoptionPackage(
    rankings,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.equal(result.schemaVersion, 4);
  assert.equal(result.issueTitle, '[Daily Gems] 2026-08-24 - EUR, USD, and MIXED profile options');
  assert.deepEqual(result.profilePaths, [
    'profiles/gems-eur-2026-08-24.json',
    'profiles/gems-usd-2026-08-24.json',
    'profiles/gems-mixed-2026-08-24.json',
  ]);
  assert.equal(result.supportedAssetsToAdd.length, 1);
  assert.equal(result.modePackages[1].ranking.assets[0].quoteOrderAmount, 60);
  assert.equal(result.validation.oneDailyIssue, true);
  assert.equal(result.validation.sharedMarketSnapshot, true);
  assert.ok(result.modePackages.every((modePackage) => !Object.hasOwn(modePackage, 'issueBody')));
  assert.equal(result.issueBody.match(/<!-- daily-gems:2026-08-24 -->/g).length, 1);
  assert.match(result.issueBody, /## EUR-only option/);
  assert.match(result.issueBody, /## USD-only option/);
  assert.match(result.issueBody, /## MIXED \(EUR preferred\) option/);
  assert.equal(
    result.issueBody.match(/`DRY\/USD`/g).length,
    2,
  );
  assert.doesNotMatch(result.issueBody, /dispositions match the USD option/);
  assert.ok(result.issueBody.length <= 57_536);
});

test('deduplicates identical active-market exclusion indexes across modes', () => {
  const rankings = ['EUR', 'USD', 'MIXED'].map(rankingForMode);
  const sharedExclusion = {
    id: 'dry-one',
    symbol: 'DRY',
    name: 'Dry One',
    marketCap: 12_000_000,
    tradingPairs: ['DRY/USD'],
    identityStatus: 'verified',
    reason: 'Trading volume is below 100000.',
  };
  rankings[1].exclusionDetails = [sharedExclusion];
  rankings[2].exclusionDetails = [structuredClone(sharedExclusion)];

  const result = buildConsolidatedDailyGemsAdoptionPackage(
    rankings,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.equal(result.issueBody.match(/`DRY\/USD`/g)?.length, 1);
  assert.match(result.issueBody, /dispositions match the USD option/);
});

test('compacts candidate-specific identity mismatches by disposition and pair', () => {
  const rankings = ['EUR', 'USD', 'MIXED'].map(rankingForMode);
  for (const rankingResult of rankings) {
    const quote = rankingResult.tradingVenue.quoteCurrencyMode === 'EUR' ? 'EUR' : 'USD';
    rankingResult.excluded = Array.from({ length: 800 }, (_, index) => ({
      id: `collision-${index}`,
      reason: `CoinGecko identity Candidate ${index} (COLL${index % 120}) does not match Revolut X Currency ${index} (COLL${index % 120}).`,
    }));
    rankingResult.exclusionDetails = rankingResult.excluded.map(({ id, reason }, index) => ({
      id,
      symbol: `COLL${index % 120}`,
      name: `Candidate ${index}`,
      marketCap: 12_000_000,
      tradingPairs: [`COLL${index % 120}/${quote}`],
      identityStatus: 'mismatch',
      reason,
    }));
  }

  const result = buildConsolidatedDailyGemsAdoptionPackage(
    rankings,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.match(result.issueBody, /800: CoinGecko identity does not match the active venue currency identity\./);
  assert.match(result.issueBody, /\[identity mismatch\]: `COLL0\/EUR`/);
  assert.match(result.issueBody, /\[identity mismatch\]: `COLL0\/USD`/);
  assert.doesNotMatch(result.issueBody, /Candidate 799/);
  assert.ok(result.issueBody.length <= 57_536);
});

test('does not enforce discarded standalone body limits in consolidated mode packages', () => {
  const rankings = ['EUR', 'USD', 'MIXED'].map(rankingForMode);
  for (const rankingResult of rankings) {
    rankingResult.excluded = Array.from({ length: 1_000 }, (_, index) => ({
      id: `unique-${index}`,
      reason: `Unique exclusion ${index}: ${'x'.repeat(80)}`,
    }));
  }

  assert.throws(() => buildDailyGemsAdoptionPackage(
    rankings[0],
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  ), /generation limit reserved for publication changes/);

  const result = buildConsolidatedDailyGemsAdoptionPackage(
    rankings,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  );

  assert.ok(result.issueBody.length <= 57_536);
  assert.ok(result.modePackages.every((modePackage) => !Object.hasOwn(modePackage, 'issueBody')));
});

test('generates consolidated rankings using canonical metadata from the shared snapshot', async () => {
  const progress = [];
  let requestedModes;
  const result = await generateConsolidatedDailyGemsIssue(portfolioConfig, {
    limit: 2,
    getRankings: async (_portfolioConfig, modes) => {
      requestedModes = modes;
      return modes.map(rankingForMode);
    },
    onProgress: (message) => progress.push(message),
  });

  assert.deepEqual(requestedModes, ['EUR', 'USD', 'MIXED']);
  assert.deepEqual(result.supportedAssetsToAdd, [{
    id: 'new-coin',
    symbol: 'NEW',
    name: 'New Coin',
    thesis: "Speculative exposure to New Coin, that passed the workflow's lower-market-cap, liquidity, and momentum screens, with material volatility, liquidity, token-supply, and project-execution risk.",
  }]);
  assert.equal(result.modePackages.length, 3);
  assert.match(progress[2], /Reusing canonical metadata.*shared live CoinGecko snapshot/);
  assert.match(progress.at(-1), /Consolidated three validated profiles into one/);
});

test('rejects a USD order whose EUR allocation exceeds 50', () => {
  const usdRanking = ranking();
  usdRanking.tradingVenue = {
    ...usdRanking.tradingVenue,
    quoteCurrencyMode: 'USD',
    quoteCurrencies: ['USD'],
    quoteCurrency: 'USD',
    usdPerEur: 1.2,
    exchangeRateSource: 'https://api.coingecko.com/api/v3/exchange_rates',
  };
  usdRanking.assets[0] = rankedAsset({
    rank: 1,
    investedAmount: 50.01,
    tradingPair: 'NEW/USD',
    tradingQuoteCurrency: 'USD',
    quoteOrderAmount: 60.012,
  });

  assert.throws(() => buildDailyGemsAdoptionPackage(
    usdRanking,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  ), /USD order exceeds the EUR 50 maximum/);
});

test('rejects missing or mismatched canonical metadata', () => {
  assert.throws(() => buildDailyGemsAdoptionPackage(
    ranking(),
    portfolioConfig,
    [],
    { expectedAssetCount: 2 },
  ), /Missing verified CoinGecko metadata for new-coin/);

  assert.throws(() => buildDailyGemsAdoptionPackage(
    ranking(),
    portfolioConfig,
    [{ ...resolvedNewCoin, entry: { ...resolvedNewCoin.entry, id: 'wrong-coin' } }],
    { expectedAssetCount: 2 },
  ), /Missing verified CoinGecko metadata for new-coin/);
});

test('rejects incomplete rankings instead of creating a partial issue', () => {
  const incomplete = ranking();
  incomplete.assets.pop();
  assert.throws(() => buildDailyGemsAdoptionPackage(
    incomplete,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  ), /Expected 2 ranked assets but received 1/);
});

test('rejects rankings without Revolut X quote-market verification', () => {
  const unverified = ranking();
  unverified.tradingVenue = null;
  assert.throws(() => buildDailyGemsAdoptionPackage(
    unverified,
    portfolioConfig,
    [resolvedNewCoin],
    { expectedAssetCount: 2 },
  ), /must be verified against Revolut X EEA direct EUR or USD markets/);
});