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

export function rankAthQuantities(marketRows, portfolioConfig, {
  investedAmount: investedAmountInput = DEFAULT_INVESTED_AMOUNT,
  limit: limitInput = DEFAULT_LIMIT,
  observedAt: observedAtInput = new Date(),
} = {}) {
  if (!Array.isArray(marketRows)) throw new Error('CoinGecko returned invalid market data.');

  const investedAmount = positiveNumber(investedAmountInput, 'Invested amount');
  const limit = positiveInteger(limitInput, 'Limit');
  const observedAt = isoTimestamp(observedAtInput);
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
    const ath = Number(quote?.ath);
    const marketCap = Number(quote?.market_cap);
    const totalVolume = Number(quote?.total_volume);
    const lastUpdated = Date.parse(String(quote?.last_updated ?? ''));
    if (!canonicalSymbol || !canonicalName) {
      excluded.push({ id, reason: 'CoinGecko returned incomplete canonical metadata.' });
      continue;
    }
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      excluded.push({ id, reason: 'CoinGecko returned no valid current price.' });
      continue;
    }
    if (!Number.isFinite(ath) || ath <= 0) {
      excluded.push({ id, reason: 'CoinGecko returned no valid ATH.' });
      continue;
    }
    if (!Number.isFinite(marketCap) || marketCap <= 0) {
      excluded.push({ id, reason: 'CoinGecko returned no positive market capitalization.' });
      continue;
    }
    if (!Number.isFinite(totalVolume) || totalVolume <= 0) {
      excluded.push({ id, reason: 'CoinGecko returned no positive trading volume.' });
      continue;
    }
    if (!Number.isFinite(lastUpdated)) {
      excluded.push({ id, reason: 'CoinGecko returned no valid update timestamp.' });
      continue;
    }

    const supportedAsset = supportedById.get(id);
    const quantity = investedAmount / currentPrice;
    const upsideMultiple = ath / currentPrice;
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
      ath,
      athDate: quote.ath_date ?? null,
      upsideMultiple,
      upsideToAthPct: (upsideMultiple - 1) * 100,
      potentialValueAtAth: quantity * ath,
      marketCap,
      marketCapRank: Number.isFinite(Number(quote.market_cap_rank))
        ? Number(quote.market_cap_rank)
        : null,
      totalVolume,
      lastUpdated: new Date(lastUpdated).toISOString(),
    });
  }

  const assets = eligible
    .sort((left, right) => right.potentialValueAtAth - left.potentialValueAtAth
      || right.quantity - left.quantity
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
    rankingMetric: 'potentialValueAtAth',
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
        headers: { accept: 'application/json', 'user-agent': 'mycrypto-top-ath-quantities/1.0' },
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

export async function fetchLatestAthMarkets(
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
      precision: 'full',
    });
    const result = await fetchJson(`${API}/coins/markets?${query}`, options);
    if (!Array.isArray(result)) throw new Error('CoinGecko returned invalid market data.');
    rows.push(...result.slice(0, candidateLimit - rows.length));
    if (result.length < perPage) break;
  }
  return rows;
}

export async function getTopAthQuantities(portfolioConfig, options = {}) {
  const {
    attempts,
    candidateLimit = DEFAULT_CANDIDATE_LIMIT,
    fetchImpl,
    sleepImpl,
    ...rankingOptions
  } = options;
  const marketRows = await fetchLatestAthMarkets(
    portfolioConfig.currency ?? 'eur',
    candidateLimit,
    { attempts, fetchImpl, sleepImpl },
  );
  return {
    ...rankAthQuantities(marketRows, portfolioConfig, rankingOptions),
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
  const result = await getTopAthQuantities(portfolioConfig, options);
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