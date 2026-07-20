// Copies non-bundled runtime assets that electron-vite does not copy
// (e.g. src/main/fake-pi.mjs) into the build output (out/main).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const assets = [
  { from: 'src/main/fake-pi.mjs', to: 'out/main/fake-pi.mjs' },
  // 系统托盘图标：主进程在创建 Tray 时按 dev / build 路径解析（见 issue 01）。
  { from: 'src/main/assets/tray-icon.png', to: 'out/main/assets/tray-icon.png' },
];

function copyAsset(from, to) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[copy-assets] ${from} -> ${to}`);
}

// 递归拷贝一个目录（用于 shell-integration 脚本，运行时由主进程 fs 读取注入到 shell）。
function copyDir(from, to) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) copyDir(path.join(from, entry.name), path.join(to, entry.name));
    else fs.copyFileSync(path.join(src, entry.name), path.join(to, entry.name));
  }
  console.log(`[copy-assets] ${from}/ -> ${to}/`);
}

copyDir('src/main/shell-integration', 'out/main/shell-integration');

for (const a of assets) copyAsset(a.from, a.to);
