import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAnalysisReport, isValidPortfolio } from '../src/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portfolioPath = path.join(root, 'data', 'portfolio.json');
const marketPath = path.join(root, 'data', 'market.json');
const reportPath = path.join(root, 'data', 'weekly-report.json');

function parseUpdate() {
  const raw = process.env.PORTFOLIO_UPDATE_JSON;
  if (!raw) throw new Error('PORTFOLIO_UPDATE_JSON is required.');
  const update = JSON.parse(raw);
  if (!update || typeof update !== 'object') throw new Error('Portfolio update must be an object.');
  return update;
}

function normalizePortfolio(items, supportedAssets) {
  return items.map((item) => {
    const asset = supportedAssets.find(({ id }) => id === item.id);
    if (!asset) throw new Error(`Unsupported asset id: ${item.id}`);
    return {
      ...asset,
      amount: Number(item.amount),
      ...(item.buyDate ? { buyDate: item.buyDate } : {}),
      thesis: typeof item.thesis === 'string' && item.thesis.trim()
        ? item.thesis.trim()
        : 'Managed default portfolio selection.',
    };
  });
}

console.log('Loading portfolio update and current data…');
const config = JSON.parse(await readFile(portfolioPath, 'utf8'));
const update = parseUpdate();
const timeframeDays = Number(update.timeframeDays);
if (!Number.isInteger(timeframeDays) || timeframeDays < 1 || timeframeDays > 366) {
  throw new Error('timeframeDays must be an integer between 1 and 366.');
}

const defaultPortfolio = normalizePortfolio(update.defaultPortfolio, config.supportedAssets);
const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
console.log('Validating managed portfolio defaults…');
if (!isValidPortfolio(defaultPortfolio, supportedIds, config.totalInvestment)) {
  throw new Error(`Default portfolio must contain ten unique positive allocations totalling ${config.totalInvestment}.`);
}

const next = {
  ...config,
  timeframeDays,
  defaultPortfolio,
};

const market = JSON.parse(await readFile(marketPath, 'utf8'));
console.log('Generating the trailing portfolio report…');
const report = createAnalysisReport(market.history ?? [], defaultPortfolio, new Date().toISOString(), timeframeDays);
console.log('Writing portfolio defaults and report…');
await writeFile(portfolioPath, `${JSON.stringify(next, null, 2)}\n`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log('Updated managed portfolio defaults.');
