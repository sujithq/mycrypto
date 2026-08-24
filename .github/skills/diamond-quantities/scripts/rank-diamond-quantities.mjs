import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const API = 'https://api.coingecko.com/api/v3';
const DEFAULT_INVESTED_AMOUNT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_CANDIDATE_LIMIT = 1_000;
const MAX_CANDIDATE_LIMIT = 1_000;
const MAX_MARKETS_PER_REQUEST = 250;
const DEFAULT_MIN_MARKET_CAP = 10_000_000;
const DEFAULT_REFERENCE_MARKET_CAP = 1_000_000_000;
const DEFAULT_MIN_TOTAL_VOLUME = 100_000;
const DEFAULT_MIN_LIQUIDITY_RATIO = 0.01;

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
} = {}) {
  if (!Array.isArray(marketRows)) throw new Error('CoinGecko returned invalid market data.');

  const investedAmount = positiveNumber(investedAmountInput, 'Invested amount');
  const limit = positiveInteger(limitInput, 'Limit');
  const observedAt = isoTimestamp(observedAtInput);
  const minMarketCap = positiveNumber(minMarketCapInput, 'Minimum market capitalization');
  const referenceMarketCap = positiveNumber(referenceMarketCapInput, 'Reference market capitalization');
  const minTotalVolume = positiveNumber(minTotalVolumeInput, 'Minimum total volume');
  const minLiquidityRatio = positiveNumber(minLiquidityRatioInput, 'Minimum liquidity ratio');
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
    currency: String(portfolioConfig.currency ?? 'eur').toUpperCase(),
    investedAmountPerAsset: investedAmount,
    requestedLimit: limit,
    candidateCount: quotesById.size,
    eligibleCount: eligible.length,
    observedAt,
    source: 'CoinGecko',
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
    },
    assets,
    excluded,
  };
}

async function fetchJson(url, {
  attempts = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'mycrypto-diamond-quantities/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : '';
      lastError = new Error(`CoinGecko request failed (${response.status}): ${detail}`);
      const retryAfterHeader = response.headers?.get?.('retry-after');
      const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
        ? Number.NaN
        : Number(retryAfterHeader);
      if (attempt < attempts) {
        await sleepImpl(Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 5_000);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(attempt * 5_000);
    }
  }
  throw lastError ?? new Error('CoinGecko request failed.');
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
    ...rankingOptions
  } = options;
  const marketRows = await fetchLatestDiamondMarkets(
    portfolioConfig.currency ?? 'eur',
    candidateLimit,
    { attempts, fetchImpl, sleepImpl },
  );
  return {
    ...rankDiamondQuantities(marketRows, portfolioConfig, rankingOptions),
    requestedCandidateLimit: Number(candidateLimit),
  };
}

async function main([investedAmount, limit, candidateLimit]) {
  const portfolioConfig = JSON.parse(await readFile(
    path.join(repositoryRoot, 'data', 'portfolio.json'),
    'utf8',
  ));
  const options = {};
  if (investedAmount !== undefined) options.investedAmount = investedAmount;
  if (limit !== undefined) options.limit = limit;
  if (candidateLimit !== undefined) options.candidateLimit = candidateLimit;
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