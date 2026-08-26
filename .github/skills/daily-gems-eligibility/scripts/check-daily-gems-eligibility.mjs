import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  fetchDiamondMarketsByIds,
  fetchEurUsdRate,
  fetchRevolutXTradingVenue,
  rankDiamondQuantities,
} from '../../diamond-quantities/scripts/rank-diamond-quantities.mjs';
import {
  resolveCanonicalAsset,
} from '../../supported-asset-entry/scripts/resolve-supported-asset.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const DEFAULT_INVESTED_AMOUNT = 50;
const MAX_USD_INVESTMENT_EUR = 50;
const DEFAULT_QUOTE_CURRENCY_MODE = 'ALL';
const QUOTE_CURRENCY_MODES = ['EUR', 'USD', 'MIXED'];
const REQUEST_INTERVAL_MS = 1_000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requestedQuoteModes(value = DEFAULT_QUOTE_CURRENCY_MODE) {
  const mode = String(value ?? '').trim().toUpperCase();
  if (mode === 'ALL') return [...QUOTE_CURRENCY_MODES];
  if (QUOTE_CURRENCY_MODES.includes(mode)) return [mode];
  throw new Error('Quote currency mode must be ALL, EUR, USD, or MIXED.');
}

function validatedInvestedAmount(value, modes) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invested amount must be a positive number.');
  }
  if (modes.some((mode) => mode === 'USD' || mode === 'MIXED')
    && amount > MAX_USD_INVESTMENT_EUR) {
    throw new Error(`USD quote modes support at most EUR ${MAX_USD_INVESTMENT_EUR} per asset.`);
  }
  return amount;
}

function canonicalAsset(resolution) {
  const id = String(resolution?.entry?.id ?? '').trim().toLowerCase();
  const symbol = String(resolution?.entry?.symbol ?? '').trim().toUpperCase();
  const name = String(resolution?.entry?.name ?? '').trim();
  if (!id || !symbol || !name) {
    throw new Error('Asset resolver returned incomplete canonical metadata.');
  }
  return {
    id,
    symbol,
    name,
    isSupported: resolution.source === 'local',
  };
}

function quoteCurrenciesForMode(mode) {
  return mode === 'MIXED' ? ['EUR', 'USD'] : [mode];
}

function tradingVenueForMode(tradingVenue, mode) {
  const quoteCurrencies = quoteCurrenciesForMode(mode);
  return {
    ...tradingVenue,
    quoteCurrencyMode: mode,
    quoteCurrencies,
    quoteCurrency: quoteCurrencies.length === 1 ? quoteCurrencies[0] : null,
  };
}

function eligibleCandidate(candidate) {
  return {
    tradingPair: candidate.tradingPair,
    tradingQuoteCurrency: candidate.tradingQuoteCurrency,
    quoteOrderAmount: candidate.quoteOrderAmount,
    minOrderSizeQuote: candidate.minOrderSizeQuote,
    maxOrderSizeQuote: candidate.maxOrderSizeQuote,
    currentPrice: candidate.currentPrice,
    marketCap: candidate.marketCap,
    marketCapRank: candidate.marketCapRank,
    totalVolume: candidate.totalVolume,
    liquidityRatio: candidate.liquidityRatio,
    priceChange7dPct: candidate.priceChange7dPct,
    priceChange30dPct: candidate.priceChange30dPct,
    supplyBasis: candidate.supplyBasis,
    circulatingSupplyRatio: candidate.circulatingSupplyRatio,
    lastUpdated: candidate.lastUpdated,
  };
}

export function summarizeDailyGemsEligibility(asset, rankings, metadataSource = null) {
  if (!Array.isArray(rankings) || rankings.length === 0) {
    throw new Error('Provide at least one daily-gems eligibility result.');
  }
  const modes = rankings.map((ranking) => {
    const quoteCurrencyMode = ranking?.tradingVenue?.quoteCurrencyMode;
    const candidate = ranking?.assets?.find(({ id }) => id === asset.id);
    if (candidate) {
      return {
        quoteCurrencyMode,
        eligible: true,
        reason: null,
        identityStatus: 'verified',
        tradingPairs: [candidate.tradingPair],
        candidate: eligibleCandidate(candidate),
      };
    }
    const exclusion = ranking?.exclusionDetails?.find(({ id }) => id === asset.id);
    return {
      quoteCurrencyMode,
      eligible: false,
      reason: exclusion?.reason
        ?? `CoinGecko returned no live ${ranking.currency} market row for ${asset.id}.`,
      identityStatus: exclusion?.identityStatus ?? 'not-checked',
      tradingPairs: exclusion?.tradingPairs ?? [],
      candidate: null,
    };
  });
  const firstRanking = rankings[0];
  return {
    asset,
    checkedAt: firstRanking.observedAt,
    currency: firstRanking.currency,
    investedAmount: firstRanking.investedAmountPerAsset,
    requestedQuoteModes: modes.map(({ quoteCurrencyMode }) => quoteCurrencyMode),
    eligible: modes.some(({ eligible }) => eligible),
    eligibleInAllRequestedModes: modes.every(({ eligible }) => eligible),
    modes,
    screen: firstRanking.screen,
    sources: {
      canonicalMetadata: metadataSource,
      marketData: firstRanking.source,
      tradingPairs: firstRanking.tradingVenue.source,
      currencyIdentities: firstRanking.tradingVenue.identitySource,
      exchangeRate: rankings.find(({ tradingVenue }) =>
        tradingVenue.exchangeRateSource)?.tradingVenue.exchangeRateSource ?? null,
    },
  };
}

export async function checkDailyGemsEligibility(assetInput, portfolioConfig, options = {}) {
  const {
    investedAmount: investedAmountInput = DEFAULT_INVESTED_AMOUNT,
    quoteCurrencyMode: quoteCurrencyModeInput = DEFAULT_QUOTE_CURRENCY_MODE,
    observedAt = new Date(),
    attempts,
    fetchImpl,
    sleepImpl = sleep,
    tradingRegion = 'EEA',
    usdPerEur: usdPerEurInput,
    resolveAssetImpl = resolveCanonicalAsset,
    fetchMarketsImpl = fetchDiamondMarketsByIds,
    fetchTradingVenueImpl = fetchRevolutXTradingVenue,
    fetchExchangeRateImpl = fetchEurUsdRate,
  } = options;
  const modes = requestedQuoteModes(quoteCurrencyModeInput);
  const investedAmount = validatedInvestedAmount(investedAmountInput, modes);
  const requestOptions = { attempts, fetchImpl, sleepImpl };
  const resolution = await resolveAssetImpl(assetInput, portfolioConfig, requestOptions);
  const asset = canonicalAsset(resolution);
  if (resolution.source !== 'local') await sleepImpl(REQUEST_INTERVAL_MS);

  const venueMode = modes.length === 1 ? modes[0] : 'MIXED';
  const [marketRows, tradingVenue] = await Promise.all([
    fetchMarketsImpl(
      String(portfolioConfig.currency ?? 'eur').toUpperCase(),
      [asset.id],
      requestOptions,
    ),
    fetchTradingVenueImpl(venueMode, {
      region: tradingRegion,
      attempts,
      fetchImpl,
      sleepImpl,
    }),
  ]);
  const marketRow = marketRows.find(({ id }) =>
    String(id ?? '').trim().toLowerCase() === asset.id);
  const requiresUsd = modes.some((mode) => mode === 'USD' || mode === 'MIXED');
  let exchangeRate = { usdPerEur: null, source: null };
  if (requiresUsd && usdPerEurInput === undefined) {
    await sleepImpl(REQUEST_INTERVAL_MS);
    exchangeRate = await fetchExchangeRateImpl(requestOptions);
  } else if (requiresUsd) {
    exchangeRate = { usdPerEur: usdPerEurInput, source: 'provided' };
  }

  const rankings = modes.map((mode) => rankDiamondQuantities(
    marketRow ? [marketRow] : [],
    portfolioConfig,
    {
      investedAmount,
      limit: 1,
      observedAt,
      quoteCurrencyMode: mode,
      usdPerEur: exchangeRate.usdPerEur,
      exchangeRateSource: exchangeRate.source,
      tradingVenue: tradingVenueForMode(tradingVenue, mode),
    },
  ));
  return summarizeDailyGemsEligibility(asset, rankings, resolution.source);
}

async function main([assetInput, quoteCurrencyMode, investedAmount]) {
  const portfolioConfig = JSON.parse(await readFile(
    path.join(repositoryRoot, 'data', 'portfolio.json'),
    'utf8',
  ));
  const result = await checkDailyGemsEligibility(assetInput, portfolioConfig, {
    ...(quoteCurrencyMode === undefined ? {} : { quoteCurrencyMode }),
    ...(investedAmount === undefined ? {} : { investedAmount }),
  });
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}