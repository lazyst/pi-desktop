import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) { await electronApp.close().catch(() => {}); electronApp = undefined; }
});

function pidAlive(pid: number): boolean {
  try { return require('node:child_process').execSync(`tasklist /FI "PID eq ${pid}"`).toString().includes(String(pid)); }
  catch { return false; }
}

async function launch(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ...env };
  delete (e as any).ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

function writeDiskSession(dir: string, cwd: string, name: string) {
  const group = path.join(dir, encodeURIComponent(cwd));
  fs.mkdirSync(group, { recursive: true });
  const stamp = '2026-07-14T12-00-00-000Z';
  const header = JSON.stringify({ type: 'session', version: 3, id: 'x', timestamp: stamp, cwd });
  const msg = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: stamp, message: { role: 'user', content: [{ type: 'text', text: name }] } });
  fs.writeFileSync(path.join(group, `${stamp}_disk.jsonl`), header + '\n' + msg + '\n');
}

test('open disk session → continuity across switch → hover terminate → close kills', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-a-'));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-b-'));
  writeDiskSession(dir, cwdA, 'session-A');
  writeDiskSession(dir, cwdB, 'session-B');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'session-A' })).toBeVisible({ timeout: 15000 });

  await page.locator('.session-item', { hasText: 'session-A' }).click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });
  const before = Number((await page.locator('.terminal-host.active .xterm-rows').innerText()).match(/tick (\d+)/)?.[1] ?? '0');
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await page.locator('.session-item', { hasText: 'session-B' }).click();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'session-A' }).click();
  await expect.poll(async () => Number((await page.locator('.terminal-host.active .xterm-rows').innerText()).match(/tick (\d+)/)?.[1] ?? '0'), { timeout: 10000 }).toBeGreaterThan(before);

  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  const kA = await page.locator('.session-item', { hasText: 'session-A' }).first().getAttribute('data-key');
  const item = page.locator(`.session-item[data-key="${kA}"]`);
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});

test('new session from a directory promotes into the sidebar after first message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-promo-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'seeded-session');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'seeded-session' })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点新建会话图标（需求 2）
  await page.locator('.group', { hasText: proj }).locator('[data-action="new-session"]').click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  await page.locator('.terminal-host.active').click();
  await page.keyboard.type('hello from new session\n');

  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 8000 });
  // 没发消息的 live 会话不出现；只有新建的这一个 pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
});

test('pinning a directory persists across reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pin-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'pin-seeded');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.locator('.group', { hasText: proj }).locator('[data-action="pin"]').click();
  await expect(page.locator('.group.pinned', { hasText: proj })).toBeVisible({ timeout: 5000 });

  const stored = await page.evaluate(() => localStorage.getItem('pi-desktop:pinned-dirs'));
  expect(stored).toContain(proj.replace(/\\/g, '\\\\'));

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.group.pinned', { hasText: proj })).toBeVisible({ timeout: 5000 });

  await electronApp!.close();
});

test('jump-to-bottom button appears when scrolled up and returns to latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-jump-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'jump-seeded');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.locator('.session-item', { hasText: 'jump-seeded' })).toBeVisible({ timeout: 15000 });
  await page.locator('.session-item', { hasText: 'jump-seeded' }).click();
  // 等待若干 tick 产生溢出
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick 3', { timeout: 10000 });

  const vp = page.locator('.terminal-host.active .xterm-viewport');
  await vp.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  await page.locator('.jump-bottom.visible').click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick', { timeout: 5000 });

  await electronApp!.close();
});
