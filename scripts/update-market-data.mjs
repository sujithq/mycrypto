import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAnalysisReport, resolveProfilePortfolio } from '../src/model.js';
import { loadProfiles } from './load-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolioPath = path.join(root, 'data', 'portfolio.json');
const marketPath = path.join(root, 'data', 'market.json');
const reportPath = path.join(root, 'data', 'weekly-report.json');
const API = 'https://api.coingecko.com/api/v3';
const PUBLIC_HISTORY_DAYS = 365;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`Request attempt ${attempt} of ${attempts}…`);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'mycrypto-github-pages/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const detail = (await response.text()).slice(0, 300);
      lastError = new Error(`CoinGecko request failed (${response.status}): ${detail}`);
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      if (attempt < attempts) {
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 5_000;
        console.warn(`Request failed; retrying in ${delay / 1_000} seconds…`);
        await sleep(delay);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = attempt * 5_000;
        console.warn(`Request failed; retrying in ${delay / 1_000} seconds…`);
        await sleep(delay);
      }
    }
  }
  throw lastError ?? new Error('CoinGecko request failed.');
}

function utcDate(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function getSupportedAssetIds(portfolioConfig) {
  return [...new Set((portfolioConfig.supportedAssets ?? []).map(({ id }) => id))];
}

export function updateHistory(history, snapshot) {
  const next = history.filter((entry) => entry.date !== snapshot.date);
  return [...next, snapshot].sort((a, b) => a.date.localeCompare(b.date));
}

export function getPublicHistoryStartDate(timestamp = Date.now()) {
  const start = new Date(timestamp);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (PUBLIC_HISTORY_DAYS - 1));
  return utcDate(start.getTime());
}

export function getBackfillStartDate(startDate, timestamp = Date.now()) {
  const publicStart = getPublicHistoryStartDate(timestamp);
  return startDate < publicStart ? publicStart : startDate;
}

export function combineHistoricalPrices(seriesByAsset, ids) {
  const byDate = new Map();
  for (const id of ids) {
    for (const [timestamp, price] of seriesByAsset[id] ?? []) {
      if (!Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
      const date = utcDate(timestamp);
      const prices = byDate.get(date) ?? {};
      prices[id] = price;
      byDate.set(date, prices);
    }
  }
  return [...byDate]
    .filter(([, prices]) => ids.every((id) => Number.isFinite(prices[id])))
    .map(([date, prices]) => ({ date, prices }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function findFirstHistoryGap(history, ids, timestamp = Date.now()) {
  const end = new Date(timestamp);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);
  const endDate = utcDate(end.getTime());
  const byDate = new Map(history.map((entry) => [entry.date, entry]));
  const firstDate = [...byDate.keys()]
    .filter((date) => date <= endDate)
    .sort()[0];
  if (!firstDate) return null;

  for (let day = Date.parse(`${firstDate}T00:00:00Z`); day <= end.getTime(); day += 86_400_000) {
    const date = utcDate(day);
    const entry = byDate.get(date);
    if (!entry || ids.some((id) => !Number.isFinite(entry.prices?.[id]))) return date;
  }
  return null;
}

export function getHistoryBackfillPlan(history, ids, timestamp = Date.now()) {
  const gapDate = findFirstHistoryGap(history, ids, timestamp);
  const requestedStart = gapDate ?? getPublicHistoryStartDate(timestamp);
  return {
    gapDate,
    startDate: getBackfillStartDate(requestedStart, timestamp),
  };
}

export function mergeHistoricalPrices(history, seriesByAsset) {
  const byDate = new Map(history.map((entry) => [
    entry.date,
    { ...entry, prices: { ...entry.prices } },
  ]));
  for (const [id, series] of Object.entries(seriesByAsset)) {
    for (const [timestamp, price] of series) {
      if (!Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
      const date = utcDate(timestamp);
      const entry = byDate.get(date) ?? { date, prices: {} };
      if (!Number.isFinite(entry.prices[id])) entry.prices[id] = price;
      byDate.set(date, entry);
    }
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function backfillHistory(history, ids, currency, plan, timestamp = Date.now()) {
  const { gapDate, startDate } = plan;
  if (gapDate) {
    console.log(`Found local market-data gap at ${gapDate}.`);
  } else {
    console.log(`No local market-data gaps found; refreshing the latest ${PUBLIC_HISTORY_DAYS} UTC dates.`);
  }
  if (gapDate && startDate !== gapDate) {
    console.warn(`The first gap predates CoinGecko's public window; starting at ${startDate} and preserving older cached data.`);
  }
  console.log(`Refreshing ${ids.length} asset histories from ${startDate}…`);
  const from = Date.parse(`${startDate}T00:00:00Z`) / 1_000;
  const to = timestamp / 1_000;
  const seriesByAsset = {};
  for (const [index, id] of ids.entries()) {
    const url = `${API}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=${encodeURIComponent(currency)}&from=${from}&to=${to}`;
    const result = await fetchJson(url);
    if (!Array.isArray(result?.prices)) throw new Error(`CoinGecko returned no historical prices for ${id}.`);
    seriesByAsset[id] = result.prices;
    if (index < ids.length - 1) await sleep(5_000);
  }
  return mergeHistoricalPrices(history, seriesByAsset);
}

async function main() {
  console.log('Loading portfolio and existing market data…');
  const portfolioConfig = JSON.parse(await readFile(portfolioPath, 'utf8'));
  const market = JSON.parse(await readFile(marketPath, 'utf8'));
  const profiles = await loadProfiles(root, portfolioConfig);
  const ids = getSupportedAssetIds(portfolioConfig);
  if (ids.length === 0) throw new Error('The configuration contains no supported assets.');
  const currency = portfolioConfig.currency;
  const timestamp = Date.now();
  const existingHistory = Array.isArray(market.history) ? market.history : [];
  const backfillPlan = getHistoryBackfillPlan(existingHistory, ids, timestamp);
  const url = `${API}/coins/markets?vs_currency=${currency}&ids=${ids.map(encodeURIComponent).join(',')}&price_change_percentage=24h`;
  console.log(`Fetching current quotes for ${ids.length} assets…`);
  const quotes = await fetchJson(url);

  const quoteIds = new Set(Array.isArray(quotes) ? quotes.map(({ id }) => id) : []);
  if (quoteIds.size !== ids.length || ids.some((id) => !quoteIds.has(id))) {
    throw new Error('CoinGecko returned incomplete market quotes.');
  }
  console.log(`Received complete quotes for ${quotes.length} assets.`);

  const now = new Date(timestamp).toISOString();
  const date = utcDate(timestamp);
  const assets = Object.fromEntries(quotes.map((quote) => [
    quote.id,
    {
      price: quote.current_price,
      change24hPct: quote.price_change_percentage_24h,
      marketCap: quote.market_cap,
      rank: quote.market_cap_rank,
      image: quote.image,
    },
  ]));

  const snapshot = {
    date,
    prices: Object.fromEntries(quotes.map((quote) => [quote.id, quote.current_price])),
  };
  const historical = await backfillHistory(existingHistory, ids, currency, backfillPlan, timestamp);
  const history = updateHistory(historical, snapshot);

  console.log('Writing current market data…');
  await writeFile(marketPath, `${JSON.stringify({
    updatedAt: now,
    currency,
    source: 'CoinGecko',
    assets,
    history,
  }, null, 2)}\n`);

  console.log('Generating and writing the trailing portfolio report…');
  const defaultProfile = profiles
    .find(({ id }) => id === portfolioConfig.defaultProfileId);
  const defaultPortfolio = resolveProfilePortfolio(defaultProfile, portfolioConfig.defaultPortfolio);
  const report = createAnalysisReport(history, defaultPortfolio, now, portfolioConfig.timeframeDays);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Stored ${quotes.length} quotes and ${history.length} daily snapshots.`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
