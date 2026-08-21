import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateIntradayAssetSeries,
  calculateIntradayPriceSeries,
  canUseLiveMarketSnapshot,
  canUseIntradayMarketSnapshot,
  createIntradayMarketSnapshot,
  createLiveMarketSnapshot,
  isLiveMarketRefreshDue,
  mergeLiveMarketSnapshot,
  normalizeLiveMarketSettings,
} from '../src/live-market.js';

const ids = ['bitcoin', 'ethereum'];
const publishedMarket = {
  updatedAt: '2026-08-20T12:00:00.000Z',
  currency: 'eur',
  assets: {
    bitcoin: { price: 60_000 },
    ethereum: { price: 2_000 },
  },
  history: [
    { date: '2026-08-19', prices: { bitcoin: 59_000, ethereum: 1_900 } },
    { date: '2026-08-20', prices: { bitcoin: 60_000, ethereum: 2_000 } },
  ],
};

function quotes() {
  return [
    {
      id: 'bitcoin',
      current_price: 61_000,
      price_change_percentage_24h: 2.1,
      market_cap: 1_200_000,
      market_cap_rank: 1,
      image: 'bitcoin.png',
    },
    {
      id: 'ethereum',
      current_price: 2_100,
      price_change_percentage_24h: 3.2,
      market_cap: 250_000,
      market_cap_rank: 2,
      image: 'ethereum.png',
    },
  ];
}

test('normalizes persisted live market settings', () => {
  assert.deepEqual(normalizeLiveMarketSettings({ enabled: true, intervalMinutes: '15' }), {
    enabled: true,
    intervalMinutes: 15,
  });
  assert.deepEqual(normalizeLiveMarketSettings({ enabled: 'true', intervalMinutes: 7 }), {
    enabled: false,
    intervalMinutes: 5,
  });
});

test('creates and validates a complete newer live market snapshot', () => {
  const snapshot = createLiveMarketSnapshot(quotes(), ids, 'eur', '2026-08-20T12:05:00.000Z');
  assert.equal(snapshot.assets.bitcoin.price, 61_000);
  assert.equal(snapshot.assets.ethereum.change24hPct, 3.2);
  assert.equal(canUseLiveMarketSnapshot(snapshot, publishedMarket, ids), true);
  assert.equal(canUseLiveMarketSnapshot({ ...snapshot, currency: 'usd' }, publishedMarket, ids), false);
  assert.throws(() => createLiveMarketSnapshot(quotes().slice(0, 1), ids, 'eur'));
});

test('expires live browser data at the configured interval', () => {
  const snapshot = { updatedAt: '2026-08-20T12:00:00.000Z' };
  assert.equal(isLiveMarketRefreshDue(snapshot, 5, Date.parse('2026-08-20T12:04:59.999Z')), false);
  assert.equal(isLiveMarketRefreshDue(snapshot, 5, Date.parse('2026-08-20T12:05:00.000Z')), true);
});

test('normalizes intraday prices and calculates real and simulated position values', () => {
  const snapshot = createIntradayMarketSnapshot({
    prices: [
      [Date.parse('2026-08-19T23:55:00.000Z'), 60_000],
      [Date.parse('2026-08-20T12:00:00.000Z'), 61_000],
    ],
  }, 'bitcoin', 'eur', '2026-08-20T12:00:30.000Z');

  assert.equal(canUseIntradayMarketSnapshot(snapshot, 'bitcoin', 'eur'), true);
  assert.equal(canUseIntradayMarketSnapshot(snapshot, 'ethereum', 'eur'), false);
  assert.deepEqual(calculateIntradayAssetSeries(snapshot, { quantity: 0.001 }), [
    { timestamp: Date.parse('2026-08-19T23:55:00.000Z'), value: 60 },
    { timestamp: Date.parse('2026-08-20T12:00:00.000Z'), value: 61 },
  ]);
  assert.deepEqual(calculateIntradayAssetSeries(snapshot, {
    investedAmount: 50,
    startPrice: 50_000,
    buyDate: '2026-08-20',
  }), [
    { timestamp: Date.parse('2026-08-20T12:00:00.000Z'), value: 61 },
  ]);
  assert.deepEqual(calculateIntradayPriceSeries(snapshot, { buyDate: '2026-08-20' }), [
    { timestamp: Date.parse('2026-08-20T12:00:00.000Z'), value: 61_000 },
  ]);
  assert.throws(() => createIntradayMarketSnapshot({ prices: [[Date.now(), 60_000]] }, 'bitcoin', 'eur'));
  assert.throws(() => createIntradayMarketSnapshot({ prices: {} }, 'bitcoin', 'eur'));
  assert.equal(canUseIntradayMarketSnapshot({ ...snapshot, prices: [...snapshot.prices].reverse() }, 'bitcoin', 'eur'), false);
  assert.equal(canUseIntradayMarketSnapshot({ ...snapshot, prices: [null, ...snapshot.prices] }, 'bitcoin', 'eur'), false);
});

test('overlays live quotes and replaces only the current UTC point', () => {
  const snapshot = createLiveMarketSnapshot(quotes(), ids, 'eur', '2026-08-20T12:05:00.000Z');
  const merged = mergeLiveMarketSnapshot(publishedMarket, snapshot);
  assert.equal(merged.updatedAt, snapshot.updatedAt);
  assert.equal(merged.assets.bitcoin.price, 61_000);
  assert.deepEqual(merged.history, [
    publishedMarket.history[0],
    { date: '2026-08-20', prices: { bitcoin: 61_000, ethereum: 2_100 } },
  ]);
  assert.equal(publishedMarket.assets.bitcoin.price, 60_000);
});