import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHoldings,
  calculateSeries,
  createAnalysisReport,
  filterHistoryByTimeframe,
  isValidProfile,
  isValidPortfolio,
  resolveProfilePortfolio,
} from '../src/model.js';
import { combineHistoricalPrices, getPortfolioAssetIds, updateHistory } from '../scripts/update-market-data.mjs';

const portfolio = Array.from({ length: 10 }, (_, index) => ({
  id: `asset-${index}`,
  symbol: `A${index}`,
  amount: 50,
}));
const supportedIds = new Set(portfolio.map(({ id }) => id));
const prices = (multiplier) => Object.fromEntries(portfolio.map(({ id }, index) => [id, (index + 1) * multiplier]));
const history = [
  { date: '2026-08-11', prices: prices(10) },
  { date: '2026-08-18', prices: prices(11) },
];

test('selects each configured portfolio asset once for market updates', () => {
  assert.deepEqual(getPortfolioAssetIds([...portfolio, portfolio[0]]), [...supportedIds]);
});

test('adds the first market snapshot to empty history', () => {
  const snapshot = { date: '2026-08-20', prices: prices(12) };
  assert.deepEqual(updateHistory([], snapshot), [snapshot]);
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

test('accepts exactly ten unique positive allocations totalling €500', () => {
  assert.equal(isValidPortfolio(portfolio, supportedIds), true);
  assert.equal(isValidPortfolio(portfolio.slice(0, 9), supportedIds), false);
  assert.equal(isValidPortfolio([...portfolio.slice(0, 9), portfolio[0]], supportedIds), false);
  assert.equal(isValidPortfolio(portfolio.map((item, index) => ({ ...item, amount: index ? 50 : 40 })), supportedIds), false);
  assert.equal(isValidPortfolio(portfolio.map((item, index) => index ? item : { ...item, buyDate: '2026-02-31' }), supportedIds), false);
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

test('creates an allocation-weighted trailing report', () => {
  const result = createAnalysisReport(history, portfolio, '2026-08-19T00:00:00.000Z');
  assert.equal(result.status, 'Strong momentum');
  assert.equal(result.portfolioChangePct, 10);
  assert.equal(result.periodStart, '2026-08-11');
  assert.equal(result.periodEnd, '2026-08-18');
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
