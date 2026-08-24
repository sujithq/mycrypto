import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchRevolutXTradingVenue,
  getDiamondQuantities,
  getDiamondQuantitiesForQuoteModes,
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
  const requestedUrls = [];
  const rows = [marketRow({ id: 'verified-new', symbol: 'new', name: 'Verified New' })];
  const result = await getDiamondQuantities(portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    candidateLimit: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      requestedUrls.push(requestedUrl);
      let body = rows;
      if (requestedUrl.pathname.endsWith('/pairs')) {
        body = {
            'NEW/EUR': {
              base: 'NEW',
              quote: 'EUR',
              status: 'active',
              min_order_size_quote: '0.1',
              max_order_size_quote: '1000000',
            },
          };
      }
      else if (requestedUrl.pathname.endsWith('/currencies')) {
        body = {
          NEW: { symbol: 'NEW', name: 'Verified New', status: 'active' },
        };
      }
      return { ok: true, json: async () => body };
    },
  });

  const requestedUrl = requestedUrls.find(({ hostname }) => hostname === 'api.coingecko.com');
  assert.equal(requestedUrl.pathname, '/api/v3/coins/markets');
  assert.equal(requestedUrl.searchParams.get('ids'), null);
  assert.equal(requestedUrl.searchParams.get('price_change_percentage'), '7d,30d');
  assert.equal(requestedUrl.searchParams.get('precision'), 'full');
  const revolutUrls = requestedUrls.filter(({ hostname }) => hostname === 'revx.revolut.com');
  assert.deepEqual(revolutUrls.map(({ pathname }) => pathname), [
    '/api/1.0/public/configuration/pairs',
    '/api/1.0/public/configuration/currencies',
  ]);
  assert.ok(revolutUrls.every((url) => url.searchParams.get('region') === 'EEA'));
  assert.equal(result.assets[0].id, 'verified-new');
  assert.equal(result.assets[0].isSupported, false);
  assert.equal(result.assets[0].tradingPair, 'NEW/EUR');
});

test('uses a live EUR/USD rate for USD quote mode', async () => {
  const requestedUrls = [];
  const result = await getDiamondQuantities(portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    candidateLimit: 1,
    quoteCurrencyMode: 'dollar',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      requestedUrls.push(requestedUrl);
      let body = [marketRow({ id: 'usd-asset', symbol: 'usdasset', name: 'USD Asset' })];
      if (requestedUrl.pathname.endsWith('/exchange_rates')) {
        body = { rates: { eur: { value: 100 }, usd: { value: 120 } } };
      }
      else if (requestedUrl.pathname.endsWith('/pairs')) {
        body = {
          'USDASSET/USD': {
            base: 'USDASSET',
            quote: 'USD',
            status: 'active',
            min_order_size_quote: '0.1',
            max_order_size_quote: '1000000',
          },
        };
      }
      else if (requestedUrl.pathname.endsWith('/currencies')) {
        body = {
          USDASSET: { symbol: 'USDASSET', name: 'USD Asset', status: 'active' },
        };
      }
      return { ok: true, json: async () => body };
    },
  });

  assert.ok(requestedUrls.some(({ pathname }) => pathname.endsWith('/exchange_rates')));
  assert.equal(result.tradingVenue.quoteCurrencyMode, 'USD');
  assert.equal(result.tradingVenue.usdPerEur, 1.2);
  assert.equal(result.assets[0].tradingPair, 'USDASSET/USD');
  assert.equal(result.assets[0].tradingQuoteCurrency, 'USD');
  assert.equal(result.assets[0].quoteOrderAmount, 60);
  assert.equal(result.assets[0].investedAmount, 50);
});

test('ranks EUR, USD, and mixed modes from one live snapshot', async () => {
  const requestedUrls = [];
  const rankings = await getDiamondQuantitiesForQuoteModes(
    portfolioConfig,
    ['EUR', 'USD', 'MIXED'],
    {
      observedAt: '2026-08-24T12:00:00.000Z',
      candidateLimit: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        const requestedUrl = new URL(url);
        requestedUrls.push(requestedUrl);
        let body = [marketRow({ id: 'dual-asset', symbol: 'dual', name: 'Dual Asset' })];
        if (requestedUrl.pathname.endsWith('/exchange_rates')) {
          body = { rates: { eur: { value: 100 }, usd: { value: 120 } } };
        }
        else if (requestedUrl.pathname.endsWith('/pairs')) {
          body = {
            'DUAL/EUR': {
              base: 'DUAL',
              quote: 'EUR',
              status: 'active',
              min_order_size_quote: '0.1',
              max_order_size_quote: '1000000',
            },
            'DUAL/USD': {
              base: 'DUAL',
              quote: 'USD',
              status: 'active',
              min_order_size_quote: '0.1',
              max_order_size_quote: '1000000',
            },
          };
        }
        else if (requestedUrl.pathname.endsWith('/currencies')) {
          body = {
            DUAL: { symbol: 'DUAL', name: 'Dual Asset', status: 'active' },
          };
        }
        return { ok: true, json: async () => body };
      },
    },
  );

  assert.deepEqual(
    rankings.map(({ tradingVenue }) => tradingVenue.quoteCurrencyMode),
    ['EUR', 'USD', 'MIXED'],
  );
  assert.deepEqual(
    rankings.map(({ assets }) => assets[0].tradingPair),
    ['DUAL/EUR', 'DUAL/USD', 'DUAL/EUR'],
  );
  assert.deepEqual(
    rankings.map(({ observedAt }) => observedAt),
    Array(3).fill('2026-08-24T12:00:00.000Z'),
  );
  assert.equal(
    requestedUrls.filter(({ pathname }) => pathname.endsWith('/coins/markets')).length,
    1,
  );
  assert.equal(
    requestedUrls.filter(({ pathname }) => pathname.endsWith('/pairs')).length,
    1,
  );
  assert.equal(
    requestedUrls.filter(({ pathname }) => pathname.endsWith('/currencies')).length,
    1,
  );
  assert.equal(
    requestedUrls.filter(({ pathname }) => pathname.endsWith('/exchange_rates')).length,
    1,
  );
});

test('normalizes active Revolut X EUR pair configuration', async () => {
  const venue = await fetchRevolutXTradingVenue('eur', {
    sleepImpl: async () => {},
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => new URL(url).pathname.endsWith('/pairs')
        ? {
            'BTC/EUR': {
              base: 'BTC',
              quote: 'EUR',
              status: 'active',
              min_order_size_quote: '0.1',
              max_order_size_quote: '1000000',
            },
          }
        : {
            BTC: { symbol: 'BTC', name: 'Bitcoin', status: 'active' },
          },
    }),
  });

  assert.equal(venue.name, 'Revolut X');
  assert.equal(venue.region, 'EEA');
  assert.equal(venue.quoteCurrencyMode, 'EUR');
  assert.deepEqual(venue.quoteCurrencies, ['EUR']);
  assert.equal(venue.quoteCurrency, 'EUR');
  assert.deepEqual(venue.pairs, [{
    symbol: 'BTC/EUR',
    base: 'BTC',
    quote: 'EUR',
    status: 'active',
    minOrderSizeQuote: '0.1',
    maxOrderSizeQuote: '1000000',
  }]);
  assert.deepEqual(venue.currencies, [{
    symbol: 'BTC',
    name: 'Bitcoin',
    status: 'active',
  }]);
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

test('requires an active EUR pair on the configured trading venue', () => {
  const result = rankDiamondQuantities([
    marketRow({ id: 'eur-listed', symbol: 'listed', name: 'EUR Listed' }),
    marketRow({ id: 'usd-only', symbol: 'usdonly', name: 'USD Only' }),
    marketRow({ id: 'inactive-eur', symbol: 'inactive', name: 'Inactive EUR' }),
    marketRow({ id: 'unaffordable-eur', symbol: 'pricey', name: 'Pricey EUR' }),
  ], portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    tradingVenue: {
      name: 'Revolut X',
      region: 'EEA',
      source: 'Revolut X public configuration API',
      identitySource: 'Revolut X public currencies API',
      quoteCurrency: 'EUR',
      pairs: [
        {
          symbol: 'LISTED/EUR', base: 'LISTED', quote: 'EUR', status: 'active',
          minOrderSizeQuote: '0.1', maxOrderSizeQuote: '1000000',
        },
        { symbol: 'USDONLY/USD', base: 'USDONLY', quote: 'USD', status: 'active' },
        { symbol: 'INACTIVE/EUR', base: 'INACTIVE', quote: 'EUR', status: 'inactive' },
        {
          symbol: 'PRICEY/EUR', base: 'PRICEY', quote: 'EUR', status: 'active',
          minOrderSizeQuote: '100', maxOrderSizeQuote: '1000000',
        },
      ],
      currencies: [
        { symbol: 'LISTED', name: 'EUR Listed', status: 'active' },
        { symbol: 'USDONLY', name: 'USD Only', status: 'active' },
        { symbol: 'INACTIVE', name: 'Inactive EUR', status: 'active' },
        { symbol: 'PRICEY', name: 'Pricey EUR', status: 'active' },
      ],
    },
  });

  assert.deepEqual(result.assets.map(({ id }) => id), ['eur-listed']);
  assert.equal(result.assets[0].tradingPair, 'LISTED/EUR');
  assert.equal(result.assets[0].tradingVenue, 'Revolut X');
  assert.deepEqual(result.tradingVenue, {
    name: 'Revolut X',
    region: 'EEA',
    source: 'Revolut X public configuration API',
    identitySource: 'Revolut X public currencies API',
    quoteCurrencyMode: 'EUR',
    quoteCurrencies: ['EUR'],
    quoteCurrency: 'EUR',
    usdPerEur: null,
    exchangeRateSource: null,
  });
  assert.deepEqual(result.excluded, [
    {
      id: 'usd-only',
      reason: 'No active Revolut X USDONLY/EUR market in EEA.',
    },
    {
      id: 'inactive-eur',
      reason: 'No active Revolut X INACTIVE/EUR market in EEA.',
    },
    {
      id: 'unaffordable-eur',
      reason: 'EUR 50 is below the PRICEY/EUR minimum quote order of 100.',
    },
  ]);
});

test('prefers EUR and falls back to affordable USD pairs in mixed mode', () => {
  const result = rankDiamondQuantities([
    marketRow({ id: 'dual-listed', symbol: 'both', name: 'Both' }),
    marketRow({ id: 'usd-only', symbol: 'usdonly', name: 'USD Only' }),
    marketRow({ id: 'unaffordable-usd', symbol: 'pricey', name: 'Pricey USD' }),
  ], portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    quoteCurrencyMode: 'mixed',
    usdPerEur: 1.2,
    exchangeRateSource: 'test-rate',
    tradingVenue: {
      name: 'Revolut X',
      region: 'EEA',
      source: 'Revolut X public configuration API',
      identitySource: 'Revolut X public currencies API',
      quoteCurrencies: ['EUR', 'USD'],
      pairs: [
        {
          symbol: 'BOTH/EUR', base: 'BOTH', quote: 'EUR', status: 'active',
          minOrderSizeQuote: '0.1', maxOrderSizeQuote: '1000000',
        },
        {
          symbol: 'BOTH/USD', base: 'BOTH', quote: 'USD', status: 'active',
          minOrderSizeQuote: '0.1', maxOrderSizeQuote: '1000000',
        },
        {
          symbol: 'USDONLY/USD', base: 'USDONLY', quote: 'USD', status: 'active',
          minOrderSizeQuote: '0.1', maxOrderSizeQuote: '1000000',
        },
        {
          symbol: 'PRICEY/USD', base: 'PRICEY', quote: 'USD', status: 'active',
          minOrderSizeQuote: '61', maxOrderSizeQuote: '1000000',
        },
      ],
      currencies: [
        { symbol: 'BOTH', name: 'Both', status: 'active' },
        { symbol: 'USDONLY', name: 'USD Only', status: 'active' },
        { symbol: 'PRICEY', name: 'Pricey USD', status: 'active' },
      ],
    },
  });

  assert.deepEqual(result.assets.map(({ id }) => id), ['dual-listed', 'usd-only']);
  assert.deepEqual(result.assets.map(({ tradingPair }) => tradingPair), ['BOTH/EUR', 'USDONLY/USD']);
  assert.deepEqual(result.assets.map(({ tradingQuoteCurrency }) => tradingQuoteCurrency), ['EUR', 'USD']);
  assert.deepEqual(result.assets.map(({ quoteOrderAmount }) => quoteOrderAmount), [50, 60]);
  assert.equal(result.tradingVenue.quoteCurrencyMode, 'MIXED');
  assert.deepEqual(result.tradingVenue.quoteCurrencies, ['EUR', 'USD']);
  assert.equal(result.tradingVenue.exchangeRateSource, 'test-rate');
  assert.deepEqual(result.excluded, [{
    id: 'unaffordable-usd',
    reason: 'USD 60 is below the PRICEY/USD minimum quote order of 61.',
  }]);
});

test('rejects a symbol collision when CoinGecko and Revolut identities differ', () => {
  const result = rankDiamondQuantities([
    marketRow({ id: 'unrelated-btc', symbol: 'btc', name: 'Not Bitcoin' }),
  ], portfolioConfig, {
    observedAt: '2026-08-24T12:00:00.000Z',
    tradingVenue: {
      name: 'Revolut X',
      region: 'EEA',
      source: 'Revolut X public configuration API',
      identitySource: 'Revolut X public currencies API',
      quoteCurrency: 'EUR',
      pairs: [{
        symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', status: 'active',
        minOrderSizeQuote: '0.1', maxOrderSizeQuote: '1000000',
      }],
      currencies: [{ symbol: 'BTC', name: 'Bitcoin', status: 'active' }],
    },
  });

  assert.equal(result.assets.length, 0);
  assert.deepEqual(result.excluded, [{
    id: 'unrelated-btc',
    reason: 'CoinGecko identity Not Bitcoin (BTC) does not match Revolut X Bitcoin (BTC).',
  }]);
});

test('rejects invalid ranking inputs', () => {
  assert.throws(() => rankDiamondQuantities([], portfolioConfig, {
    investedAmount: 0,
  }), /Invested amount must be a positive number/);
  assert.throws(() => rankDiamondQuantities([], portfolioConfig, {
    referenceMarketCap: 10_000_000,
  }), /must exceed the minimum market capitalization/);
  assert.throws(() => rankDiamondQuantities({}, portfolioConfig), /invalid market data/);
  assert.throws(() => rankDiamondQuantities([], portfolioConfig, {
    investedAmount: 50.01,
    quoteCurrencyMode: 'USD',
    usdPerEur: 1.2,
  }), /USD quote modes support at most EUR 50 per asset/);
});