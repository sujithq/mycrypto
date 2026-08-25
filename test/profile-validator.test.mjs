import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveProfilePath,
  validateProfile,
  validateProfileFile,
} from '../.github/skills/profile-validator/scripts/validate-profile.mjs';

const portfolioConfig = {
  currency: 'eur',
  totalInvestment: 500,
  supportedAssets: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      name: 'Bitcoin',
      thesis: 'Liquid macro anchor.',
    },
    {
      id: 'ethereum',
      symbol: 'ETH',
      name: 'Ethereum',
      thesis: 'Settlement-layer exposure.',
    },
  ],
  defaultPortfolio: [
    { id: 'bitcoin', symbol: 'BTC', investedAmount: 250 },
    { id: 'ethereum', symbol: 'ETH', investedAmount: 250 },
  ],
};

const compactProfile = {
  id: 'compact-real',
  name: 'Compact real profile',
  type: 'real',
  portfolio: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      investedAmount: 25,
      quantity: 0.0005,
      buyTimestamp: '2026-08-24T08:30:00.000Z',
    },
    {
      id: 'bitcoin',
      symbol: 'BTC',
      investedAmount: 25,
      quantity: 0.00049,
      buyTimestamp: '2026-08-24T09:30:00.000Z',
    },
  ],
};

test('validates compact timestamped real holdings', () => {
  const result = validateProfile(compactProfile, portfolioConfig, {
    profilePath: 'profiles/compact-real.json',
  });

  assert.equal(result.valid, true);
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.profile, {
    path: 'profiles/compact-real.json',
    id: 'compact-real',
    name: 'Compact real profile',
    type: 'real',
    holdings: 2,
    totalInvested: 50,
    currency: 'EUR',
  });
});

test('accepts verbose date-only holdings with a compact-storage warning', () => {
  const result = validateProfile({
    id: 'legacy-real',
    name: 'Legacy real profile',
    type: 'real',
    buyDate: '2026-08-20',
    portfolio: [{
      id: 'bitcoin',
      symbol: 'BTC',
      name: 'Bitcoin',
      thesis: 'Stored legacy thesis.',
      investedAmount: 50,
      quantity: 0.001,
      buyDate: '2026-08-20',
    }],
  }, portfolioConfig, { profilePath: 'profiles/legacy-real.json' });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /name, thesis/);
});

test('rejects duplicate purchase lots and non-UTC timestamps', () => {
  const duplicate = validateProfile({
    ...compactProfile,
    portfolio: compactProfile.portfolio.map((holding) => ({
      ...holding,
      buyTimestamp: '2026-08-24T08:30:00.000Z',
    })),
  }, portfolioConfig, { profilePath: 'profiles/compact-real.json' });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.checks.purchaseKeysUnique, false);
  assert.match(duplicate.errors.join('\n'), /Duplicate asset purchase keys/);

  const localOffset = validateProfile({
    ...compactProfile,
    portfolio: [{
      ...compactProfile.portfolio[0],
      buyTimestamp: '2026-08-24T10:30:00+02:00',
    }],
  }, portfolioConfig, { profilePath: 'profiles/compact-real.json' });
  assert.equal(localOffset.valid, false);
  assert.equal(localOffset.checks.buyTimestampsValid, false);
  assert.match(localOffset.errors.join('\n'), /Invalid UTC buy timestamps/);
});

test('rejects unsupported IDs and canonical symbol mismatches', () => {
  const unsupported = validateProfile({
    ...compactProfile,
    portfolio: [{
      ...compactProfile.portfolio[0],
      id: 'not-supported',
      symbol: 'NOPE',
    }],
  }, portfolioConfig, { profilePath: 'profiles/compact-real.json' });
  assert.equal(unsupported.valid, false);
  assert.equal(unsupported.checks.supportedAssetIds, false);
  assert.match(unsupported.errors.join('\n'), /not-supported/);

  const mismatched = validateProfile({
    ...compactProfile,
    portfolio: [{ ...compactProfile.portfolio[0], symbol: 'ETH' }],
  }, portfolioConfig, { profilePath: 'profiles/compact-real.json' });
  assert.equal(mismatched.valid, false);
  assert.equal(mismatched.checks.symbolsMatchRegistry, false);
  assert.match(mismatched.errors.join('\n'), /expected BTC, received ETH/);
});

test('validates simulated totals and profile filenames', () => {
  const result = validateProfile({
    id: 'simulation',
    name: 'Simulation',
    type: 'simulated',
    portfolio: [{
      id: 'bitcoin',
      symbol: 'BTC',
      investedAmount: 499,
    }],
  }, portfolioConfig, { profilePath: 'profiles/wrong-name.json' });

  assert.equal(result.valid, false);
  assert.equal(result.checks.allocationTotal, false);
  assert.equal(result.checks.filenameMatchesId, false);
  assert.match(result.errors.join('\n'), /must total 500; received 499/);
  assert.match(result.errors.join('\n'), /filename must be simulation.json/);
});

test('resolves profile IDs and reports malformed JSON', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mycrypto-profile-validator-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(path.join(root, 'profiles'), { recursive: true });
  await writeFile(path.join(root, 'data', 'portfolio.json'), JSON.stringify(portfolioConfig));
  await writeFile(path.join(root, 'profiles', 'broken.json'), '{ "id": "broken"');

  assert.equal(resolveProfilePath('broken', root), path.join(root, 'profiles', 'broken.json'));
  const result = await validateProfileFile('broken', { root });
  assert.equal(result.valid, false);
  assert.deepEqual(result.checks, { json: false });
  assert.match(result.errors[0], /Invalid JSON/);
});