import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTopAthQuantities,
  rankAthQuantities,
} from '../.github/skills/top-ath-quantities/scripts/rank-ath-quantities.mjs';

const portfolioConfig = {
  currency: 'eur',
  supportedAssets: [
    { id: 'large-unit', symbol: 'LARGE', name: 'Large Unit', thesis: 'Large-unit test asset.' },
    { id: 'best-upside', symbol: 'BEST', name: 'Best Upside', thesis: 'Best-upside test asset.' },
    { id: 'small-unit', symbol: 'SMALL', name: 'Small Unit', thesis: 'Small-unit test asset.' },
  ],
};

const marketRows = [
  { id: 'large-unit', symbol: 'large', name: 'Large Unit', current_price: 10, ath: 20, ath_date: '2025-01-01T00:00:00.000Z', market_cap: 3_000_000, market_cap_rank: 1, total_volume: 300_000, last_updated: '2026-08-24T11:59:00.000Z' },
  { id: 'best-upside', symbol: 'best', name: 'Best Upside', current_price: 0.01, ath: 0.1, ath_date: '2024-01-01T00:00:00.000Z', market_cap: 2_000_000, market_cap_rank: 2, total_volume: 200_000, last_updated: '2026-08-24T11:59:00.000Z' },
  { id: 'small-unit', symbol: 'small', name: 'Small Unit', current_price: 0.001, ath: 0.002, ath_date: '2023-01-01T00:00:00.000Z', market_cap: 1_000_000, market_cap_rank: 3, total_volume: 100_000, last_updated: '2026-08-24T11:59:00.000Z' },
  { id: 'verified-new', symbol: 'new', name: 'Verified New', current_price: 0.1, ath: 2, ath_date: '2022-01-01T00:00:00.000Z', market_cap: 900_000, market_cap_rank: 4, total_volume: 90_000, last_updated: '2026-08-24T11:59:00.000Z' },
];

test('ranks live CoinGecko assets including verified assets outside the local registry', () => {
  const result = rankAthQuantities(marketRows, portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    limit: 2,
  });

  assert.equal(result.currency, 'EUR');
  assert.equal(result.investedAmountPerAsset, 50);
  assert.deepEqual(result.assets.map(({ id }) => id), ['verified-new', 'best-upside']);
  assert.deepEqual(result.assets[0], {
    rank: 1,
    id: 'verified-new',
    symbol: 'NEW',
    name: 'Verified New',
    thesis: null,
    isSupported: false,
    investedAmount: 50,
    quantity: 500,
    buyDate: '2026-08-24',
    currentPrice: 0.1,
    ath: 2,
    athDate: '2022-01-01T00:00:00.000Z',
    upsideMultiple: 20,
    upsideToAthPct: 1900,
    potentialValueAtAth: 1_000,
    marketCap: 900_000,
    marketCapRank: 4,
    totalVolume: 90_000,
    lastUpdated: '2026-08-24T11:59:00.000Z',
  });
  assert.equal(result.assets[1].isSupported, true);
  assert.equal(result.assets[1].thesis, 'Best-upside test asset.');
});

test('fetches the latest market-cap candidate universe without inventing IDs', async () => {
  let requestedUrl;
  const result = await getTopAthQuantities(portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    limit: 1,
    candidateLimit: 4,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => marketRows };
    },
  });

  assert.equal(requestedUrl.pathname, '/api/v3/coins/markets');
  assert.equal(requestedUrl.searchParams.get('vs_currency'), 'eur');
  assert.equal(requestedUrl.searchParams.get('ids'), null);
  assert.equal(requestedUrl.searchParams.get('order'), 'market_cap_desc');
  assert.equal(requestedUrl.searchParams.get('per_page'), '4');
  assert.equal(requestedUrl.searchParams.get('page'), '1');
  assert.equal(requestedUrl.searchParams.get('precision'), 'full');
  assert.equal(result.assets[0].id, 'verified-new');
});

test('reports invalid live rows and never adds assets absent from CoinGecko results', () => {
  const result = rankAthQuantities([
    { ...marketRows[0], current_price: null },
    { ...marketRows[1], ath: null },
    { ...marketRows[3], total_volume: 0 },
  ], portfolioConfig, { observedAt: '2026-08-24T12:00:00.000Z' });

  assert.equal(result.assets.length, 0);
  assert.equal(result.assets.some(({ id }) => id === 'small-unit'), false);
  assert.deepEqual(result.excluded, [
    { id: 'large-unit', reason: 'CoinGecko returned no valid current price.' },
    { id: 'best-upside', reason: 'CoinGecko returned no valid ATH.' },
    { id: 'verified-new', reason: 'CoinGecko returned no positive trading volume.' },
  ]);
});

test('rejects invalid ranking inputs', () => {
  assert.throws(() => rankAthQuantities(marketRows, portfolioConfig, {
    investedAmount: 0,
  }), /Invested amount must be a positive number/);
  assert.throws(() => rankAthQuantities(marketRows, portfolioConfig, {
    limit: 1.5,
  }), /Limit must be a positive integer/);
  assert.throws(() => rankAthQuantities({}, portfolioConfig), /invalid market data/);
});