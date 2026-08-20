import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPublicHistoryStartDate } from '../../../../scripts/update-market-data.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const API = 'https://api.coingecko.com/api/v3';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeDate(dateInput) {
  if (dateInput === undefined || dateInput === null || String(dateInput).trim() === '') return null;
  const date = String(dateInput).trim();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a valid date in YYYY-MM-DD format.');
  }
  return date;
}

export function calculateMarketQuantity(assetInput, investedAmountInput, portfolioConfig, market, dateInput) {
  const assetKey = String(assetInput ?? '').trim().toLowerCase();
  const investedAmount = Number(investedAmountInput);
  const date = normalizeDate(dateInput);
  if (!assetKey) throw new Error('Provide an asset symbol or CoinGecko ID.');
  if (!Number.isFinite(investedAmount) || investedAmount <= 0) {
    throw new Error('Invested amount must be a positive number.');
  }

  const asset = portfolioConfig.supportedAssets?.find(({ id, symbol }) =>
    id.toLowerCase() === assetKey || symbol.toLowerCase() === assetKey);
  if (!asset) throw new Error(`Unsupported asset: ${assetInput}`);

  const historicalSnapshot = date
    ? market.history?.find((entry) => entry.date === date)
    : null;
  if (date && !historicalSnapshot) throw new Error(`No market snapshot for ${date}.`);

  const price = date
    ? historicalSnapshot.prices?.[asset.id]
    : market.assets?.[asset.id]?.price;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`No valid market price for ${asset.symbol}${date ? ` on ${date}` : ''}.`);
  }

  return {
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    investedAmount,
    currency: String(market.currency ?? portfolioConfig.currency ?? '').toUpperCase(),
    price,
    quantity: investedAmount / price,
    date: date ?? market.updatedAt?.slice(0, 10) ?? null,
    updatedAt: market.updatedAt ?? null,
    source: market.source ?? null,
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
        headers: { accept: 'application/json', 'user-agent': 'mycrypto-market-quantity/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const detail = (await response.text()).slice(0, 300);
      lastError = new Error(`CoinGecko request failed (${response.status}): ${detail}`);
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      if (attempt < attempts) {
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 5_000;
        await sleepImpl(delay);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(attempt * 5_000);
    }
  }
  throw lastError ?? new Error('CoinGecko request failed.');
}

export async function fetchHistoricalPrice(assetId, currency, date, options) {
  const from = Date.parse(`${date}T00:00:00Z`) / 1_000;
  const to = from + 86_400;
  const url = `${API}/coins/${encodeURIComponent(assetId)}/market_chart/range?vs_currency=${encodeURIComponent(currency)}&from=${from}&to=${to}`;
  const result = await fetchJson(url, options);
  const samples = (result?.prices ?? [])
    .filter(([timestamp, price]) =>
      Number.isFinite(timestamp)
      && Number.isFinite(price)
      && new Date(timestamp).toISOString().slice(0, 10) === date);
  if (samples.length === 0) throw new Error(`CoinGecko returned no price for ${assetId} on ${date}.`);
  const [timestamp, price] = samples.at(-1);
  return { price, timestamp: new Date(timestamp).toISOString() };
}

export async function calculateMarketQuantityWithFallback(
  assetInput,
  investedAmountInput,
  portfolioConfig,
  market,
  dateInput,
  options,
) {
  try {
    return calculateMarketQuantity(assetInput, investedAmountInput, portfolioConfig, market, dateInput);
  } catch (error) {
    const date = normalizeDate(dateInput);
    const isDatedCacheMiss = date
      && (error.message === `No market snapshot for ${date}.`
        || error.message.includes(` on ${date}.`));
    if (!isDatedCacheMiss) throw error;

    const assetKey = String(assetInput).trim().toLowerCase();
    const asset = portfolioConfig.supportedAssets.find(({ id, symbol }) =>
      id.toLowerCase() === assetKey || symbol.toLowerCase() === assetKey);
    const currency = String(market.currency ?? portfolioConfig.currency).toLowerCase();
    const { now = Date.now(), ...requestOptions } = options ?? {};
    const publicStart = getPublicHistoryStartDate(now);
    if (date < publicStart) {
      throw new Error(`No cached market price for ${asset.symbol} on ${date}. CoinGecko's public API only provides the latest 365 days; the earliest retrievable full UTC date is ${publicStart}.`);
    }
    const online = await fetchHistoricalPrice(asset.id, currency, date, requestOptions);
    const result = calculateMarketQuantity(assetInput, investedAmountInput, portfolioConfig, {
      ...market,
      history: [{ date, prices: { [asset.id]: online.price } }],
    }, date);
    return {
      ...result,
      priceOrigin: 'online',
      priceTimestamp: online.timestamp,
    };
  }
}

async function main([assetInput, investedAmountInput, dateInput]) {
  const [portfolioConfig, market] = await Promise.all([
    readFile(path.join(repositoryRoot, 'data', 'portfolio.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'data', 'market.json'), 'utf8').then(JSON.parse),
  ]);
  const result = await calculateMarketQuantityWithFallback(
    assetInput,
    investedAmountInput,
    portfolioConfig,
    market,
    dateInput,
  );
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