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

// 拷贝 shell-integration 脚本（不含 inject.ts，已编译进 index.js bundle）。
// 运行时 getShellIntegrationInjection 用 __dirname 定位脚本，
// 绑定后 __dirname = out/main/，故脚本需平铺到 out/main/ 根下。
const shellScripts = [
  'shellIntegration.ps1',
  'shellIntegration-bash.sh',
  'shellIntegration.fish',
  'shellIntegration-env.zsh',
  'shellIntegration-login.zsh',
  'shellIntegration-profile.zsh',
  'shellIntegration-rc.zsh',
];
for (const f of shellScripts) {
  copyAsset(`src/main/shell-integration/${f}`, `out/main/${f}`);
}

for (const a of assets) copyAsset(a.from, a.to);
