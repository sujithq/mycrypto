import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveSupportedAsset,
  resolveSupportedAssetById,
  resolveSupportedAssetsByIds,
} from '../.github/skills/supported-asset-entry/scripts/resolve-supported-asset.mjs';

const portfolioConfig = {
  supportedAssets: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      name: 'Bitcoin',
      thesis: 'Liquid macro anchor.',
    },
  ],
};

test('returns an existing supportedAssets entry by symbol without a request', async () => {
  const result = await resolveSupportedAsset('btc', portfolioConfig, {
    fetchImpl: async () => assert.fail('fetch should not be called'),
  });

  assert.deepEqual(result, {
    entry: portfolioConfig.supportedAssets[0],
    source: 'local',
  });
});

test('resolves a canonical CoinGecko entry by id', async () => {
  const requests = [];
  const result = await resolveSupportedAsset('dogwifcoin', portfolioConfig, {
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return {
        ok: true,
        json: async () => requests.length === 1
          ? [{ id: 'dogwifcoin', symbol: 'wif', name: 'dogwifhat' }]
          : {
            id: 'dogwifcoin',
            symbol: 'wif',
            name: 'dogwifhat',
            categories: ['Meme', 'Solana Ecosystem'],
            description: { en: '<p>A community-driven meme coin on Solana.</p>' },
          },
      };
    },
  });

  assert.equal(requests[0].pathname, '/api/v3/coins/list');
  assert.equal(requests[1].pathname, '/api/v3/coins/dogwifcoin');
  assert.deepEqual(result, {
    entry: {
      id: 'dogwifcoin',
      symbol: 'WIF',
      name: 'dogwifhat',
    },
    source: 'CoinGecko',
    context: {
      categories: ['Meme', 'Solana Ecosystem'],
      description: 'A community-driven meme coin on Solana.',
    },
  });
});

test('resolves a unique CoinGecko symbol', async () => {
  const result = await resolveSupportedAsset('wif', portfolioConfig, {
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => new URL(url).pathname.endsWith('/coins/list')
        ? [{ id: 'dogwifcoin', symbol: 'wif', name: 'dogwifhat' }]
        : { id: 'dogwifcoin', symbol: 'wif', name: 'dogwifhat' },
    }),
  });

  assert.deepEqual(result.entry, {
    id: 'dogwifcoin',
    symbol: 'WIF',
    name: 'dogwifhat',
  });
});

test('resolves an already verified CoinGecko id without fetching the coin list', async () => {
  let requestedUrl;
  const result = await resolveSupportedAssetById('dogwifcoin', {
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        json: async () => ({
          id: 'dogwifcoin',
          symbol: 'wif',
          name: 'dogwifhat',
          categories: ['Meme', 'Solana Ecosystem'],
          description: { en: '<p>A community-driven meme coin on Solana.</p>' },
        }),
      };
    },
  });

  assert.equal(requestedUrl.pathname, '/api/v3/coins/dogwifcoin');
  assert.deepEqual(result.entry, {
    id: 'dogwifcoin',
    symbol: 'WIF',
    name: 'dogwifhat',
  });
});

test('resolves multiple canonical IDs with one CoinGecko request', async () => {
  const requests = [];
  const result = await resolveSupportedAssetsByIds(['dogwifcoin', 'bitcoin'], {
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      return {
        ok: true,
        json: async () => [
          { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
          { id: 'dogwifcoin', symbol: 'wif', name: 'dogwifhat' },
        ],
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname, '/api/v3/coins/list');
  assert.deepEqual(result.map(({ entry }) => entry), [
    { id: 'dogwifcoin', symbol: 'WIF', name: 'dogwifhat' },
    { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  ]);
});

test('rejects mismatched metadata for a canonical id', async () => {
  await assert.rejects(resolveSupportedAssetById('dogwifcoin', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ id: 'another-coin', symbol: 'wif', name: 'dogwifhat' }),
    }),
  }), /incomplete or mismatched metadata/);
});

test('rejects an ambiguous symbol with canonical id choices', async () => {
  await assert.rejects(resolveSupportedAsset('abc', portfolioConfig, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { id: 'alpha-coin', symbol: 'abc', name: 'Alpha Coin' },
        { id: 'another-bitcoin', symbol: 'abc', name: 'Another Bitcoin' },
      ],
    }),
  }), /Ambiguous symbol ABC.*alpha-coin.*another-bitcoin/);
});