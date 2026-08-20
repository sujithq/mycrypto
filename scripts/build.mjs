import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadProfiles } from './load-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

console.log('Cleaning previous build output…');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const config = JSON.parse(await readFile(path.join(root, 'data', 'portfolio.json'), 'utf8'));
const profiles = await loadProfiles(root, config);

console.log('Copying static site files…');
await Promise.all([
  cp(path.join(root, 'index.html'), path.join(dist, 'index.html')),
  cp(path.join(root, 'manage.html'), path.join(dist, 'manage.html')),
  cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true }),
  cp(path.join(root, 'data'), path.join(dist, 'data'), { recursive: true }),
  mkdir(path.join(dist, 'profiles'), { recursive: true }),
]);
await writeFile(path.join(dist, 'profiles', 'index.json'), `${JSON.stringify(profiles, null, 2)}\n`);

console.log('Built static site in dist/');
