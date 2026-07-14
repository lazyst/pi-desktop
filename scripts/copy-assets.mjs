// Copies non-bundled runtime assets that electron-vite does not copy
// (e.g. src/main/fake-pi.mjs) into the build output (out/main).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const assets = [
  { from: 'src/main/fake-pi.mjs', to: 'out/main/fake-pi.mjs' },
];

function copyAsset(from, to) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] ${from} -> ${to}`);
}

for (const a of assets) copyAsset(a.from, a.to);
