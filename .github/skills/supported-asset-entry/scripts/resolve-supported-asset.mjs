import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const API = 'https://api.coingecko.com/api/v3';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function descriptionText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url, {
  attempts = 3,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'mycrypto-supported-asset-entry/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return response.json();
      const detail = typeof response.text === 'function' ? (await response.text()).slice(0, 300) : '';
      lastError = new Error(`CoinGecko request failed (${response.status}): ${detail}`);
      const retryAfterHeader = response.headers?.get?.('retry-after');
      const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
        ? Number.NaN
        : Number(retryAfterHeader);
      if (attempt < attempts) {
        await sleepImpl(Number.isFinite(retryAfter) ? retryAfter * 1_000 : attempt * 5_000);
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleepImpl(attempt * 5_000);
    }
  }
  throw lastError ?? new Error('CoinGecko request failed.');
}

export async function resolveSupportedAssetsByIds(assetIdsInput, options = {}) {
  if (!Array.isArray(assetIdsInput)) throw new Error('Provide CoinGecko asset IDs as an array.');
  const assetIds = assetIdsInput.map((value) => String(value ?? '').trim().toLowerCase());
  if (assetIds.some((id) => !id)) throw new Error('CoinGecko asset IDs cannot be empty.');
  if (assetIds.length === 0) return [];

  const coins = await fetchJson(`${API}/coins/list?include_platform=false`, options);
  if (!Array.isArray(coins)) throw new Error('CoinGecko returned an invalid coin list.');
  const coinsById = new Map(coins.map((coin) => [String(coin?.id ?? '').toLowerCase(), coin]));
  return assetIds.map((assetId) => {
    const coin = coinsById.get(assetId);
    const id = String(coin?.id ?? '').trim();
    const symbol = String(coin?.symbol ?? '').trim().toUpperCase();
    const name = String(coin?.name ?? '').trim();
    if (!id || id.toLowerCase() !== assetId || !symbol || !name) {
      throw new Error(`CoinGecko returned no complete canonical metadata for ${assetId}.`);
    }
    return {
      entry: { id, symbol, name },
      source: 'CoinGecko',
      context: { categories: [], description: '' },
    };
  });
}

export async function resolveSupportedAssetById(assetIdInput, options = {}) {
  const assetId = String(assetIdInput ?? '').trim().toLowerCase();
  if (!assetId) throw new Error('Provide a CoinGecko asset ID.');

  const query = new URLSearchParams({
    localization: 'false',
    tickers: 'false',
    market_data: 'false',
    community_data: 'false',
    developer_data: 'false',
    sparkline: 'false',
  });
  const details = await fetchJson(`${API}/coins/${encodeURIComponent(assetId)}?${query}`, options);
  const id = String(details?.id ?? '').trim();
  const symbol = String(details?.symbol ?? '').trim().toUpperCase();
  const name = String(details?.name ?? '').trim();
  if (!id || id.toLowerCase() !== assetId || !symbol || !name) {
    throw new Error(`CoinGecko returned incomplete or mismatched metadata for ${assetId}.`);
  }

  return {
    entry: { id, symbol, name },
    source: 'CoinGecko',
    context: {
      categories: Array.isArray(details?.categories)
        ? details.categories.filter((category) => typeof category === 'string' && category.trim())
        : [],
      description: descriptionText(details?.description?.en),
    },
  };
}

export async function resolveSupportedAsset(assetInput, portfolioConfig, options = {}) {
  const assetKey = String(assetInput ?? '').trim().toLowerCase();
  if (!assetKey) throw new Error('Provide an asset symbol or CoinGecko ID.');

  const localEntry = portfolioConfig.supportedAssets?.find(({ id, symbol }) =>
    id.toLowerCase() === assetKey || symbol.toLowerCase() === assetKey);
  if (localEntry) return { entry: localEntry, source: 'local' };

  const coins = await fetchJson(`${API}/coins/list?include_platform=false`, options);
  if (!Array.isArray(coins)) throw new Error('CoinGecko returned an invalid coin list.');

  const exactId = coins.find(({ id }) => String(id).toLowerCase() === assetKey);
  const symbolMatches = coins.filter(({ symbol }) => String(symbol).toLowerCase() === assetKey);
  if (!exactId && symbolMatches.length === 0) {
    throw new Error(`No CoinGecko asset found for: ${assetInput}`);
  }
  if (!exactId && symbolMatches.length > 1) {
    const choices = symbolMatches
      .map(({ id, name }) => `${id} (${name})`)
      .sort()
      .join(', ');
    throw new Error(`Ambiguous symbol ${assetKey.toUpperCase()}; use one of these CoinGecko IDs: ${choices}`);
  }

  const match = exactId ?? symbolMatches[0];
  return resolveSupportedAssetById(match.id, options);
}

async function main([assetInput]) {
  const portfolioConfig = JSON.parse(await readFile(
    path.join(repositoryRoot, 'data', 'portfolio.json'),
    'utf8',
  ));
  const result = await resolveSupportedAsset(assetInput, portfolioConfig);
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}