import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isValidProfile } from '../src/model.js';

export async function loadProfiles(root, config) {
  const directory = path.join(root, 'profiles');
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const supportedIds = new Set(config.supportedAssets.map(({ id }) => id));
  const profiles = [];
  const profileIds = new Set();

  for (const file of files) {
    const profile = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    if (!isValidProfile(profile, supportedIds, config.defaultPortfolio, config.totalInvestment)) {
      throw new Error(`Invalid profile: profiles/${file}`);
    }
    if (path.basename(file, '.json') !== profile.id) {
      throw new Error(`Profile filename must match its id: profiles/${file}`);
    }
    if (profileIds.has(profile.id)) {
      throw new Error(`Duplicate profile id: ${profile.id}`);
    }
    profileIds.add(profile.id);
    profiles.push(profile);
  }

  if (profiles.length === 0) throw new Error('The profiles directory contains no profiles.');
  if (!profileIds.has(config.defaultProfileId)) {
    throw new Error(`Default profile not found: ${config.defaultProfileId}`);
  }
  return profiles;
}
