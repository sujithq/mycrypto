import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateHoldings,
  calculateSeries,
  createAnalysisReport,
  filterHistoryByTimeframe,
  isValidPortfolio,
} from '../src/model.js';

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

test('accepts exactly ten unique positive allocations totalling €500', () => {
  assert.equal(isValidPortfolio(portfolio, supportedIds), true);
  assert.equal(isValidPortfolio(portfolio.slice(0, 9), supportedIds), false);
  assert.equal(isValidPortfolio([...portfolio.slice(0, 9), portfolio[0]], supportedIds), false);
  assert.equal(isValidPortfolio(portfolio.map((item, index) => ({ ...item, amount: index ? 50 : 40 })), supportedIds), false);
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
