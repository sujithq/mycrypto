import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAnalysisReport } from '../src/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolioPath = path.join(root, 'data', 'portfolio.json');
const marketPath = path.join(root, 'data', 'market.json');
const reportPath = path.join(root, 'data', 'weekly-report.json');
const API = 'https://api.coingecko.com/api/v3';

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

export function getPortfolioAssetIds(portfolio) {
  return [...new Set(portfolio.map(({ id }) => id))];
}

export function updateHistory(history, snapshot) {
  const next = history.filter((entry) => entry.date !== snapshot.date);
  return [...next, snapshot].sort((a, b) => a.date.localeCompare(b.date)).slice(-366);
}

async function main() {
  console.log('Loading portfolio and existing market data…');
  const portfolioConfig = JSON.parse(await readFile(portfolioPath, 'utf8'));
  const market = JSON.parse(await readFile(marketPath, 'utf8'));
  const ids = getPortfolioAssetIds(portfolioConfig.defaultPortfolio);
  if (ids.length === 0) throw new Error('The configured portfolio contains no assets.');
  const currency = portfolioConfig.currency;
  const url = `${API}/coins/markets?vs_currency=${currency}&ids=${ids.map(encodeURIComponent).join(',')}&price_change_percentage=24h`;
  console.log(`Fetching current quotes for ${ids.length} assets…`);
  const quotes = await fetchJson(url);

  const quoteIds = new Set(Array.isArray(quotes) ? quotes.map(({ id }) => id) : []);
  if (quoteIds.size !== ids.length || ids.some((id) => !quoteIds.has(id))) {
    throw new Error('CoinGecko returned incomplete market quotes.');
  }
  console.log(`Received complete quotes for ${quotes.length} assets.`);

  const now = new Date().toISOString();
  const date = utcDate();
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
  const history = updateHistory(Array.isArray(market.history) ? market.history : [], snapshot);

  console.log('Writing current market data…');
  await writeFile(marketPath, `${JSON.stringify({
    updatedAt: now,
    currency,
    source: 'CoinGecko',
    assets,
    history,
  }, null, 2)}\n`);

  console.log('Generating and writing the trailing portfolio report…');
  const report = createAnalysisReport(history, portfolioConfig.defaultPortfolio, now, portfolioConfig.timeframeDays);
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
