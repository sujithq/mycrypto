import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateMarketQuantity,
  calculateMarketQuantityWithFallback,
} from '../.github/skills/market-quantity/scripts/calculate-market-quantity.mjs';

const portfolioConfig = {
  currency: 'eur',
  supportedAssets: [
    { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
    { id: 'tars-protocol', symbol: 'TAI', name: 'TARS AI' },
  ],
};

const market = {
  updatedAt: '2026-08-20T05:40:48.039Z',
  currency: 'eur',
  source: 'CoinGecko',
  assets: {
    bitcoin: { price: 50_000 },
    'tars-protocol': { price: 0.01 },
  },
  history: [
    {
      date: '2026-03-15',
      prices: { bitcoin: 60_000, 'tars-protocol': 0.02 },
    },
  ],
};

test('calculates quantity from a case-insensitive asset symbol', () => {
  assert.deepEqual(calculateMarketQuantity('tai', 250, portfolioConfig, market), {
    id: 'tars-protocol',
    symbol: 'TAI',
    name: 'TARS AI',
    amount: 250,
    currency: 'EUR',
    price: 0.01,
    quantity: 25_000,
    date: '2026-08-20',
    updatedAt: market.updatedAt,
    source: market.source,
  });
});

test('accepts a CoinGecko asset ID and numeric string amount', () => {
  const result = calculateMarketQuantity('bitcoin', '250', portfolioConfig, market);
  assert.equal(result.quantity, 0.005);
  assert.equal(result.amount, 250);
});

test('calculates quantity from an exact historical market date', () => {
  const result = calculateMarketQuantity('TAI', 250, portfolioConfig, market, '2026-03-15');
  assert.equal(result.price, 0.02);
  assert.equal(result.quantity, 12_500);
  assert.equal(result.date, '2026-03-15');
});

test('retrieves an uncached historical date from CoinGecko', async () => {
  const date = '2026-03-14';
  let requestedUrl;
  const result = await calculateMarketQuantityWithFallback(
    'TAI',
    250,
    portfolioConfig,
    market,
    date,
    {
      fetchImpl: async (url) => {
        requestedUrl = new URL(url);
        return {
          ok: true,
          json: async () => ({
            prices: [
              [Date.parse('2026-03-13T23:59:00Z'), 0.03],
              [Date.parse('2026-03-14T08:00:00Z'), 0.025],
              [Date.parse('2026-03-14T23:55:00Z'), 0.02],
              [Date.parse('2026-03-15T00:00:00Z'), 0.015],
            ],
          }),
        };
      },
    },
  );

  assert.equal(requestedUrl.pathname, '/api/v3/coins/tars-protocol/market_chart/range');
  assert.equal(requestedUrl.searchParams.get('vs_currency'), 'eur');
  assert.equal(requestedUrl.searchParams.get('from'), String(Date.parse(`${date}T00:00:00Z`) / 1_000));
  assert.equal(requestedUrl.searchParams.get('to'), String(Date.parse('2026-03-15T00:00:00Z') / 1_000));
  assert.equal(result.price, 0.02);
  assert.equal(result.quantity, 12_500);
  assert.equal(result.date, date);
  assert.equal(result.priceOrigin, 'online');
  assert.equal(result.priceTimestamp, '2026-03-14T23:55:00.000Z');
});

test('does not retrieve a historical date that is already cached', async () => {
  const result = await calculateMarketQuantityWithFallback(
    'TAI',
    250,
    portfolioConfig,
    market,
    '2026-03-15',
    { fetchImpl: async () => assert.fail('fetch should not be called') },
  );
  assert.equal(result.price, 0.02);
  assert.equal(result.priceOrigin, undefined);
});

test('uses an older cached date outside the public API window', async () => {
  const result = await calculateMarketQuantityWithFallback(
    'TAI',
    250,
    portfolioConfig,
    {
      ...market,
      history: [{ date: '2025-01-01', prices: { 'tars-protocol': 0.05 } }],
    },
    '2025-01-01',
    {
      now: Date.parse('2026-08-20T08:50:16Z'),
      fetchImpl: async () => assert.fail('fetch should not be called'),
    },
  );
  assert.equal(result.price, 0.05);
  assert.equal(result.quantity, 5_000);
  assert.equal(result.priceOrigin, undefined);
});

test('rejects an older uncached date before calling CoinGecko', async () => {
  let fetched = false;
  await assert.rejects(calculateMarketQuantityWithFallback(
    'TAI',
    250,
    portfolioConfig,
    market,
    '2025-01-01',
    {
      now: Date.parse('2026-08-20T08:50:16Z'),
      fetchImpl: async () => {
        fetched = true;
        assert.fail('fetch should not be called');
      },
    },
  ), /No cached market price.*earliest retrievable full UTC date is 2025-08-21/);
  assert.equal(fetched, false);
});

test('rejects online samples outside the requested date', async () => {
  await assert.rejects(calculateMarketQuantityWithFallback(
    'TAI',
    250,
    portfolioConfig,
    market,
    '2026-03-14',
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          prices: [
            [Date.parse('2026-03-13T23:59:00Z'), 0.03],
            [Date.parse('2026-03-15T00:00:00Z'), 0.015],
          ],
        }),
      }),
    },
  ), /CoinGecko returned no price for tars-protocol on 2026-03-14/);
});

test('rejects invalid inputs, unavailable dates, and missing prices', () => {
  assert.throws(() => calculateMarketQuantity('NOPE', 250, portfolioConfig, market), /Unsupported asset/);
  assert.throws(() => calculateMarketQuantity('TAI', 0, portfolioConfig, market), /positive number/);
  assert.throws(() => calculateMarketQuantity('TAI', 250, portfolioConfig, market, '03-15-2026'), /YYYY-MM-DD/);
  assert.throws(() => calculateMarketQuantity('TAI', 250, portfolioConfig, market, '2026-02-30'), /valid date/);
  assert.throws(() => calculateMarketQuantity('TAI', 250, portfolioConfig, market, '2026-03-14'), /No market snapshot/);
  assert.throws(() => calculateMarketQuantity('TAI', 250, portfolioConfig, {
    ...market,
    assets: {},
  }), /No valid market price/);
  assert.throws(() => calculateMarketQuantity('TAI', 250, portfolioConfig, {
    ...market,
    history: [{ date: '2026-03-15', prices: {} }],
  }, '2026-03-15'), /No valid market price/);
});