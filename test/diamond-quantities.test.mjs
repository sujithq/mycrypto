import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDiamondQuantities,
  rankDiamondQuantities,
} from '../.github/skills/diamond-quantities/scripts/rank-diamond-quantities.mjs';

const portfolioConfig = {
  currency: 'eur',
  supportedAssets: [
    { id: 'established', symbol: 'EST', name: 'Established', thesis: 'Established test asset.' },
    { id: 'local-only', symbol: 'LOCAL', name: 'Local Only', thesis: 'Must not be invented.' },
  ],
};

function marketRow(overrides) {
  return {
    id: 'candidate',
    symbol: 'candidate',
    name: 'Candidate',
    current_price: 0.001,
    market_cap: 10_000_000,
    market_cap_rank: 500,
    fully_diluted_valuation: 11_111_111,
    total_volume: 2_000_000,
    circulating_supply: 90_000_000_000,
    total_supply: 100_000_000_000,
    max_supply: 100_000_000_000,
    price_change_percentage_7d_in_currency: 10,
    price_change_percentage_30d_in_currency: 20,
    last_updated: '2026-08-24T11:59:00.000Z',
    ...overrides,
  };
}

test('ranks liquid low-price candidates with market-cap headroom', () => {
  const result = rankDiamondQuantities([
    marketRow({ id: 'cheap-growth', symbol: 'cheap', name: 'Cheap Growth' }),
    marketRow({
      id: 'established',
      symbol: 'est',
      name: 'Established API Name',
      current_price: 2,
      market_cap: 100_000_000,
      market_cap_rank: 200,
      total_volume: 20_000_000,
      circulating_supply: 45_000_000,
      total_supply: 50_000_000,
      max_supply: 50_000_000,
    }),
  ], portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
  });

  assert.deepEqual(result.assets.map(({ id }) => id), ['cheap-growth', 'established']);
  assert.equal(result.assets[0].quantity, 50_000);
  assert.equal(result.assets[0].growthMultipleToReferenceMarketCap, 100);
  assert.equal(result.assets[0].potentialValueAtReferenceMarketCap, 5_000);
  assert.equal(result.assets[0].diamondScore, 92.625);
  assert.equal(result.assets[0].isSupported, false);
  assert.equal(result.assets[0].thesis, null);
  assert.equal(result.assets[1].isSupported, true);
  assert.equal(result.assets[1].name, 'Established');
  assert.equal(result.assets.some(({ id }) => id === 'local-only'), false);
});

test('fetches live growth signals without using ATH data or invented IDs', async () => {
  let requestedUrl;
  const rows = [marketRow({ id: 'verified-new', symbol: 'new', name: 'Verified New' })];
  const result = await getDiamondQuantities(portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    candidateLimit: 1,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => rows };
    },
  });

  assert.equal(requestedUrl.pathname, '/api/v3/coins/markets');
  assert.equal(requestedUrl.searchParams.get('ids'), null);
  assert.equal(requestedUrl.searchParams.get('price_change_percentage'), '7d,30d');
  assert.equal(requestedUrl.searchParams.get('precision'), 'full');
  assert.equal(result.assets[0].id, 'verified-new');
  assert.equal(result.assets[0].isSupported, false);
});

test('excludes illiquid assets even when EUR 50 buys an enormous quantity', () => {
  const result = rankDiamondQuantities([
    marketRow({
      id: 'illiquid',
      symbol: 'illiquid',
      name: 'Illiquid',
      current_price: 1e-9,
      total_volume: 50_000,
    }),
    marketRow({
      id: 'no-headroom',
      symbol: 'full',
      name: 'No Headroom',
      market_cap: 1_000_000_000,
      total_volume: 20_000_000,
    }),
  ], portfolioConfig, { observedAt: '2026-08-24T12:00:00.000Z' });

  assert.equal(result.assets.length, 0);
  assert.deepEqual(result.excluded, [
    { id: 'illiquid', reason: 'Trading volume is below 100000.' },
    { id: 'no-headroom', reason: 'Market capitalization has no headroom below 1000000000.' },
  ]);
});

test('rejects invalid ranking inputs', () => {
  assert.throws(() => rankDiamondQuantities([], portfolioConfig, {
    investedAmount: 0,
  }), /Invested amount must be a positive number/);
  assert.throws(() => rankDiamondQuantities([], portfolioConfig, {
    referenceMarketCap: 10_000_000,
  }), /must exceed the minimum market capitalization/);
  assert.throws(() => rankDiamondQuantities({}, portfolioConfig), /invalid market data/);
});