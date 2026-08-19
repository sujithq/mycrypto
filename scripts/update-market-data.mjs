import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolioPath = path.join(root, 'data', 'portfolio.json');
const marketPath = path.join(root, 'data', 'market.json');
const reportPath = path.join(root, 'data', 'weekly-report.json');
const API = 'https://api.coingecko.com/api/v3';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchJson(url, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'mycrypto-github-pages/1.0' },
    });
    if (response.ok) return response.json();
    if (attempt === attempts) {
      throw new Error(`CoinGecko request failed (${response.status}): ${await response.text()}`);
    }
    await sleep(attempt * 5_000);
  }
}

function utcDate(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function percentageChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0) return null;
  return ((end - start) / start) * 100;
}

export function createWeeklyReport(history, portfolio, generatedAt = new Date().toISOString()) {
  const recent = history.slice(-8);
  if (recent.length < 2) {
    return {
      generatedAt,
      periodStart: recent[0]?.date ?? null,
      periodEnd: recent.at(-1)?.date ?? null,
      status: 'Collecting data',
      summary: 'At least two daily closes are needed before performance can be analysed.',
      portfolioChangePct: null,
      bestPerformer: null,
      worstPerformer: null,
      observations: ['The report will become more reliable after seven daily closes.'],
    };
  }

  const start = recent[0];
  const end = recent.at(-1);
  const changes = portfolio
    .map((asset) => ({
      id: asset.id,
      symbol: asset.symbol,
      amount: asset.amount,
      changePct: percentageChange(start.prices[asset.id], end.prices[asset.id]),
    }))
    .filter((asset) => asset.changePct !== null);
  const totalAmount = changes.reduce((sum, asset) => sum + asset.amount, 0);
  const portfolioChangePct = totalAmount
    ? changes.reduce((sum, asset) => sum + asset.changePct * asset.amount, 0) / totalAmount
    : null;
  const ranked = [...changes].sort((a, b) => b.changePct - a.changePct);
  const best = ranked[0] ?? null;
  const worst = ranked.at(-1) ?? null;
  const status = portfolioChangePct === null
    ? 'Insufficient data'
    : portfolioChangePct >= 5
      ? 'Strong momentum'
      : portfolioChangePct <= -5
        ? 'Risk-off'
        : 'Range-bound';

  return {
    generatedAt,
    periodStart: start.date,
    periodEnd: end.date,
    status,
    summary: portfolioChangePct === null
      ? 'No comparable prices were available.'
      : `The model portfolio moved ${portfolioChangePct >= 0 ? '+' : ''}${portfolioChangePct.toFixed(2)}% over ${recent.length - 1} daily closes.`,
    portfolioChangePct: portfolioChangePct === null ? null : Number(portfolioChangePct.toFixed(4)),
    bestPerformer: best ? { symbol: best.symbol, changePct: Number(best.changePct.toFixed(4)) } : null,
    worstPerformer: worst ? { symbol: worst.symbol, changePct: Number(worst.changePct.toFixed(4)) } : null,
    observations: [
      best ? `${best.symbol} led the portfolio at ${best.changePct >= 0 ? '+' : ''}${best.changePct.toFixed(2)}%.` : 'No leader could be calculated.',
      worst ? `${worst.symbol} was weakest at ${worst.changePct >= 0 ? '+' : ''}${worst.changePct.toFixed(2)}%.` : 'No laggard could be calculated.',
      recent.length < 8
        ? `This early report uses ${recent.length} closes; the target weekly window is eight.`
        : 'Performance is allocation-weighted and compares eight daily closes.',
      'Momentum is descriptive, not predictive; review concentration and downside before acting.',
    ],
  };
}

async function bootstrapHistory(ids, currency) {
  const byDate = new Map();
  for (const [index, id] of ids.entries()) {
    const url = `${API}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${currency}&days=30&interval=daily`;
    const chart = await fetchJson(url);
    for (const [timestamp, price] of chart.prices ?? []) {
      const date = utcDate(timestamp);
      if (!byDate.has(date)) byDate.set(date, {});
      byDate.get(date)[id] = price;
    }
    if (index < ids.length - 1) await sleep(4_500);
  }
  return [...byDate]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, prices]) => ({ date, prices }));
}

async function main() {
  const portfolioConfig = JSON.parse(await readFile(portfolioPath, 'utf8'));
  const market = JSON.parse(await readFile(marketPath, 'utf8'));
  const ids = portfolioConfig.supportedAssets.map(({ id }) => id);
  const currency = portfolioConfig.currency;
  const url = `${API}/coins/markets?vs_currency=${currency}&ids=${ids.map(encodeURIComponent).join(',')}&price_change_percentage=24h`;
  const quotes = await fetchJson(url);

  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error('CoinGecko returned no market quotes.');
  }

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

  let history = Array.isArray(market.history) ? market.history : [];
  if (history.length === 0 && process.env.SKIP_BOOTSTRAP !== 'true') {
    console.log('Bootstrapping 30 days of daily market history…');
    history = await bootstrapHistory(ids, currency);
  }

  const snapshot = {
    date,
    prices: Object.fromEntries(quotes.map((quote) => [quote.id, quote.current_price])),
  };
  const existingIndex = history.findIndex((entry) => entry.date === date);
  if (existingIndex >= 0) history[existingIndex] = snapshot;
  else history.push(snapshot);
  history = history.sort((a, b) => a.date.localeCompare(b.date)).slice(-366);

  await writeFile(marketPath, `${JSON.stringify({
    updatedAt: now,
    currency,
    source: 'CoinGecko',
    assets,
    history,
  }, null, 2)}\n`);

  const report = createWeeklyReport(history, portfolioConfig.defaultPortfolio, now);
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
