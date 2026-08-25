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
    excluded: [
      { id: 'dry-one', reason: 'Trading volume is below 100000.' },
      { id: 'dry-two', reason: 'Trading volume is below 100000.' },
    ],
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

  assert.equal(result.profilePath, 'profiles/gems-2026-08-24.json');
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
  assert.match(result.issueBody, /profiles\/gems-2026-08-24\.json/);
  assert.match(result.issueBody, /"type": "real"/);
  assert.match(result.issueBody, /snapshot rather than completed trades/);
  assert.match(result.issueBody, /Machine-readable adoption manifest/);
  assert.match(result.issueBody, /active direct-EUR market on Revolut X in EEA/);
  assert.match(result.issueBody, /NEW\/EUR \(active, EEA\)/);
  assert.doesNotMatch(result.issueBody, /EUR NaN/);
  assert.doesNotMatch(result.issueBody, /"type": "simulated"/);
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
    'Validated 2 holdings for profiles/gems-2026-08-24.json.',
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
  const result = buildConsolidatedDailyGemsAdoptionPackage(
    ['EUR', 'USD', 'MIXED'].map(rankingForMode),
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
  assert.equal(result.issueBody.match(/<!-- daily-gems:2026-08-24 -->/g).length, 1);
  assert.match(result.issueBody, /## EUR-only option/);
  assert.match(result.issueBody, /## USD-only option/);
  assert.match(result.issueBody, /## MIXED \(EUR preferred\) option/);
  assert.ok(result.issueBody.length < 65_536);
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