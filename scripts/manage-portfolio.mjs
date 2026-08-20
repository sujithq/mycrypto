import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAnalysisReport, isValidProfile, resolveProfilePortfolio } from '../src/model.js';

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
      ...(item.quantity !== undefined ? { quantity: Number(item.quantity) } : {}),
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

const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
if (!update.profile || typeof update.profile !== 'object') {
  throw new Error('The update must contain a profile.');
}
const profile = {
  id: update.profile.id,
  name: update.profile.name,
  type: update.profile.type === 'real' ? 'real' : 'simulated',
  ...(update.profile.buyDate ? { buyDate: update.profile.buyDate } : {}),
  portfolio: normalizePortfolio(update.profile.portfolio, config.supportedAssets),
};
console.log('Validating managed portfolio profile…');
if (!isValidProfile(profile, supportedIds, config.defaultPortfolio, config.totalInvestment)) {
  throw new Error(`Profile must have a valid ID, name, and positive holdings${profile.type === 'real' ? ' with quantities and cost values' : ` totalling ${config.totalInvestment}`}; repeated assets require different buy dates.`);
}
const profiles = [...(config.profiles ?? [])];
const profileIndex = profiles.findIndex(({ id }) => id === profile.id);
if (profileIndex >= 0) profiles[profileIndex] = profile;
else profiles.push(profile);
profiles.sort((a, b) => a.id.localeCompare(b.id));

const next = {
  ...config,
  timeframeDays,
  profiles,
};

const market = JSON.parse(await readFile(marketPath, 'utf8'));
console.log('Generating the trailing portfolio report…');
const defaultProfile = profiles.find(({ id }) => id === config.defaultProfileId) ?? profiles[0];
const defaultPortfolio = resolveProfilePortfolio(defaultProfile, config.defaultPortfolio);
const report = createAnalysisReport(market.history ?? [], defaultPortfolio, new Date().toISOString(), timeframeDays);
console.log('Writing portfolio defaults and report…');
await writeFile(portfolioPath, `${JSON.stringify(next, null, 2)}\n`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log('Updated managed portfolio defaults.');
