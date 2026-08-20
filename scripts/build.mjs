import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

console.log('Cleaning previous build output…');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

console.log('Copying static site files…');
await Promise.all([
  cp(path.join(root, 'index.html'), path.join(dist, 'index.html')),
  cp(path.join(root, 'manage.html'), path.join(dist, 'manage.html')),
  cp(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true }),
  cp(path.join(root, 'data'), path.join(dist, 'data'), { recursive: true }),
]);

console.log('Built static site in dist/');
