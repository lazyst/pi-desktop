import { test, expect, _electron, type Page, type ElectronApplication } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

// Always close the electron app after each test so its child pty processes are
// killed (kill-on-close) instead of leaking as orphaned `node fake-pi` processes.
let electronApp: ElectronApplication | undefined;
test.afterEach(async () => {
  if (electronApp) {
    await electronApp.close().catch(() => {});
    electronApp = undefined;
  }
});

async function latestTick(page: Page): Promise<number> {
  const txt = await page.locator('.terminal-host.active .xterm-rows').innerText().catch(() => '');
  const m = [...txt.matchAll(/tick (\d+)/g)];
  return m.length ? Number(m[m.length - 1][1]) : -1;
}

function pidAlive(pid: number): boolean {
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '"').toString();
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

async function keyOf(page: Page, text: string): Promise<string> {
  const k = await page.locator('.session-item', { hasText: text }).first().getAttribute('data-key');
  if (!k) throw new Error('session-item data-key not found for ' + text);
  return k;
}

async function launch(env: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ...env };
  delete e.ELECTRON_RENDERER_URL;
  electronApp = await _electron.launch({ args: [MAIN], env: e });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app: electronApp, page };
}

test('list → open → continuity across switch → hover terminate → close kills', async () => {
  // Isolate from the user's real (large) sessions dir so the sidebar only has the
  // two e2e sessions — keeps the terminate hover/click deterministic.
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: sessionsDir });

  async function newSession(name: string) {
    await page.locator('button', { hasText: '+ 会话' }).click();
    const input = page.locator('.modal-input');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(name);
    await page.locator('.modal-ok').click();
  }

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });

  await newSession('e2e-session');
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });
  const k1 = await keyOf(page, 'e2e-session');
  await expect(page.locator(`.session-item[data-key="${k1}"] .dot.running`)).toBeVisible();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick 1', { timeout: 5000 });
  const before = await latestTick(page);
  await newSession('e2e-session');
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'e2e-session' }).first().click();
  await expect.poll(async () => latestTick(page), { timeout: 10000 }).toBeGreaterThan(before);

  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  const item = page.locator(`.session-item[data-key="${k1}"]`);
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});

test('clicking a disk session in the sidebar opens it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-desk-'));
  const group = path.join(dir, 'disk-group');
  fs.mkdirSync(group);
  // A real pi session file: a `session` header line + the first user message,
  // whose text becomes the displayed session name.
  const header = { type: 'session', version: 3, id: 'x', timestamp: '2026-07-14T12-00-00-000Z', cwd: 'C:\\Users\\hcz' };
  const msg = { type: 'message', id: 'm', parentId: null, timestamp: '2026-07-14T12-00-01-000Z', message: { role: 'user', content: [{ type: 'text', text: 'My test session about warp pane sizing' }] } };
  fs.writeFileSync(
    path.join(group, '2026-07-14T12-00-00-000Z_disk.jsonl'),
    JSON.stringify(header) + '\n' + JSON.stringify(msg) + '\n',
  );

  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });
  // The sidebar shows the session NAME (first user message), not the timestamp.
  const item = page.locator('.session-item', { hasText: 'My test session about warp pane sizing' });
  await expect(item).toBeVisible({ timeout: 15000 });

  await item.click();
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
});
