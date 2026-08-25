import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isValidDate,
  isValidProfile,
  isValidTimestamp,
  resolveProfilePortfolio,
} from '../../../../src/model.js';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(skillRoot, '..', '..', '..');
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROFILE_TYPES = new Set(['real', 'simulated']);
const COMPACT_HOLDING_FIELDS = new Set([
  'id',
  'symbol',
  'investedAmount',
  'quantity',
  'buyDate',
  'buyTimestamp',
]);

function unique(values) {
  return [...new Set(values)];
}

function purchaseKey({ id, buyDate, buyTimestamp }) {
  return `${id}:${buyTimestamp ?? buyDate ?? ''}`;
}

function duplicateValues(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value);
}

function displayPath(profilePath, root) {
  return path.relative(root, profilePath).replaceAll('\\', '/');
}

export function resolveProfilePath(profileInput, root = repositoryRoot) {
  const input = String(profileInput ?? '').trim();
  if (!input) throw new Error('Provide a profile ID or JSON path.');
  if (path.isAbsolute(input)) return path.normalize(input);
  if (/[\\/]/.test(input)) return path.resolve(root, input);
  return path.resolve(root, 'profiles', input.endsWith('.json') ? input : `${input}.json`);
}

export function validateProfile(profile, portfolioConfig, { profilePath } = {}) {
  const profileIsObject = Boolean(profile && typeof profile === 'object' && !Array.isArray(profile));
  const supportedAssets = Array.isArray(portfolioConfig?.supportedAssets)
    ? portfolioConfig.supportedAssets
    : [];
  const defaultPortfolio = Array.isArray(portfolioConfig?.defaultPortfolio)
    ? portfolioConfig.defaultPortfolio
    : [];
  const supportedById = new Map(supportedAssets.map((asset) => [asset.id, asset]));
  const supportedIds = new Set(supportedById.keys());
  const sourceCandidate = profileIsObject ? profile.portfolio ?? defaultPortfolio : [];
  const sourcePortfolio = Array.isArray(sourceCandidate) ? sourceCandidate : [];
  const profileType = profile?.type ?? 'simulated';
  const target = Number(portfolioConfig?.totalInvestment ?? 500);

  let resolvedPortfolio = [];
  let repositoryModel = false;
  if (profileIsObject) {
    try {
      resolvedPortfolio = resolveProfilePortfolio(profile, defaultPortfolio, supportedAssets);
      repositoryModel = isValidProfile(profile, supportedIds, defaultPortfolio, target);
    } catch {
      resolvedPortfolio = [];
    }
  }

  const unsupportedIds = unique(sourcePortfolio
    .map(({ id }) => id)
    .filter((id) => !supportedIds.has(id)));
  const symbolMismatches = sourcePortfolio.flatMap(({ id, symbol }) => {
    const expected = supportedById.get(id)?.symbol;
    return symbol !== undefined && expected && symbol !== expected
      ? [`${id}: expected ${expected}, received ${symbol}`]
      : [];
  });
  const missingSymbols = unique(sourcePortfolio
    .filter(({ id, symbol }) => supportedIds.has(id) && !symbol)
    .map(({ id }) => id));
  const invalidInvestments = sourcePortfolio.flatMap(({ id, investedAmount }, index) =>
    Number.isFinite(Number(investedAmount)) && Number(investedAmount) > 0
      ? []
      : [`#${index + 1} ${id ?? 'unknown'}`]);
  const invalidQuantities = profileType === 'real'
    ? sourcePortfolio.flatMap(({ id, quantity }, index) =>
      Number.isFinite(Number(quantity)) && Number(quantity) > 0
        ? []
        : [`#${index + 1} ${id ?? 'unknown'}`])
    : [];
  const invalidDates = sourcePortfolio.flatMap(({ id, buyDate }, index) =>
    buyDate === undefined || isValidDate(buyDate)
      ? []
      : [`#${index + 1} ${id ?? 'unknown'}: ${String(buyDate)}`]);
  const invalidTimestamps = sourcePortfolio.flatMap(({ id, buyTimestamp }, index) =>
    buyTimestamp === undefined || isValidTimestamp(buyTimestamp)
      ? []
      : [`#${index + 1} ${id ?? 'unknown'}: ${String(buyTimestamp)}`]);
  const purchaseKeys = sourcePortfolio.map(purchaseKey);
  const duplicatePurchaseKeys = duplicateValues(purchaseKeys);
  const totalInvested = sourcePortfolio.reduce(
    (sum, { investedAmount }) => sum + Number(investedAmount || 0),
    0,
  );
  const filenameMatchesId = !profilePath
    || path.basename(profilePath) === `${profile?.id}.json`;
  const runtimeEnrichment = resolvedPortfolio.length > 0
    && resolvedPortfolio.every(({ name, thesis }) =>
      typeof name === 'string' && name.trim()
      && typeof thesis === 'string' && thesis.trim());
  const timestampDatesDerived = resolvedPortfolio.every(({ buyDate, buyTimestamp }) =>
    buyTimestamp === undefined || buyDate === buyTimestamp.slice(0, 10));
  const extraStoredFields = unique(sourcePortfolio.flatMap((holding) =>
    Object.keys(holding).filter((field) => !COMPACT_HOLDING_FIELDS.has(field))));
  const redundantTimestampDates = sourcePortfolio.filter(({ buyDate, buyTimestamp }) =>
    buyDate !== undefined && buyTimestamp !== undefined).length;

  const checks = {
    json: true,
    profileId: profileIsObject && PROFILE_ID_PATTERN.test(profile.id),
    profileName: profileIsObject && typeof profile.name === 'string' && Boolean(profile.name.trim()),
    profileType: profileIsObject && PROFILE_TYPES.has(profileType),
    profileBuyDate: profileIsObject && (profile.buyDate === undefined || isValidDate(profile.buyDate)),
    portfolioPresent: sourcePortfolio.length > 0,
    supportedAssetIds: unsupportedIds.length === 0,
    symbolsMatchRegistry: symbolMismatches.length === 0,
    investedAmountsPositive: invalidInvestments.length === 0,
    quantitiesPositive: invalidQuantities.length === 0,
    buyDatesValid: invalidDates.length === 0,
    buyTimestampsValid: invalidTimestamps.length === 0,
    purchaseKeysUnique: duplicatePurchaseKeys.length === 0,
    allocationTotal: profileType === 'real' || Math.abs(totalInvested - target) < 0.01,
    filenameMatchesId,
    runtimeEnrichment,
    timestampDatesDerived,
    repositoryModel,
  };

  const errors = [];
  if (!checks.profileId) errors.push('Profile id must be lowercase alphanumeric with optional hyphens and at most 40 characters.');
  if (!checks.profileName) errors.push('Profile name must be a non-empty string.');
  if (!checks.profileType) errors.push('Profile type must be "real" or "simulated".');
  if (!checks.profileBuyDate) errors.push(`Invalid profile buyDate: ${String(profile?.buyDate)}`);
  if (!checks.portfolioPresent) errors.push('Profile must resolve to at least one holding.');
  if (!checks.supportedAssetIds) errors.push(`Unsupported asset IDs: ${unsupportedIds.join(', ')}`);
  if (!checks.symbolsMatchRegistry) errors.push(`Symbol mismatches: ${symbolMismatches.join('; ')}`);
  if (!checks.investedAmountsPositive) errors.push(`Invested amounts must be positive: ${invalidInvestments.join(', ')}`);
  if (!checks.quantitiesPositive) errors.push(`Real holding quantities must be positive: ${invalidQuantities.join(', ')}`);
  if (!checks.buyDatesValid) errors.push(`Invalid buy dates: ${invalidDates.join('; ')}`);
  if (!checks.buyTimestampsValid) errors.push(`Invalid UTC buy timestamps: ${invalidTimestamps.join('; ')}`);
  if (!checks.purchaseKeysUnique) errors.push(`Duplicate asset purchase keys: ${duplicatePurchaseKeys.join(', ')}`);
  if (!checks.allocationTotal) errors.push(`Simulated invested amounts must total ${target}; received ${totalInvested}.`);
  if (!checks.filenameMatchesId) errors.push(`Profile filename must be ${profile?.id}.json.`);
  if (!checks.runtimeEnrichment) errors.push('Runtime enrichment could not supply a name and thesis for every holding.');
  if (!checks.timestampDatesDerived) errors.push('One or more UTC buy dates could not be derived from buyTimestamp.');
  if (!checks.repositoryModel && errors.length === 0) errors.push('Profile failed repository model validation.');

  const warnings = [];
  if (missingSymbols.length > 0) {
    warnings.push(`Legacy holdings without stored symbols: ${missingSymbols.join(', ')}.`);
  }
  if (extraStoredFields.length > 0) {
    warnings.push(`Derived or legacy holding fields can be omitted: ${extraStoredFields.join(', ')}.`);
  }
  if (redundantTimestampDates > 0) {
    warnings.push(`${redundantTimestampDates} holding(s) store buyDate even though it is derived from buyTimestamp.`);
  }

  return {
    valid: Object.values(checks).every(Boolean),
    profile: {
      ...(profilePath ? { path: profilePath.replaceAll('\\', '/') } : {}),
      id: profile?.id ?? null,
      name: profile?.name ?? null,
      type: profileType,
      holdings: sourcePortfolio.length,
      totalInvested,
      currency: String(portfolioConfig?.currency ?? '').toUpperCase() || null,
    },
    checks,
    errors,
    warnings,
  };
}

export async function validateProfileFile(profileInput, { root = repositoryRoot } = {}) {
  const profilePath = resolveProfilePath(profileInput, root);
  const relativePath = displayPath(profilePath, root);
  const [profileJson, portfolioConfig] = await Promise.all([
    readFile(profilePath, 'utf8'),
    readFile(path.join(root, 'data', 'portfolio.json'), 'utf8').then(JSON.parse),
  ]);

  let profile;
  try {
    profile = JSON.parse(profileJson);
  } catch (error) {
    return {
      valid: false,
      profile: { path: relativePath, id: null, name: null, type: null, holdings: 0, totalInvested: 0, currency: null },
      checks: { json: false },
      errors: [`Invalid JSON: ${error.message}`],
      warnings: [],
    };
  }
  return validateProfile(profile, portfolioConfig, { profilePath: relativePath });
}

async function main([profileInput]) {
  const result = await validateProfileFile(profileInput);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}