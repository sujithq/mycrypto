import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDailyGemsEligibility,
} from '../.github/skills/daily-gems-eligibility/scripts/check-daily-gems-eligibility.mjs';

const portfolioConfig = {
  currency: 'eur',
  supportedAssets: [
    { id: 'candidate', symbol: 'CAND', name: 'Candidate' },
    { id: 'collision', symbol: 'COLL', name: 'Collision' },
  ],
};

function marketRow(overrides = {}) {
  return {
    id: 'candidate',
    symbol: 'cand',
    name: 'Candidate',
    current_price: 0.01,
    market_cap: 20_000_000,
    market_cap_rank: 500,
    fully_diluted_valuation: 22_000_000,
    total_volume: 2_000_000,
    circulating_supply: 1_800_000_000,
    total_supply: 2_000_000_000,
    max_supply: 2_000_000_000,
    price_change_percentage_7d_in_currency: 10,
    price_change_percentage_30d_in_currency: 20,
    last_updated: '2026-08-26T11:59:00.000Z',
    ...overrides,
  };
}

function successfulResponse(body) {
  return { ok: true, json: async () => body };
}

function tradingVenue(symbol, name) {
  return {
    name: 'Revolut X',
    region: 'EEA',
    source: 'pairs-source',
    identitySource: 'currencies-source',
    quoteCurrencyMode: 'EUR',
    quoteCurrencies: ['EUR'],
    quoteCurrency: 'EUR',
    pairs: [{
      symbol: `${symbol}/EUR`,
      base: symbol,
      quote: 'EUR',
      status: 'active',
      minOrderSizeQuote: '0.1',
      maxOrderSizeQuote: '1000000',
    }],
    currencies: [{ symbol, name, status: 'active' }],
  };
}

test('checks all daily issue modes from one canonical market row and venue snapshot', async () => {
  const requestedUrls = [];
  const result = await checkDailyGemsEligibility('cand', portfolioConfig, {
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const requestedUrl = new URL(url);
      requestedUrls.push(requestedUrl);
      if (requestedUrl.pathname.endsWith('/pairs')) {
        return successfulResponse({
          'CAND/EUR': {
            base: 'CAND',
            quote: 'EUR',
            status: 'active',
            min_order_size_quote: '0.1',
            max_order_size_quote: '1000000',
          },
        });
      }
      if (requestedUrl.pathname.endsWith('/currencies')) {
        return successfulResponse({
          CAND: { symbol: 'CAND', name: 'Candidate', status: 'active' },
        });
      }
      if (requestedUrl.pathname.endsWith('/exchange_rates')) {
        return successfulResponse({ rates: { eur: { value: 100 }, usd: { value: 120 } } });
      }
      return successfulResponse([marketRow()]);
    },
  });

  const marketRequest = requestedUrls.find(({ pathname }) => pathname.endsWith('/coins/markets'));
  assert.equal(marketRequest.searchParams.get('ids'), 'candidate');
  assert.deepEqual(result.requestedQuoteModes, ['EUR', 'USD', 'MIXED']);
  assert.equal(result.eligible, true);
  assert.equal(result.eligibleInAllRequestedModes, false);
  assert.deepEqual(result.modes.map(({ eligible }) => eligible), [true, false, true]);
  assert.equal(result.modes[0].candidate.tradingPair, 'CAND/EUR');
  assert.equal(result.modes[0].candidate.diamondScore, undefined);
  assert.match(result.modes[1].reason, /No active Revolut X CAND\/USD market in EEA/);
  assert.equal(result.modes[1].identityStatus, 'not-checked');
  assert.equal(result.modes[2].candidate.tradingPair, 'CAND/EUR');
  assert.equal(result.asset.isSupported, true);
});

test('fails closed when a venue ticker identifies another asset', async () => {
  const result = await checkDailyGemsEligibility('collision', portfolioConfig, {
    quoteCurrencyMode: 'EUR',
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/pairs')) {
        return successfulResponse({
          'COLL/EUR': {
            base: 'COLL',
            quote: 'EUR',
            status: 'active',
            min_order_size_quote: '0.1',
            max_order_size_quote: '1000000',
          },
        });
      }
      if (pathname.endsWith('/currencies')) {
        return successfulResponse({
          COLL: { symbol: 'COLL', name: 'Different Asset', status: 'active' },
        });
      }
      return successfulResponse([marketRow({
        id: 'collision',
        symbol: 'coll',
        name: 'Collision',
      })]);
    },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.modes[0].identityStatus, 'mismatch');
  assert.deepEqual(result.modes[0].tradingPairs, ['COLL/EUR']);
  assert.match(result.modes[0].reason, /does not match Revolut X Different Asset/);
});

test('reports the production market-cap rejection with verified identity', async () => {
  const result = await checkDailyGemsEligibility('candidate', portfolioConfig, {
    quoteCurrencyMode: 'EUR',
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/pairs')) {
        return successfulResponse({
          'CAND/EUR': {
            base: 'CAND',
            quote: 'EUR',
            status: 'active',
            min_order_size_quote: '0.1',
            max_order_size_quote: '1000000',
          },
        });
      }
      if (pathname.endsWith('/currencies')) {
        return successfulResponse({
          CAND: { symbol: 'CAND', name: 'Candidate', status: 'active' },
        });
      }
      return successfulResponse([marketRow({ market_cap: 9_999_999 })]);
    },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.modes[0].identityStatus, 'verified');
  assert.equal(result.modes[0].reason, 'Market capitalization is below 10000000.');
});

test('reports when CoinGecko has no live market row for the canonical asset', async () => {
  const result = await checkDailyGemsEligibility('candidate', portfolioConfig, {
    quoteCurrencyMode: 'EUR',
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/pairs')) return successfulResponse({});
      if (pathname.endsWith('/currencies')) return successfulResponse({});
      return successfulResponse([]);
    },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.modes[0].identityStatus, 'not-checked');
  assert.equal(
    result.modes[0].reason,
    'CoinGecko returned no live EUR market row for candidate.',
  );
});

test('rejects ambiguous external symbols before screening market data', async () => {
  const requestedUrls = [];
  await assert.rejects(checkDailyGemsEligibility('abc', {
    currency: 'eur',
    supportedAssets: [],
  }, {
    quoteCurrencyMode: 'EUR',
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      requestedUrls.push(new URL(url));
      return successfulResponse([
        { id: 'alpha-coin', symbol: 'abc', name: 'Alpha Coin' },
        { id: 'another-coin', symbol: 'abc', name: 'Another Coin' },
      ]);
    },
  }), /Ambiguous symbol ABC.*alpha-coin.*another-coin/);

  assert.deepEqual(requestedUrls.map(({ pathname }) => pathname), ['/api/v3/coins/list']);
});

test('prefers an exact local ID over a colliding local symbol', async () => {
  const collisionConfig = {
    currency: 'eur',
    supportedAssets: [
      { id: 'first-coin', symbol: 'TARGET', name: 'First Coin' },
      { id: 'target', symbol: 'SECOND', name: 'Target ID Coin' },
    ],
  };
  let requestedId;
  const result = await checkDailyGemsEligibility('target', collisionConfig, {
    quoteCurrencyMode: 'EUR',
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async () => {},
    fetchMarketsImpl: async (_currency, ids) => {
      [requestedId] = ids;
      return [marketRow({ id: 'target', symbol: 'second', name: 'Target ID Coin' })];
    },
    fetchTradingVenueImpl: async () => tradingVenue('SECOND', 'Target ID Coin'),
  });

  assert.equal(requestedId, 'target');
  assert.equal(result.asset.id, 'target');
  assert.equal(result.asset.symbol, 'SECOND');
  assert.equal(result.eligible, true);
});

test('rejects duplicate local symbols before screening market data', async () => {
  const collisionConfig = {
    currency: 'eur',
    supportedAssets: [
      { id: 'first-coin', symbol: 'DUP', name: 'First Coin' },
      { id: 'second-coin', symbol: 'DUP', name: 'Second Coin' },
    ],
  };

  await assert.rejects(checkDailyGemsEligibility('dup', collisionConfig, {
    quoteCurrencyMode: 'EUR',
    fetchMarketsImpl: async () => assert.fail('market data should not be requested'),
    fetchTradingVenueImpl: async () => assert.fail('venue data should not be requested'),
  }), /Ambiguous symbol DUP.*first-coin.*second-coin/);
});

test('paces a unique external symbol before live screening without a details request', async () => {
  const events = [];
  const result = await checkDailyGemsEligibility('ext', {
    currency: 'eur',
    supportedAssets: [],
  }, {
    quoteCurrencyMode: 'EUR',
    observedAt: '2026-08-26T12:00:00.000Z',
    sleepImpl: async (milliseconds) => events.push(`sleep:${milliseconds}`),
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      events.push(`fetch:${pathname}`);
      if (pathname.endsWith('/coins/list')) {
        return successfulResponse([
          { id: 'external-coin', symbol: 'ext', name: 'External Coin' },
        ]);
      }
      if (pathname.endsWith('/coins/markets')) {
        return successfulResponse([
          marketRow({ id: 'external-coin', symbol: 'ext', name: 'External Coin' }),
        ]);
      }
      if (pathname.endsWith('/pairs')) {
        return successfulResponse({
          'EXT/EUR': {
            base: 'EXT',
            quote: 'EUR',
            status: 'active',
            min_order_size_quote: '0.1',
            max_order_size_quote: '1000000',
          },
        });
      }
      return successfulResponse({
        EXT: { symbol: 'EXT', name: 'External Coin', status: 'active' },
      });
    },
  });

  const listRequest = events.indexOf('fetch:/api/v3/coins/list');
  const marketRequest = events.indexOf('fetch:/api/v3/coins/markets');
  const pacingDelay = events.indexOf('sleep:1000');
  assert.ok(listRequest < pacingDelay && pacingDelay < marketRequest);
  assert.equal(events.some((event) => event === 'fetch:/api/v3/coins/external-coin'), false);
  assert.equal(result.asset.id, 'external-coin');
  assert.equal(result.eligible, true);
});

test('rejects invalid mode and oversized USD checks before making requests', async () => {
  const fetchImpl = async () => assert.fail('fetch should not be called');
  await assert.rejects(checkDailyGemsEligibility('candidate', portfolioConfig, {
    quoteCurrencyMode: 'GBP',
    fetchImpl,
  }), /ALL, EUR, USD, or MIXED/);
  await assert.rejects(checkDailyGemsEligibility('candidate', portfolioConfig, {
    quoteCurrencyMode: 'USD',
    investedAmount: 51,
    fetchImpl,
  }), /at most EUR 50/);
});