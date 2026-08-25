import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateAssetPriceSeries,
  calculateAssetSeries,
  calculateHoldings,
  calculateRealHoldings,
  calculateRealSeries,
  calculateSeries,
  createAnalysisReport,
  createProfileReports,
  filterHistoryByTimeframe,
  filterSeriesByRange,
  isValidProfile,
  isValidPortfolio,
  isValidRealPortfolio,
  parseRealPortfolioJson,
  resolveProfilePortfolio,
} from '../src/model.js';
import {
  combineHistoricalPrices,
  findFirstHistoryGap,
  getBackfillStartDate,
  getHistoryBackfillPlan,
  getMarketUpdatePlan,
  getMissingHistoricalAssetIds,
  getPublicHistoryStartDate,
  getSupportedAssetIds,
  mergeHistoricalPrices,
  updateHistory,
} from '../scripts/update-market-data.mjs';
import { loadProfiles } from '../scripts/load-profiles.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const portfolio = Array.from({ length: 10 }, (_, index) => ({
  id: `asset-${index}`,
  symbol: `A${index}`,
  investedAmount: 50,
}));
const supportedIds = new Set(portfolio.map(({ id }) => id));
const prices = (multiplier) => Object.fromEntries(portfolio.map(({ id }, index) => [id, (index + 1) * multiplier]));
const history = [
  { date: '2026-08-11', prices: prices(10) },
  { date: '2026-08-18', prices: prices(11) },
];

test('calculates one asset evolution from its purchase date', () => {
  const assetHistory = [
    { date: '2026-08-10', prices: { 'asset-0': 8 } },
    { date: '2026-08-11', prices: { 'asset-0': 10 } },
    { date: '2026-08-12', prices: { 'asset-0': 12 } },
  ];
  const asset = { ...portfolio[0], buyDate: '2026-08-11' };
  assert.deepEqual(calculateAssetSeries(asset, assetHistory), [
    { date: '2026-08-11', value: 50 },
    { date: '2026-08-12', value: 60 },
  ]);
  assert.deepEqual(calculateAssetSeries({ ...asset, quantity: 5 }, assetHistory), [
    { date: '2026-08-11', value: 50 },
    { date: '2026-08-12', value: 60 },
  ]);
  assert.deepEqual(calculateAssetPriceSeries(asset, assetHistory), [
    { date: '2026-08-11', value: 10 },
    { date: '2026-08-12', value: 12 },
  ]);
});

test('calculates asset evolution from position quantity instead of portfolio value', () => {
  const asset = { ...portfolio[0], quantity: 2, investedAmount: 500, buyDate: '2026-08-11' };
  assert.deepEqual(calculateAssetSeries(asset, history), [
    { date: '2026-08-11', value: 20 },
    { date: '2026-08-18', value: 22 },
  ]);
  assert.notDeepEqual(calculateAssetSeries(asset, history), calculateSeries([asset], history));
});

test('filters asset evolution by trailing and year-to-date ranges', () => {
  const series = [
    { date: '2016-08-19', value: 10 },
    { date: '2016-08-20', value: 20 },
    { date: '2021-08-19', value: 30 },
    { date: '2021-08-20', value: 32 },
    { date: '2023-08-19', value: 34 },
    { date: '2023-08-20', value: 36 },
    { date: '2025-08-19', value: 38 },
    { date: '2025-08-20', value: 39 },
    { date: '2025-12-31', value: 40 },
    { date: '2026-01-01', value: 42 },
    { date: '2026-07-20', value: 46 },
    { date: '2026-08-13', value: 48 },
    { date: '2026-08-19', value: 49 },
    { date: '2026-08-20', value: 50 },
  ];
  assert.deepEqual(filterSeriesByRange(series, '1d'), series.slice(-2));
  assert.deepEqual(filterSeriesByRange(series, '1w'), series.slice(-3));
  assert.deepEqual(filterSeriesByRange(series, '1m'), series.slice(-4));
  assert.deepEqual(filterSeriesByRange(series, '1y'), series.slice(7));
  assert.deepEqual(filterSeriesByRange(series, '3y'), series.slice(5));
  assert.deepEqual(filterSeriesByRange(series, '5y'), series.slice(3));
  assert.deepEqual(filterSeriesByRange(series, '10y'), series.slice(1));
  assert.deepEqual(filterSeriesByRange(series, 'ytd'), series.slice(9));
  assert.equal(filterSeriesByRange(series, 'all'), series);
});

function completeHistoryWindow(timestamp) {
  const rows = [];
  const end = new Date(timestamp);
  end.setUTCHours(0, 0, 0, 0);
  for (
    let day = Date.parse(`${getPublicHistoryStartDate(timestamp)}T00:00:00Z`), multiplier = 1;
    day < end.getTime();
    day += 86_400_000, multiplier += 1
  ) {
    rows.push({ date: new Date(day).toISOString().slice(0, 10), prices: prices(multiplier) });
  }
  return rows;
}

test('selects every supported asset once for market updates', () => {
  assert.deepEqual(getSupportedAssetIds({
    supportedAssets: [...portfolio, portfolio[0], { id: 'supported-only' }],
    defaultPortfolio: portfolio,
  }), [...supportedIds, 'supported-only']);
});

test('loads and validates file-based profiles', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'data', 'portfolio.json'), 'utf8'));
  const profiles = await loadProfiles(root, config);
  assert.equal(profiles.some(({ id }) => id === config.defaultProfileId), true);
  assert.equal(profiles.every(({ id }) => /^[a-z0-9-]+$/.test(id)), true);
});

test('provides a thesis for every supported asset', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'data', 'portfolio.json'), 'utf8'));
  assert.equal(config.supportedAssets.every(({ thesis }) => typeof thesis === 'string' && thesis.trim()), true);
  config.defaultPortfolio.forEach(({ id, thesis }) => {
    assert.equal(config.supportedAssets.find((asset) => asset.id === id)?.thesis, thesis);
  });
});

test('adds the first market snapshot to empty history', () => {
  const snapshot = { date: '2026-08-20', prices: prices(12) };
  assert.deepEqual(updateHistory([], snapshot), [snapshot]);
});

test('preserves cached market history beyond the public API window', () => {
  const cached = Array.from({ length: 367 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    prices: prices(index + 1),
  }));
  const snapshot = { date: '2026-08-20', prices: prices(400) };
  const updated = updateHistory(cached, snapshot);
  assert.equal(updated.length, 368);
  assert.deepEqual(updated[0], cached[0]);
  assert.deepEqual(updated.at(-1), snapshot);
});

test('clamps public API backfills to the latest 365 UTC dates', () => {
  const now = Date.parse('2026-08-20T08:50:16Z');
  assert.equal(getPublicHistoryStartDate(now), '2025-08-21');
  assert.equal(getBackfillStartDate('2025-01-01', now), '2025-08-21');
  assert.equal(getBackfillStartDate('2026-01-01', now), '2026-01-01');
});

test('combines complete historical prices into daily snapshots', () => {
  const timestamp = Date.parse('2026-01-01T00:00:00Z');
  assert.deepEqual(combineHistoricalPrices({
    bitcoin: [[timestamp, 100]],
    ethereum: [[timestamp, 10]],
  }, ['bitcoin', 'ethereum']), [
    { date: '2026-01-01', prices: { bitcoin: 100, ethereum: 10 } },
  ]);
});

test('finds the first missing calendar date in local history', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const complete = completeHistoryWindow(now);
  const missingDate = '2026-08-12';
  const incomplete = complete.filter(({ date }) => date !== missingDate);
  assert.equal(findFirstHistoryGap(incomplete, [...supportedIds], now), missingDate);
  assert.deepEqual(getHistoryBackfillPlan(incomplete, [...supportedIds], now), {
    gapDate: missingDate,
    startDate: missingDate,
    assetIds: [...supportedIds],
  });
});

test('fetches only assets with missing prices from the first gap onward', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const complete = completeHistoryWindow(now);
  delete complete.find(({ date }) => date === '2026-08-12').prices['asset-4'];
  delete complete.find(({ date }) => date === '2026-08-18').prices['asset-7'];
  assert.deepEqual(getMissingHistoricalAssetIds(
    complete,
    [...supportedIds],
    '2026-08-12',
    now,
  ), ['asset-4', 'asset-7']);
  assert.deepEqual(getHistoryBackfillPlan(complete, [...supportedIds], now), {
    gapDate: '2026-08-12',
    startDate: '2026-08-12',
    assetIds: ['asset-4', 'asset-7'],
  });
});

test('skips history requests when the public window is already complete', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const complete = completeHistoryWindow(now);
  assert.deepEqual(getHistoryBackfillPlan(complete, [...supportedIds], now), {
    gapDate: null,
    startDate: null,
    assetIds: [],
  });
});

test('fills the public history window when the cache is empty', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  assert.deepEqual(getHistoryBackfillPlan([], [...supportedIds], now), {
    gapDate: '2025-08-21',
    startDate: '2025-08-21',
    assetIds: [...supportedIds],
  });
});

test('reuses complete quotes for five minutes and refreshes stale intraday quotes', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const ids = [...supportedIds];
  const current = { date: '2026-08-20', prices: prices(400) };
  const market = {
    updatedAt: '2026-08-20T11:57:00.000Z',
    assets: Object.fromEntries(ids.map((id, index) => [id, { price: index + 1 }])),
    history: [...completeHistoryWindow(now), current],
  };

  assert.deepEqual(getMarketUpdatePlan(market, ids, now), {
    fetchCurrentQuotes: false,
    history: { gapDate: null, startDate: null, assetIds: [] },
  });
  assert.equal(getMarketUpdatePlan({
    ...market,
    updatedAt: '2026-08-20T11:55:00.000Z',
  }, ids, now).fetchCurrentQuotes, true);
  assert.equal(getMarketUpdatePlan(market, ids, now, true).fetchCurrentQuotes, true);
});

test('fetches current quotes when the same-day cache is incomplete', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const ids = [...supportedIds];
  const current = { date: '2026-08-20', prices: prices(400) };
  const assets = Object.fromEntries(ids.map((id, index) => [id, { price: index + 1 }]));
  delete assets['asset-4'];

  assert.equal(getMarketUpdatePlan({
    updatedAt: '2026-08-20T11:57:00.000Z',
    assets,
    history: [...completeHistoryWindow(now), current],
  }, ids, now).fetchCurrentQuotes, true);
});

test('merges downloaded history without replacing existing asset prices', () => {
  const timestamp = Date.parse('2026-08-11T00:00:00Z');
  const merged = mergeHistoricalPrices(history, {
    'asset-0': [[timestamp, 999]],
    'supported-only': [[timestamp, 25]],
  });
  assert.deepEqual(merged[0], {
    date: '2026-08-11',
    prices: { ...prices(10), 'supported-only': 25 },
  });
  assert.deepEqual(merged[1], history[1]);
});

test('accepts positive purchases totalling €500', () => {
  assert.equal(isValidPortfolio(portfolio, supportedIds), true);
  assert.equal(isValidPortfolio([{ ...portfolio[0], investedAmount: 500 }], supportedIds), true);
  assert.equal(isValidPortfolio([], supportedIds), false);
  assert.equal(isValidPortfolio(portfolio.map((item, index) => ({ ...item, investedAmount: index ? 50 : 40 })), supportedIds), false);
  assert.equal(isValidPortfolio(portfolio.map((item, index) => index ? item : { ...item, buyDate: '2026-02-31' }), supportedIds), false);
});

test('accepts repeated assets only with different buy dates', () => {
  const repeated = [
    { ...portfolio[0], investedAmount: 250, buyDate: '2026-08-11' },
    { ...portfolio[0], investedAmount: 250, buyDate: '2026-08-18' },
  ];
  assert.equal(isValidPortfolio(repeated, supportedIds), true);
  assert.equal(isValidPortfolio(repeated.map((item) => ({ ...item, buyDate: '2026-08-11' })), supportedIds), false);
  assert.equal(isValidPortfolio(repeated.map(({ buyDate, ...item }) => item), supportedIds), false);
});

test('resolves and validates a profile-wide buy date', () => {
  const profile = { id: '2026-03', name: 'March 2026', buyDate: '2026-03-01' };
  const resolved = resolveProfilePortfolio(profile, portfolio);
  assert.equal(resolved.every(({ buyDate }) => buyDate === '2026-03-01'), true);
  assert.equal(isValidProfile(profile, supportedIds, portfolio), true);
  assert.equal(isValidProfile({ ...profile, id: 'March 2026' }, supportedIds, portfolio), false);
  assert.equal(isValidProfile({ ...profile, buyDate: '2026-02-31' }, supportedIds, portfolio), false);
});

test('validates profiles with custom portfolios', () => {
  const profile = { id: 'custom', name: 'Custom', portfolio };
  assert.equal(isValidProfile(profile, supportedIds, portfolio), true);
  assert.equal(isValidProfile({ ...profile, portfolio: portfolio.slice(1) }, supportedIds, portfolio), false);
});

test('validates real portfolios without requiring the simulated €500 total', () => {
  const real = [
    { ...portfolio[0], investedAmount: 1200, quantity: 0.05, buyDate: '2026-08-11' },
    { ...portfolio[1], investedAmount: 800, quantity: 0.4, buyDate: '2026-08-18' },
  ];
  assert.equal(isValidRealPortfolio(real, supportedIds), true);
  assert.equal(isValidProfile({ id: 'client-a', name: 'Client A', type: 'real', portfolio: real }, supportedIds, portfolio), true);
  assert.equal(isValidRealPortfolio(real.map(({ quantity, ...item }) => item), supportedIds), false);
  assert.equal(isValidRealPortfolio(real.map((item) => ({ ...item, quantity: 0 })), supportedIds), false);
});

test('parses pasted real holdings by symbol or asset id', () => {
  const supportedAssets = portfolio.map(({ id, symbol }) => ({ id, symbol, name: id }));
  assert.deepEqual(parseRealPortfolioJson(JSON.stringify([
    { symbol: 'A0', quantity: 2, cost: 100, buyDate: '2026-08-11' },
  ]), supportedAssets), [{
    ...supportedAssets[0],
    investedAmount: 100,
    quantity: 2,
    buyDate: '2026-08-11',
    thesis: 'Manually managed real portfolio holding.',
  }]);
  assert.throws(() => parseRealPortfolioJson('[{"symbol":"NOPE"}]', supportedAssets), /Unsupported asset/);
  assert.throws(() => parseRealPortfolioJson('[{"symbol":"A0"}]', supportedAssets), /positive quantity and invested amount/);
});

test('parses generated real profile JSON', () => {
  const supportedAssets = portfolio.map(({ id, symbol }) => ({ id, symbol, name: id }));
  const generatedProfile = {
    id: 'client-a',
    name: 'Client A',
    type: 'real',
    portfolio: [
      { id: supportedAssets[0].id, investedAmount: 100, quantity: 2, buyDate: '2026-08-11' },
    ],
  };

  assert.deepEqual(parseRealPortfolioJson(JSON.stringify(generatedProfile), supportedAssets), [{
    ...supportedAssets[0],
    investedAmount: 100,
    quantity: 2,
    buyDate: '2026-08-11',
    thesis: 'Manually managed real portfolio holding.',
  }]);
});

test('normalizes real holding investment fields to investedAmount', () => {
  const supportedAssets = portfolio.map(({ id, symbol }) => ({ id, symbol, name: id }));
  const parsed = parseRealPortfolioJson(JSON.stringify([
    { symbol: 'A0', investedAmount: 100, quantity: 2 },
    { symbol: 'A1', amount: 50, quantity: 1 },
  ]), supportedAssets);

  assert.deepEqual(parsed.map(({ investedAmount }) => investedAmount), [100, 50]);
  assert.equal(parsed.some((item) => Object.hasOwn(item, 'amount')), false);
});

test('uses a profile buy date as the fallback for custom portfolio items', () => {
  const customPortfolio = portfolio.map((item, index) =>
    index === 0 ? { ...item, buyDate: '2026-02-01' } : item);
  const profile = {
    id: 'custom-dates',
    name: 'Custom dates',
    buyDate: '2026-03-01',
    portfolio: customPortfolio,
  };
  const resolved = resolveProfilePortfolio(profile, portfolio);
  assert.equal(resolved[0].buyDate, '2026-02-01');
  assert.equal(resolved[1].buyDate, '2026-03-01');
  assert.equal(isValidProfile(profile, supportedIds, portfolio), true);
});

test('adds configured asset metadata to sparse profile holdings', () => {
  const profile = {
    id: 'test',
    name: 'Test',
    buyDate: '2026-03-01',
    portfolio: [
      { id: portfolio[0].id, investedAmount: 250 },
      { id: 'supported-only', investedAmount: 250, thesis: 'Profile description.' },
    ],
  };
  const supportedAssets = [
    { id: portfolio[0].id, symbol: 'A0', name: 'Asset 0' },
    { id: 'supported-only', symbol: 'SO', name: 'Supported Only' },
  ];
  const resolved = resolveProfilePortfolio(profile, portfolio, supportedAssets);
  assert.deepEqual(resolved[0], {
    ...supportedAssets[0],
    ...portfolio[0],
    investedAmount: 250,
    buyDate: '2026-03-01',
  });
  assert.deepEqual(resolved[1], {
    ...supportedAssets[1],
    investedAmount: 250,
    thesis: 'Profile description.',
    buyDate: '2026-03-01',
  });
});

test('validates repeated profile assets using the profile buy-date fallback', () => {
  const profile = {
    id: 'repeat-fallback',
    name: 'Repeat fallback',
    buyDate: '2026-08-11',
    portfolio: [
      { ...portfolio[0], investedAmount: 250 },
      { ...portfolio[0], investedAmount: 250, buyDate: '2026-08-18' },
    ],
  };
  assert.equal(isValidProfile(profile, supportedIds, portfolio), true);
});

test('calculates portfolio evolution from each asset baseline', () => {
  assert.deepEqual(calculateSeries(portfolio, history), [
    { date: '2026-08-11', value: 500 },
    { date: '2026-08-18', value: 550 },
  ]);
});

test('uses optional buy dates as each asset baseline', () => {
  const datedPortfolio = portfolio.map((item, index) => index === 0 ? { ...item, buyDate: '2026-08-18' } : item);
  const series = calculateSeries(datedPortfolio, history);
  assert.deepEqual(series, [
    { date: '2026-08-18', value: 545 },
  ]);
  const report = createAnalysisReport(history, datedPortfolio, '2026-08-19T00:00:00.000Z');
  assert.equal(report.periodStart, '2026-08-18');
});

test('uses separate baselines for repeated asset purchases', () => {
  const repeated = [
    { ...portfolio[0], investedAmount: 250, buyDate: '2026-08-11' },
    { ...portfolio[0], investedAmount: 250, buyDate: '2026-08-18' },
  ];
  assert.deepEqual(calculateSeries(repeated, history), [
    { date: '2026-08-18', value: 525 },
  ]);
});

test('filters history by trailing timeframe', () => {
  assert.deepEqual(filterHistoryByTimeframe(history, 3), [
    { date: '2026-08-18', prices: prices(11) },
  ]);
});

test('calculates current holding values and returns', () => {
  const assets = Object.fromEntries(portfolio.map(({ id }, index) => [id, {
    price: (index + 1) * 12,
    change24hPct: 2,
  }]));
  const holdings = calculateHoldings(portfolio, history, assets);
  assert.equal(holdings[0].value, 60);
  assert.equal(holdings[0].returnPct, 20);
});

test('calculates real holdings from quantities and invested amounts', () => {
  const real = [{ ...portfolio[0], investedAmount: 40, quantity: 2, buyDate: '2026-08-11' }];
  const assets = { [portfolio[0].id]: { price: 30, change24hPct: 2 } };
  assert.deepEqual(calculateRealSeries(real, history), [
    { date: '2026-08-11', value: 20 },
    { date: '2026-08-18', value: 22 },
  ]);
  const [holding] = calculateRealHoldings(real, assets);
  assert.equal(holding.value, 60);
  assert.equal(holding.startPrice, 20);
  assert.equal(holding.returnPct, 50);
});

test('creates an allocation-weighted trailing report', () => {
  const result = createAnalysisReport(history, portfolio, '2026-08-19T00:00:00.000Z');
  assert.equal(result.status, 'Strong momentum');
  assert.equal(result.portfolioChangePct, 10);
  assert.equal(result.periodStart, '2026-08-11');
  assert.equal(result.periodEnd, '2026-08-18');
  assert.deepEqual(result.leadingPerformers, [
    { symbol: 'A0', changePct: 10 },
    { symbol: 'A1', changePct: 10 },
    { symbol: 'A2', changePct: 10 },
  ]);
  assert.deepEqual(result.laggingPerformers, [
    { symbol: 'A9', changePct: 10 },
    { symbol: 'A8', changePct: 10 },
    { symbol: 'A7', changePct: 10 },
  ]);
});

test('creates an identified report for every published profile', () => {
  const generatedAt = '2026-08-19T00:00:00.000Z';
  const extraAsset = { id: 'supported-only', symbol: 'ONLY', name: 'Supported only' };
  const completeHistory = history.map((entry, index) => ({
    ...entry,
    prices: { ...entry.prices, [extraAsset.id]: 10 + index },
  }));
  const profiles = [
    { id: 'default', name: 'Default' },
    {
      id: 'extra',
      name: 'Extra',
      type: 'real',
      portfolio: [{ id: extraAsset.id, investedAmount: 500, quantity: 50, buyDate: '2026-08-11' }],
    },
  ];
  const result = createProfileReports(completeHistory, profiles, {
    defaultPortfolio: portfolio,
    supportedAssets: [...portfolio, extraAsset],
    timeframeDays: 366,
  }, generatedAt);

  assert.equal(result.generatedAt, generatedAt);
  assert.deepEqual(Object.keys(result.reports), ['default', 'extra']);
  assert.deepEqual(result.reports.extra.profile, {
    id: 'extra',
    name: 'Extra',
    type: 'real',
  });
  assert.equal(result.reports.extra.bestPerformer.symbol, 'ONLY');
});

test('does not publish a partial report when an asset lacks prices', () => {
  const incomplete = history.map((entry) => {
    const next = { ...entry, prices: { ...entry.prices } };
    delete next.prices['asset-9'];
    return next;
  });
  const result = createAnalysisReport(incomplete, portfolio, '2026-08-19T00:00:00.000Z');
  assert.equal(result.status, 'Insufficient data');
  assert.equal(result.portfolioChangePct, null);
});
