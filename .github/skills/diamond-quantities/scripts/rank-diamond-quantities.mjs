import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const API = 'https://api.coingecko.com/api/v3';
const REVOLUT_X_API = 'https://revx.revolut.com/api';
const REVOLUT_X_REGION = 'EEA';
const REVOLUT_X_REQUEST_INTERVAL_MS = 1_000;
const COINGECKO_REQUEST_INTERVAL_MS = 15_000;
const COINGECKO_RATE_LIMIT_RETRY_MS = 60_000;
const COINGECKO_MAX_RATE_LIMIT_RETRY_MS = 300_000;
const COINGECKO_REQUEST_ATTEMPTS = 5;
const DEFAULT_REQUEST_ATTEMPTS = 3;
const DEFAULT_INVESTED_AMOUNT = 50;
const DEFAULT_QUOTE_CURRENCY_MODE = 'EUR';
const MAX_USD_INVESTMENT_EUR = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 1_000;
const MAX_CANDIDATE_LIMIT = 1_000;
const MAX_MARKETS_PER_REQUEST = 250;
const MAX_SYMBOLS_PER_REQUEST = 50;
const DEFAULT_MIN_MARKET_CAP = 10_000_000;
const DEFAULT_REFERENCE_MARKET_CAP = 1_000_000_000;
const DEFAULT_MIN_TOTAL_VOLUME = 100_000;
const DEFAULT_MIN_LIQUIDITY_RATIO = 0.01;

const REVOLUT_X_IDENTITY_OVERRIDES = new Map([
  ['artificial-superintelligence-alliance', 'FET'],
  ['binancecoin', 'BNB'],
  ['lido-dao', 'LDO'],
  ['official-trump', 'TRUMP'],
  ['polygon-ecosystem-token', 'POL'],
  ['render-token', 'RENDER'],
  ['the-open-network', 'TON'],
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Observed time must be a valid date.');
  return date.toISOString();
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizedScore(value, minimum, maximum) {
  if (minimum === maximum) return 50;
  return clamp((value - minimum) / (maximum - minimum) * 100);
}

function normalizedIdentity(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeQuoteCurrencyMode(value = DEFAULT_QUOTE_CURRENCY_MODE) {
  const input = String(value ?? '').trim().toUpperCase();
  if (input === 'DOLLAR' || input === 'DOLLARS') return 'USD';
  if (input === 'MIX') return 'MIXED';
  if (input === 'EUR' || input === 'USD' || input === 'MIXED') return input;
  throw new Error('Quote currency mode must be EUR, USD, or MIXED.');
}

function quoteCurrenciesForMode(mode) {
  return mode === 'MIXED' ? ['EUR', 'USD'] : [mode];
}

function hasVerifiedTradingIdentity(id, symbol, name, pair) {
  const mappedSymbol = REVOLUT_X_IDENTITY_OVERRIDES.get(id);
  if (mappedSymbol) return mappedSymbol === symbol && pair.base === mappedSymbol;
  return pair.base === symbol
    && normalizedIdentity(pair.currencyName) === normalizedIdentity(name);
}

function normalizeTradingVenue(value, expectedQuoteCurrencies) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object'
    || !Array.isArray(value.pairs) || !Array.isArray(value.currencies)) {
    throw new Error('Trading venue must include pairs and currencies arrays.');
  }

  const name = String(value.name ?? '').trim();
  const region = String(value.region ?? '').trim().toUpperCase();
  const source = String(value.source ?? '').trim();
  const identitySource = String(value.identitySource ?? '').trim();
  const advertisedQuoteCurrencies = Array.isArray(value.quoteCurrencies)
    ? value.quoteCurrencies.map((currency) => String(currency).trim().toUpperCase())
    : [String(value.quoteCurrency ?? '').trim().toUpperCase()].filter(Boolean);
  if (!name || !region || !source || !identitySource
    || advertisedQuoteCurrencies.length !== expectedQuoteCurrencies.length
    || !expectedQuoteCurrencies.every((currency) => advertisedQuoteCurrencies.includes(currency))) {
    throw new Error(`Trading venue must describe ${expectedQuoteCurrencies.join('/')} pairs with a name, region, and sources.`);
  }

  const currenciesBySymbol = new Map();
  for (const currency of value.currencies) {
    const symbol = String(currency?.symbol ?? '').trim().toUpperCase();
    if (!symbol) continue;
    if (currenciesBySymbol.has(symbol)) throw new Error(`Trading venue returned duplicate ${symbol} currencies.`);
    currenciesBySymbol.set(symbol, {
      name: String(currency?.name ?? '').trim(),
      status: String(currency?.status ?? '').trim().toLowerCase(),
    });
  }

  const pairsByBase = new Map();
  for (const pair of value.pairs) {
    const base = String(pair?.base ?? '').trim().toUpperCase();
    const quote = String(pair?.quote ?? '').trim().toUpperCase();
    const status = String(pair?.status ?? '').trim().toLowerCase();
    if (!base || !expectedQuoteCurrencies.includes(quote) || status !== 'active') continue;
    const pairsByQuote = pairsByBase.get(base) ?? new Map();
    if (pairsByQuote.has(quote)) throw new Error(`Trading venue returned duplicate ${base}/${quote} pairs.`);
    const currency = currenciesBySymbol.get(base);
    pairsByQuote.set(quote, {
      symbol: String(pair.symbol ?? `${base}/${quote}`).trim(),
      base,
      quote,
      status: 'active',
      currencyName: currency?.name ?? null,
      currencyStatus: currency?.status ?? null,
      minOrderSizeQuote: Number(pair.minOrderSizeQuote),
      maxOrderSizeQuote: pair.maxOrderSizeQuote === undefined || pair.maxOrderSizeQuote === null
        ? null
        : Number(pair.maxOrderSizeQuote),
    });
    pairsByBase.set(base, pairsByQuote);
  }

  return {
    name,
    region,
    source,
    identitySource,
    quoteCurrencies: expectedQuoteCurrencies,
    pairsByBase,
  };
}

function supplyMetrics(quote, marketCap) {
  const circulatingSupply = Number(quote?.circulating_supply);
  const maxSupply = Number(quote?.max_supply);
  const totalSupply = Number(quote?.total_supply);
  const fullyDilutedValuation = Number(quote?.fully_diluted_valuation);

  if (Number.isFinite(circulatingSupply) && circulatingSupply > 0
    && Number.isFinite(maxSupply) && maxSupply > 0) {
    return {
      circulatingSupply,
      supplyDenominator: maxSupply,
      supplyBasis: 'maxSupply',
      circulatingSupplyRatio: clamp(circulatingSupply / maxSupply, 0, 1),
    };
  }
  if (Number.isFinite(circulatingSupply) && circulatingSupply > 0
    && Number.isFinite(totalSupply) && totalSupply > 0) {
    return {
      circulatingSupply,
      supplyDenominator: totalSupply,
      supplyBasis: 'totalSupply',
      circulatingSupplyRatio: clamp(circulatingSupply / totalSupply, 0, 1),
    };
  }
  if (Number.isFinite(fullyDilutedValuation) && fullyDilutedValuation > 0) {
    return {
      circulatingSupply: Number.isFinite(circulatingSupply) ? circulatingSupply : null,
      supplyDenominator: null,
      supplyBasis: 'fullyDilutedValuation',
      circulatingSupplyRatio: clamp(marketCap / fullyDilutedValuation, 0, 1),
    };
  }
  return null;
}

export function rankDiamondQuantities(marketRows, portfolioConfig, {
  investedAmount: investedAmountInput = DEFAULT_INVESTED_AMOUNT,
  limit: limitInput = DEFAULT_LIMIT,
  observedAt: observedAtInput = new Date(),
  minMarketCap: minMarketCapInput = DEFAULT_MIN_MARKET_CAP,
  referenceMarketCap: referenceMarketCapInput = DEFAULT_REFERENCE_MARKET_CAP,
  minTotalVolume: minTotalVolumeInput = DEFAULT_MIN_TOTAL_VOLUME,
  minLiquidityRatio: minLiquidityRatioInput = DEFAULT_MIN_LIQUIDITY_RATIO,
  quoteCurrencyMode: quoteCurrencyModeInput = DEFAULT_QUOTE_CURRENCY_MODE,
  usdPerEur: usdPerEurInput,
  exchangeRateSource = null,
  tradingVenue: tradingVenueInput,
} = {}) {
  if (!Array.isArray(marketRows)) throw new Error('CoinGecko returned invalid market data.');

  const investedAmount = positiveNumber(investedAmountInput, 'Invested amount');
  const limit = positiveInteger(limitInput, 'Limit');
  const observedAt = isoTimestamp(observedAtInput);
  const minMarketCap = positiveNumber(minMarketCapInput, 'Minimum market capitalization');
  const referenceMarketCap = positiveNumber(referenceMarketCapInput, 'Reference market capitalization');
  const minTotalVolume = positiveNumber(minTotalVolumeInput, 'Minimum total volume');
  const minLiquidityRatio = positiveNumber(minLiquidityRatioInput, 'Minimum liquidity ratio');
  const currency = String(portfolioConfig.currency ?? 'eur').toUpperCase();
  if (currency !== 'EUR') {
    throw new Error('Diamond ranking requires EUR as the portfolio valuation currency.');
  }
  const quoteCurrencyMode = normalizeQuoteCurrencyMode(quoteCurrencyModeInput);
  const quoteCurrencies = quoteCurrenciesForMode(quoteCurrencyMode);
  const usdPerEur = quoteCurrencies.includes('USD')
    ? positiveNumber(usdPerEurInput, 'USD per EUR exchange rate')
    : null;
  if (quoteCurrencies.includes('USD') && investedAmount > MAX_USD_INVESTMENT_EUR) {
    throw new Error(`USD quote modes support at most EUR ${MAX_USD_INVESTMENT_EUR} per asset.`);
  }
  const tradingVenue = normalizeTradingVenue(tradingVenueInput, quoteCurrencies);
  if (referenceMarketCap <= minMarketCap) {
    throw new Error('Reference market capitalization must exceed the minimum market capitalization.');
  }

  const supportedAssets = Array.isArray(portfolioConfig.supportedAssets)
    ? portfolioConfig.supportedAssets
    : [];
  const supportedById = new Map(supportedAssets.map((asset) => [asset.id, asset]));
  const quotesById = new Map();
  const eligible = [];
  const excluded = [];
  const exclusionDetails = [];
  const exclude = (id, quote, reason, tradingPairs = [], identityStatus = 'not-checked') => {
    const marketCap = quote?.market_cap;
    excluded.push({ id, reason });
    exclusionDetails.push({
      id,
      symbol: String(quote?.symbol ?? '').trim().toUpperCase() || null,
      name: String(quote?.name ?? '').trim() || null,
      marketCap: marketCap !== null && marketCap !== undefined && marketCap !== ''
        && Number.isFinite(Number(marketCap))
        ? Number(marketCap)
        : null,
      tradingPairs,
      identityStatus,
      reason,
    });
  };

  for (const quote of marketRows) {
    const id = String(quote?.id ?? '').trim();
    if (!id) {
      exclude(null, quote, 'CoinGecko returned market data without a canonical ID.');
      continue;
    }
    quotesById.set(id, quote);
  }

  for (const [id, quote] of quotesById) {
    const canonicalSymbol = String(quote?.symbol ?? '').trim().toUpperCase();
    const canonicalName = String(quote?.name ?? '').trim();
    const currentPrice = Number(quote?.current_price);
    const marketCap = Number(quote?.market_cap);
    const totalVolume = Number(quote?.total_volume);
    const priceChange7dPct = Number(quote?.price_change_percentage_7d_in_currency);
    const priceChange30dPct = Number(quote?.price_change_percentage_30d_in_currency);
    const lastUpdated = Date.parse(String(quote?.last_updated ?? ''));
    const pairsByQuote = tradingVenue?.pairsByBase.get(canonicalSymbol);
    const activeTradingPairs = quoteCurrencies
      .map((quoteCurrency) => pairsByQuote?.get(quoteCurrency)?.symbol)
      .filter(Boolean);
    if (!canonicalSymbol || !canonicalName) {
      exclude(
        id,
        quote,
        'CoinGecko returned incomplete canonical metadata.',
        activeTradingPairs,
      );
      continue;
    }
    let tradingPair = null;
    let quoteOrderAmount = null;
    let identityStatus = 'not-checked';
    if (tradingVenue && !pairsByQuote) {
      exclude(
        id,
        quote,
        `No active ${tradingVenue.name} ${quoteCurrencies
          .map((quoteCurrency) => `${canonicalSymbol}/${quoteCurrency}`)
          .join(' or ')} market in ${tradingVenue.region}.`,
      );
      continue;
    }
    const pairRejections = [];
    for (const quoteCurrency of quoteCurrencies) {
      const candidatePair = pairsByQuote?.get(quoteCurrency);
      if (!candidatePair) continue;
      const candidateOrderAmount = quoteCurrency === 'USD'
        ? investedAmount * usdPerEur
        : investedAmount;
      if (!Number.isFinite(candidatePair.minOrderSizeQuote)
        || candidatePair.minOrderSizeQuote <= 0
        || (candidatePair.maxOrderSizeQuote !== null
          && (!Number.isFinite(candidatePair.maxOrderSizeQuote)
            || candidatePair.maxOrderSizeQuote < candidatePair.minOrderSizeQuote))) {
        pairRejections.push(`${tradingVenue.name} returned invalid ${candidatePair.symbol} quote-order limits.`);
        continue;
      }
      if (candidateOrderAmount < candidatePair.minOrderSizeQuote) {
        pairRejections.push(`${quoteCurrency} ${round(candidateOrderAmount)} is below the ${candidatePair.symbol} minimum quote order of ${candidatePair.minOrderSizeQuote}.`);
        continue;
      }
      if (candidatePair.maxOrderSizeQuote !== null
        && candidateOrderAmount > candidatePair.maxOrderSizeQuote) {
        pairRejections.push(`${quoteCurrency} ${round(candidateOrderAmount)} exceeds the ${candidatePair.symbol} maximum quote order of ${candidatePair.maxOrderSizeQuote}.`);
        continue;
      }
      tradingPair = candidatePair;
      quoteOrderAmount = round(candidateOrderAmount);
      break;
    }
    if (tradingVenue && !tradingPair) {
      exclude(
        id,
        quote,
        pairRejections[0] ?? `No active ${tradingVenue.name} ${quoteCurrencies
          .map((quoteCurrency) => `${canonicalSymbol}/${quoteCurrency}`)
          .join(' or ')} market in ${tradingVenue.region}.`,
        activeTradingPairs,
      );
      continue;
    }
    if (tradingPair && (!tradingPair.currencyName || tradingPair.currencyStatus !== 'active')) {
      exclude(
        id,
        quote,
        `${tradingVenue.name} currency identity for ${canonicalSymbol} is not active and complete.`,
        activeTradingPairs,
      );
      continue;
    }
    if (tradingPair && !hasVerifiedTradingIdentity(id, canonicalSymbol, canonicalName, tradingPair)) {
      exclude(
        id,
        quote,
        `CoinGecko identity ${canonicalName} (${canonicalSymbol}) does not match ${tradingVenue.name} ${tradingPair.currencyName} (${tradingPair.base}).`,
        activeTradingPairs,
        'mismatch',
      );
      continue;
    }
    if (tradingPair) identityStatus = 'verified';
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      exclude(id, quote, 'CoinGecko returned no valid current price.', activeTradingPairs, identityStatus);
      continue;
    }
    if (!Number.isFinite(marketCap) || marketCap < minMarketCap) {
      exclude(
        id,
        quote,
        `Market capitalization is below ${minMarketCap}.`,
        activeTradingPairs,
        identityStatus,
      );
      continue;
    }
    if (marketCap >= referenceMarketCap) {
      exclude(
        id,
        quote,
        `Market capitalization has no headroom below ${referenceMarketCap}.`,
        activeTradingPairs,
        identityStatus,
      );
      continue;
    }
    if (!Number.isFinite(totalVolume) || totalVolume < minTotalVolume) {
      exclude(id, quote, `Trading volume is below ${minTotalVolume}.`, activeTradingPairs, identityStatus);
      continue;
    }
    const liquidityRatio = totalVolume / marketCap;
    if (liquidityRatio < minLiquidityRatio) {
      exclude(
        id,
        quote,
        `Volume-to-market-cap ratio is below ${minLiquidityRatio}.`,
        activeTradingPairs,
        identityStatus,
      );
      continue;
    }
    if (!Number.isFinite(priceChange7dPct) || !Number.isFinite(priceChange30dPct)) {
      exclude(
        id,
        quote,
        'CoinGecko returned incomplete 7-day or 30-day momentum.',
        activeTradingPairs,
        identityStatus,
      );
      continue;
    }
    const supply = supplyMetrics(quote, marketCap);
    if (!supply) {
      exclude(
        id,
        quote,
        'CoinGecko returned insufficient circulating-supply data.',
        activeTradingPairs,
        identityStatus,
      );
      continue;
    }
    if (!Number.isFinite(lastUpdated)) {
      exclude(id, quote, 'CoinGecko returned no valid update timestamp.', activeTradingPairs, identityStatus);
      continue;
    }

    const supportedAsset = supportedById.get(id);
    const quantity = investedAmount / currentPrice;
    const growthMultipleToReferenceMarketCap = referenceMarketCap / marketCap;
    const headroomScale = Math.log10(referenceMarketCap / minMarketCap);
    const marketCapHeadroomScore = clamp(
      Math.log10(growthMultipleToReferenceMarketCap) / headroomScale * 100,
    );
    const liquidityScore = clamp(liquidityRatio / 0.2 * 100);
    const momentum7dScore = normalizedScore(priceChange7dPct, -30, 50);
    const momentum30dScore = normalizedScore(priceChange30dPct, -30, 50);
    const momentumScore = momentum7dScore * 0.4 + momentum30dScore * 0.6;

    eligible.push({
      id,
      symbol: supportedAsset?.symbol ?? canonicalSymbol,
      name: supportedAsset?.name ?? canonicalName,
      thesis: supportedAsset?.thesis ?? null,
      isSupported: Boolean(supportedAsset),
      tradingPair: tradingPair?.symbol ?? null,
      tradingVenue: tradingVenue?.name ?? null,
      tradingRegion: tradingVenue?.region ?? null,
      tradingPairStatus: tradingPair?.status ?? null,
      tradingCurrencyName: tradingPair?.currencyName ?? null,
      tradingQuoteCurrency: tradingPair?.quote ?? null,
      quoteOrderAmount,
      minOrderSizeQuote: tradingPair?.minOrderSizeQuote ?? null,
      maxOrderSizeQuote: tradingPair?.maxOrderSizeQuote ?? null,
      investedAmount,
      quantity,
      buyDate: observedAt.slice(0, 10),
      buyTimestamp: observedAt,
      currentPrice,
      marketCap,
      marketCapRank: Number.isFinite(Number(quote.market_cap_rank))
        ? Number(quote.market_cap_rank)
        : null,
      totalVolume,
      liquidityRatio,
      priceChange7dPct,
      priceChange30dPct,
      ...supply,
      referenceMarketCap,
      growthMultipleToReferenceMarketCap,
      potentialValueAtReferenceMarketCap: investedAmount * growthMultipleToReferenceMarketCap,
      marketCapHeadroomScore,
      liquidityScore,
      momentumScore,
      lastUpdated: new Date(lastUpdated).toISOString(),
    });
  }

  const quantityLogs = eligible.map(({ quantity }) => Math.log10(quantity));
  const minimumQuantityLog = Math.min(...quantityLogs);
  const maximumQuantityLog = Math.max(...quantityLogs);
  for (const asset of eligible) {
    const quantityScore = normalizedScore(
      Math.log10(asset.quantity),
      minimumQuantityLog,
      maximumQuantityLog,
    );
    const supplyScore = asset.circulatingSupplyRatio * 100;
    asset.componentScores = {
      marketCapHeadroom: round(asset.marketCapHeadroomScore),
      quantity: round(quantityScore),
      liquidity: round(asset.liquidityScore),
      momentum: round(asset.momentumScore),
      supply: round(supplyScore),
    };
    asset.diamondScore = round(
      asset.marketCapHeadroomScore * 0.30
      + quantityScore * 0.25
      + asset.liquidityScore * 0.20
      + asset.momentumScore * 0.15
      + supplyScore * 0.10,
    );
    delete asset.marketCapHeadroomScore;
    delete asset.liquidityScore;
    delete asset.momentumScore;
  }

  const rankedEligible = eligible
    .sort((left, right) => right.diamondScore - left.diamondScore
      || right.potentialValueAtReferenceMarketCap - left.potentialValueAtReferenceMarketCap
      || right.liquidityRatio - left.liquidityRatio
      || left.id.localeCompare(right.id))
    .map((asset, index) => ({ rank: index + 1, ...asset }));
  const assets = rankedEligible.slice(0, limit);
  const eligibleButNotSelected = rankedEligible.slice(limit).map((asset) => ({
    rank: asset.rank,
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    tradingPair: asset.tradingPair,
    marketCap: asset.marketCap,
    diamondScore: asset.diamondScore,
    componentScores: asset.componentScores,
  }));

  return {
    currency,
    investedAmountPerAsset: investedAmount,
    requestedLimit: limit,
    candidateCount: quotesById.size,
    eligibleCount: eligible.length,
    observedAt,
    source: 'CoinGecko',
    tradingVenue: tradingVenue ? {
      name: tradingVenue.name,
      region: tradingVenue.region,
      source: tradingVenue.source,
      identitySource: tradingVenue.identitySource,
      quoteCurrencyMode,
      quoteCurrencies,
      quoteCurrency: quoteCurrencies.length === 1 ? quoteCurrencies[0] : null,
      usdPerEur,
      exchangeRateSource: quoteCurrencies.includes('USD') ? exchangeRateSource : null,
    } : null,
    rankingMetric: 'diamondScore',
    weights: {
      marketCapHeadroom: 0.30,
      quantity: 0.25,
      liquidity: 0.20,
      momentum: 0.15,
      supply: 0.10,
    },
    screen: {
      minMarketCap,
      referenceMarketCap,
      minTotalVolume,
      minLiquidityRatio,
      maxUsdInvestmentEur: MAX_USD_INVESTMENT_EUR,
    },
    assets,
    eligibleButNotSelected,
    excluded,
    exclusionDetails,
  };
}

async function fetchJson(url, {
  attempts,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  source = 'CoinGecko',
  userAgent = 'mycrypto-diamond-quantities/1.0',
  retryAfterUnit = 'seconds',
} = {}) {
  const maxAttempts = attempts ?? (source === 'CoinGecko'
    ? COINGECKO_REQUEST_ATTEMPTS
    : DEFAULT_REQUEST_ATTEMPTS);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': userAgent },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : '';
      lastError = new Error(`${source} request failed (${response.status}): ${detail}`);
      const retryAfterHeader = response.headers?.get?.('retry-after');
      const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
        ? Number.NaN
        : Number(retryAfterHeader);
      if (attempt < maxAttempts) {
        const retryAfterMultiplier = retryAfterUnit === 'milliseconds' ? 1 : 1_000;
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * retryAfterMultiplier
          : source === 'CoinGecko' && response.status === 429
            ? Math.min(
              COINGECKO_RATE_LIMIT_RETRY_MS * (2 ** (attempt - 1)),
              COINGECKO_MAX_RATE_LIMIT_RETRY_MS,
            )
            : attempt * 5_000;
        console.warn(`${source} request failed (${response.status}); retrying in ${delay / 1_000} seconds (attempt ${attempt + 1} of ${maxAttempts}).`);
        await sleepImpl(delay);
      }
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleepImpl(attempt * 5_000);
    }
  }
  throw lastError ?? new Error(`${source} request failed.`);
}

export async function fetchRevolutXTradingVenue(
  quoteCurrencyModeInput = DEFAULT_QUOTE_CURRENCY_MODE,
  {
    region: regionInput = REVOLUT_X_REGION,
    attempts,
    fetchImpl,
    sleepImpl,
  } = {},
) {
  const quoteCurrencyMode = normalizeQuoteCurrencyMode(quoteCurrencyModeInput);
  const quoteCurrencies = quoteCurrenciesForMode(quoteCurrencyMode);
  const region = String(regionInput).trim().toUpperCase();
  if (region !== 'EEA') {
    throw new Error('Revolut X diamond screening requires the EEA region.');
  }

  const query = new URLSearchParams({ region });
  const pairsUrl = `${REVOLUT_X_API}/1.0/public/configuration/pairs?${query}`;
  const currenciesUrl = `${REVOLUT_X_API}/1.0/public/configuration/currencies?${query}`;
  const pause = sleepImpl ?? sleep;
  const requestOptions = {
    attempts,
    fetchImpl,
    sleepImpl: pause,
    source: 'Revolut X',
    userAgent: 'mycrypto-revolut-x-eligibility/1.0',
    retryAfterUnit: 'milliseconds',
  };
  const pairsResult = await fetchJson(pairsUrl, requestOptions);
  await pause(REVOLUT_X_REQUEST_INTERVAL_MS);
  const currenciesResult = await fetchJson(currenciesUrl, requestOptions);
  if (!pairsResult || typeof pairsResult !== 'object' || Array.isArray(pairsResult)) {
    throw new Error('Revolut X returned invalid currency-pair data.');
  }
  if (!currenciesResult || typeof currenciesResult !== 'object' || Array.isArray(currenciesResult)) {
    throw new Error('Revolut X returned invalid currency data.');
  }

  return {
    name: 'Revolut X',
    region,
    source: pairsUrl,
    identitySource: currenciesUrl,
    quoteCurrencyMode,
    quoteCurrencies,
    quoteCurrency: quoteCurrencies.length === 1 ? quoteCurrencies[0] : null,
    pairs: Object.entries(pairsResult).map(([symbol, pair]) => ({
      symbol,
      base: pair?.base,
      quote: pair?.quote,
      status: pair?.status,
      minOrderSizeQuote: pair?.min_order_size_quote,
      maxOrderSizeQuote: pair?.max_order_size_quote,
    })),
    currencies: Object.values(currenciesResult).map((currency) => ({
      symbol: currency?.symbol,
      name: currency?.name,
      status: currency?.status,
    })),
  };
}

export async function fetchEurUsdRate(options = {}) {
  const source = `${API}/exchange_rates`;
  const result = await fetchJson(source, options);
  const eurPerBtc = Number(result?.rates?.eur?.value);
  const usdPerBtc = Number(result?.rates?.usd?.value);
  if (!Number.isFinite(eurPerBtc) || eurPerBtc <= 0
    || !Number.isFinite(usdPerBtc) || usdPerBtc <= 0) {
    throw new Error('CoinGecko returned no valid EUR/USD exchange rate.');
  }
  return {
    usdPerEur: usdPerBtc / eurPerBtc,
    source,
  };
}

export async function fetchLatestDiamondMarkets(
  currency,
  candidateLimitInput = DEFAULT_CANDIDATE_LIMIT,
  options,
) {
  const candidateLimit = positiveInteger(candidateLimitInput, 'Candidate limit');
  if (candidateLimit > MAX_CANDIDATE_LIMIT) {
    throw new Error(`Candidate limit cannot exceed ${MAX_CANDIDATE_LIMIT}.`);
  }

  const perPage = Math.min(candidateLimit, MAX_MARKETS_PER_REQUEST);
  const pageCount = Math.ceil(candidateLimit / perPage);
  const rows = [];
  const pause = options?.sleepImpl ?? sleep;
  for (let page = 1; page <= pageCount; page += 1) {
    if (page > 1) await pause(COINGECKO_REQUEST_INTERVAL_MS);
    const query = new URLSearchParams({
      vs_currency: String(currency).toLowerCase(),
      order: 'market_cap_desc',
      per_page: String(perPage),
      page: String(page),
      sparkline: 'false',
      price_change_percentage: '7d,30d',
      precision: 'full',
    });
    const result = await fetchJson(`${API}/coins/markets?${query}`, options);
    if (!Array.isArray(result)) throw new Error('CoinGecko returned invalid market data.');
    rows.push(...result.slice(0, candidateLimit - rows.length));
    if (result.length < perPage) break;
  }
  return rows;
}

export async function fetchDiamondMarketsByIds(currency, assetIdsInput, options) {
  if (!Array.isArray(assetIdsInput) || assetIdsInput.length === 0) {
    throw new Error('Provide at least one CoinGecko asset ID.');
  }
  const assetIds = [...new Set(assetIdsInput
    .map((value) => String(value ?? '').trim().toLowerCase()))];
  if (assetIds.some((id) => !id)) throw new Error('CoinGecko asset IDs cannot be empty.');
  if (assetIds.length > MAX_MARKETS_PER_REQUEST) {
    throw new Error(`Cannot retrieve more than ${MAX_MARKETS_PER_REQUEST} CoinGecko asset IDs at once.`);
  }
  const query = new URLSearchParams({
    vs_currency: String(currency).toLowerCase(),
    ids: assetIds.join(','),
    order: 'market_cap_desc',
    per_page: String(assetIds.length),
    page: '1',
    sparkline: 'false',
    price_change_percentage: '7d,30d',
    precision: 'full',
  });
  const result = await fetchJson(`${API}/coins/markets?${query}`, options);
  if (!Array.isArray(result)) throw new Error('CoinGecko returned invalid market data.');
  return result;
}

function activeTradingSymbols(tradingVenue) {
  const quoteCurrencies = new Set(tradingVenue.quoteCurrencies);
  return [...new Set(tradingVenue.pairs
    .filter((pair) => String(pair?.status ?? '').trim().toLowerCase() === 'active'
      && quoteCurrencies.has(String(pair?.quote ?? '').trim().toUpperCase()))
    .map((pair) => String(pair?.base ?? '').trim().toLowerCase())
    .filter(Boolean))];
}

async function fetchVenueDiamondMarkets(currency, tradingVenue, options) {
  const symbols = activeTradingSymbols(tradingVenue);
  const rows = [];
  const pause = options?.sleepImpl ?? sleep;
  let hasRequestedPage = false;
  for (let index = 0; index < symbols.length; index += MAX_SYMBOLS_PER_REQUEST) {
    const symbolBatch = symbols.slice(index, index + MAX_SYMBOLS_PER_REQUEST);
    for (let page = 1; ; page += 1) {
      if (hasRequestedPage) await pause(COINGECKO_REQUEST_INTERVAL_MS);
      const query = new URLSearchParams({
        vs_currency: String(currency).toLowerCase(),
        symbols: symbolBatch.join(','),
        include_tokens: 'all',
        order: 'market_cap_desc',
        per_page: String(MAX_MARKETS_PER_REQUEST),
        page: String(page),
        sparkline: 'false',
        price_change_percentage: '7d,30d',
        precision: 'full',
      });
      const result = await fetchJson(`${API}/coins/markets?${query}`, options);
      if (!Array.isArray(result)) throw new Error('CoinGecko returned invalid venue market data.');
      rows.push(...result);
      hasRequestedPage = true;
      if (result.length < MAX_MARKETS_PER_REQUEST) break;
    }
  }
  return { rows, symbolCount: symbols.length };
}

function combineMarketRows(marketRows, venueMarketRows) {
  const combined = [...marketRows];
  const includedIds = new Set(marketRows.map(({ id }) => id));
  let supplementalCount = 0;
  for (const row of venueMarketRows) {
    if (includedIds.has(row?.id)) continue;
    includedIds.add(row?.id);
    combined.push(row);
    supplementalCount += 1;
  }
  return { rows: combined, supplementalCount };
}

export async function getDiamondQuantities(portfolioConfig, options = {}) {
  const {
    attempts,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    fetchImpl,
    sleepImpl,
    tradingRegion = REVOLUT_X_REGION,
    quoteCurrencyMode: quoteCurrencyModeInput = DEFAULT_QUOTE_CURRENCY_MODE,
    usdPerEur: usdPerEurInput,
    ...rankingOptions
  } = options;
  const currency = String(portfolioConfig.currency ?? 'eur').toUpperCase();
  const quoteCurrencyMode = normalizeQuoteCurrencyMode(quoteCurrencyModeInput);
  const quoteCurrencies = quoteCurrenciesForMode(quoteCurrencyMode);
  const pause = sleepImpl ?? sleep;
  const [marketRows, tradingVenue] = await Promise.all([
    fetchLatestDiamondMarkets(
      currency,
      candidateLimit,
      { attempts, fetchImpl, sleepImpl },
    ),
    fetchRevolutXTradingVenue(quoteCurrencyMode, {
      region: tradingRegion,
      attempts,
      fetchImpl,
      sleepImpl,
    }),
  ]);
  await pause(COINGECKO_REQUEST_INTERVAL_MS);
  const { rows: venueMarketRows, symbolCount } = await fetchVenueDiamondMarkets(
    currency,
    tradingVenue,
    { attempts, fetchImpl, sleepImpl: pause },
  );
  let exchangeRate = { usdPerEur: null, source: null };
  if (quoteCurrencies.includes('USD')) {
    if (usdPerEurInput === undefined) {
      await pause(COINGECKO_REQUEST_INTERVAL_MS);
      exchangeRate = await fetchEurUsdRate({ attempts, fetchImpl, sleepImpl: pause });
    } else {
      exchangeRate = {
        usdPerEur: positiveNumber(usdPerEurInput, 'USD per EUR exchange rate'),
        source: 'provided',
      };
    }
  }
  const combinedMarkets = combineMarketRows(marketRows, venueMarketRows);
  return {
    ...rankDiamondQuantities(combinedMarkets.rows, portfolioConfig, {
      ...rankingOptions,
      quoteCurrencyMode,
      usdPerEur: exchangeRate.usdPerEur,
      exchangeRateSource: exchangeRate.source,
      tradingVenue,
    }),
    discovery: {
      marketCapCandidateLimit: Number(candidateLimit),
      activeVenueSymbolCount: symbolCount,
      supplementalCandidateCount: combinedMarkets.supplementalCount,
    },
    requestedCandidateLimit: Number(candidateLimit),
  };
}

export async function getDiamondQuantitiesForQuoteModes(
  portfolioConfig,
  quoteCurrencyModesInput,
  options = {},
) {
  if (!Array.isArray(quoteCurrencyModesInput) || quoteCurrencyModesInput.length === 0) {
    throw new Error('Quote currency modes must contain at least one mode.');
  }
  const quoteCurrencyModes = [...new Set(
    quoteCurrencyModesInput.map((mode) => normalizeQuoteCurrencyMode(mode)),
  )];
  const {
    attempts,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    fetchImpl,
    sleepImpl,
    tradingRegion = REVOLUT_X_REGION,
    usdPerEur: usdPerEurInput,
    ...rankingOptions
  } = options;
  const currency = String(portfolioConfig.currency ?? 'eur').toUpperCase();
  const requestedQuoteCurrencies = new Set(
    quoteCurrencyModes.flatMap((mode) => quoteCurrenciesForMode(mode)),
  );
  const venueMode = requestedQuoteCurrencies.size > 1
    ? 'MIXED'
    : quoteCurrencyModes[0];
  const pause = sleepImpl ?? sleep;
  const [marketRows, tradingVenue] = await Promise.all([
    fetchLatestDiamondMarkets(
      currency,
      candidateLimit,
      { attempts, fetchImpl, sleepImpl },
    ),
    fetchRevolutXTradingVenue(venueMode, {
      region: tradingRegion,
      attempts,
      fetchImpl,
      sleepImpl,
    }),
  ]);
  await pause(COINGECKO_REQUEST_INTERVAL_MS);
  const { rows: venueMarketRows, symbolCount } = await fetchVenueDiamondMarkets(
    currency,
    tradingVenue,
    { attempts, fetchImpl, sleepImpl: pause },
  );
  let exchangeRate = { usdPerEur: null, source: null };
  if (requestedQuoteCurrencies.has('USD')) {
    if (usdPerEurInput === undefined) {
      await pause(COINGECKO_REQUEST_INTERVAL_MS);
      exchangeRate = await fetchEurUsdRate({ attempts, fetchImpl, sleepImpl: pause });
    } else {
      exchangeRate = {
        usdPerEur: positiveNumber(usdPerEurInput, 'USD per EUR exchange rate'),
        source: 'provided',
      };
    }
  }
  const combinedMarkets = combineMarketRows(marketRows, venueMarketRows);
  const observedAt = rankingOptions.observedAt ?? new Date();

  return quoteCurrencyModes.map((quoteCurrencyMode) => {
    const quoteCurrencies = quoteCurrenciesForMode(quoteCurrencyMode);
    return {
      ...rankDiamondQuantities(combinedMarkets.rows, portfolioConfig, {
        ...rankingOptions,
        observedAt,
        quoteCurrencyMode,
        usdPerEur: exchangeRate.usdPerEur,
        exchangeRateSource: exchangeRate.source,
        tradingVenue: {
          ...tradingVenue,
          quoteCurrencyMode,
          quoteCurrencies,
          quoteCurrency: quoteCurrencies.length === 1 ? quoteCurrencies[0] : null,
        },
      }),
      discovery: {
        marketCapCandidateLimit: Number(candidateLimit),
        activeVenueSymbolCount: symbolCount,
        supplementalCandidateCount: combinedMarkets.supplementalCount,
      },
      requestedCandidateLimit: Number(candidateLimit),
    };
  });
}

async function main([investedAmount, limit, candidateLimit, quoteCurrencyMode]) {
  const portfolioConfig = JSON.parse(await readFile(
    path.join(repositoryRoot, 'data', 'portfolio.json'),
    'utf8',
  ));
  const options = {};
  if (investedAmount !== undefined) options.investedAmount = investedAmount;
  if (limit !== undefined) options.limit = limit;
  if (candidateLimit !== undefined) options.candidateLimit = candidateLimit;
  if (quoteCurrencyMode !== undefined) options.quoteCurrencyMode = quoteCurrencyMode;
  const result = await getDiamondQuantities(portfolioConfig, options);
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