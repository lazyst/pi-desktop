import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

async function launch(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ...env };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

test('file panel lists files, click opens drawer, no runtime errors', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fp-'));
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(proj, 'note.md'), '# title\nbody');
  fs.mkdirSync(path.join(proj, 'sub'));
  fs.writeFileSync(path.join(proj, 'sub', 'inner.ts'), 'const x = 1;');

  const { page } = await launch({ PI_DESKTOP_FAKE: '1' });

  // 捕获所有运行时错误（这是定位“点击没反应”的关键）
  const errors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });
  page.on('pageerror', (err) => errors.push('PAGEERROR: ' + (err.stack || err.message)));

  // 把测试目录注册进 addedDirs，并重载让 App 读取
  await page.evaluate((dir) => (window as any).pi.setConfig({ addedDirs: [dir] }), proj);
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // 文件面板出现 + 列出文件
  await expect(page.locator('.file-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.file-tree .file-name', { hasText: 'hello.txt' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.file-tree .file-name', { hasText: 'note.md' })).toBeVisible({ timeout: 15000 });

  // 点击文件 → 抽屉打开
  await page.locator('.file-tree .file-row', { hasText: 'note.md' }).click();
  await expect(page.locator('.drawer')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.drawer-title')).toContainText('note.md');

  if (errors.length) {
    console.log('=== RUNTIME ERRORS CAPTURED ===');
    errors.forEach((e) => console.log(e));
    throw new Error('Runtime errors detected:\n' + errors.join('\n'));
  }

  await electronApp!.close();
});
