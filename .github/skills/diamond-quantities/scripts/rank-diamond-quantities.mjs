import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const API = 'https://api.coingecko.com/api/v3';
const REVOLUT_X_API = 'https://revx.revolut.com/api';
const REVOLUT_X_REGION = 'EEA';
const REVOLUT_X_REQUEST_INTERVAL_MS = 1_000;
const DEFAULT_INVESTED_AMOUNT = 50;
const DEFAULT_QUOTE_CURRENCY_MODE = 'EUR';
const MAX_USD_INVESTMENT_EUR = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 1_000;
const MAX_CANDIDATE_LIMIT = 1_000;
const MAX_MARKETS_PER_REQUEST = 250;
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

  for (const quote of marketRows) {
    const id = String(quote?.id ?? '').trim();
    if (!id) {
      excluded.push({ id: null, reason: 'CoinGecko returned market data without a canonical ID.' });
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
    if (!canonicalSymbol || !canonicalName) {
      excluded.push({ id, reason: 'CoinGecko returned incomplete canonical metadata.' });
      continue;
    }
    let tradingPair = null;
    let quoteOrderAmount = null;
    const pairsByQuote = tradingVenue?.pairsByBase.get(canonicalSymbol);
    if (tradingVenue && !pairsByQuote) {
      excluded.push({
        id,
        reason: `No active ${tradingVenue.name} ${quoteCurrencies
          .map((quoteCurrency) => `${canonicalSymbol}/${quoteCurrency}`)
          .join(' or ')} market in ${tradingVenue.region}.`,
      });
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
      excluded.push({
        id,
        reason: pairRejections[0] ?? `No active ${tradingVenue.name} ${quoteCurrencies
          .map((quoteCurrency) => `${canonicalSymbol}/${quoteCurrency}`)
          .join(' or ')} market in ${tradingVenue.region}.`,
      });
      continue;
    }
    if (tradingPair && (!tradingPair.currencyName || tradingPair.currencyStatus !== 'active')) {
      excluded.push({
        id,
        reason: `${tradingVenue.name} currency identity for ${canonicalSymbol} is not active and complete.`,
      });
      continue;
    }
    if (tradingPair && !hasVerifiedTradingIdentity(id, canonicalSymbol, canonicalName, tradingPair)) {
      excluded.push({
        id,
        reason: `CoinGecko identity ${canonicalName} (${canonicalSymbol}) does not match ${tradingVenue.name} ${tradingPair.currencyName} (${tradingPair.base}).`,
      });
      continue;
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      excluded.push({ id, reason: 'CoinGecko returned no valid current price.' });
      continue;
    }
    if (!Number.isFinite(marketCap) || marketCap < minMarketCap) {
      excluded.push({ id, reason: `Market capitalization is below ${minMarketCap}.` });
      continue;
    }
    if (marketCap >= referenceMarketCap) {
      excluded.push({ id, reason: `Market capitalization has no headroom below ${referenceMarketCap}.` });
      continue;
    }
    if (!Number.isFinite(totalVolume) || totalVolume < minTotalVolume) {
      excluded.push({ id, reason: `Trading volume is below ${minTotalVolume}.` });
      continue;
    }
    const liquidityRatio = totalVolume / marketCap;
    if (liquidityRatio < minLiquidityRatio) {
      excluded.push({ id, reason: `Volume-to-market-cap ratio is below ${minLiquidityRatio}.` });
      continue;
    }
    if (!Number.isFinite(priceChange7dPct) || !Number.isFinite(priceChange30dPct)) {
      excluded.push({ id, reason: 'CoinGecko returned incomplete 7-day or 30-day momentum.' });
      continue;
    }
    const supply = supplyMetrics(quote, marketCap);
    if (!supply) {
      excluded.push({ id, reason: 'CoinGecko returned insufficient circulating-supply data.' });
      continue;
    }
    if (!Number.isFinite(lastUpdated)) {
      excluded.push({ id, reason: 'CoinGecko returned no valid update timestamp.' });
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

  const assets = eligible
    .sort((left, right) => right.diamondScore - left.diamondScore
      || right.potentialValueAtReferenceMarketCap - left.potentialValueAtReferenceMarketCap
      || right.liquidityRatio - left.liquidityRatio
      || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((asset, index) => ({ rank: index + 1, ...asset }));

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
    excluded,
  };
}

async function fetchJson(url, {
  attempts = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  source = 'CoinGecko',
  userAgent = 'mycrypto-diamond-quantities/1.0',
  retryAfterUnit = 'seconds',
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
      if (attempt < attempts) {
        const retryAfterMultiplier = retryAfterUnit === 'milliseconds' ? 1 : 1_000;
        await sleepImpl(Number.isFinite(retryAfter)
          ? retryAfter * retryAfterMultiplier
          : attempt * 5_000);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(attempt * 5_000);
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
  for (let page = 1; page <= pageCount; page += 1) {
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
  const exchangeRate = quoteCurrencies.includes('USD')
    ? (usdPerEurInput === undefined
        ? await fetchEurUsdRate({ attempts, fetchImpl, sleepImpl })
        : { usdPerEur: positiveNumber(usdPerEurInput, 'USD per EUR exchange rate'), source: 'provided' })
    : { usdPerEur: null, source: null };
  return {
    ...rankDiamondQuantities(marketRows, portfolioConfig, {
      ...rankingOptions,
      quoteCurrencyMode,
      usdPerEur: exchangeRate.usdPerEur,
      exchangeRateSource: exchangeRate.source,
      tradingVenue,
    }),
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
  const exchangeRate = requestedQuoteCurrencies.has('USD')
    ? (usdPerEurInput === undefined
        ? await fetchEurUsdRate({ attempts, fetchImpl, sleepImpl })
        : { usdPerEur: positiveNumber(usdPerEurInput, 'USD per EUR exchange rate'), source: 'provided' })
    : { usdPerEur: null, source: null };
  const observedAt = rankingOptions.observedAt ?? new Date();

  return quoteCurrencyModes.map((quoteCurrencyMode) => {
    const quoteCurrencies = quoteCurrenciesForMode(quoteCurrencyMode);
    return {
      ...rankDiamondQuantities(marketRows, portfolioConfig, {
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