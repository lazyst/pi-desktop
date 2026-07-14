import { test, expect, _electron, type Page } from '@playwright/test';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const MAIN = path.join(__dirname, '..', 'out', 'main', 'index.js');

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

test('list → open → continuity across switch → hover terminate → close kills', async () => {
  // Launch WITHOUT ELECTRON_RENDERER_URL so the built file is loaded (not a dev server),
  // and WITH PI_DESKTOP_FAKE so the fake backend (fake-pi.mjs) is spawned instead of real `pi`.
  const env = { ...process.env, PI_DESKTOP_FAKE: '1' };
  delete env.ELECTRON_RENDERER_URL;
  const electronApp = await _electron.launch({ args: [MAIN], env });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // NOTE: Electron disables window.prompt/alert/confirm in this build, so the Sidebar
  // uses an in-renderer modal (`.modal-input` + `.modal-ok`) instead of a native dialog.
  // We drive it directly — fully hermetic, no manual steps.
  async function newSession(name: string) {
    await page.locator('button', { hasText: '+ 会话' }).click();
    const input = page.locator('.modal-input');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill(name);
    await page.locator('.modal-ok').click();
  }

  // 1) app loaded (sidebar header visible)
  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });

  // 2) open first fake session → terminal renders, green dot running
  await newSession('e2e-session');
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('fake-pi ready', { timeout: 15000 });
  await expect(page.locator('.session-item', { hasText: 'e2e-session' }).first().locator('.dot.running')).toBeVisible();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 3) open a second session, switch back to first, prove it kept ticking while hidden
  // Wait until a tick has actually rendered on the active (first) session so the
  // baseline is meaningful, then record it.
  await expect(page.locator('.terminal-host.active .xterm-rows')).toContainText('tick 1', { timeout: 5000 });
  const before = await latestTick(page);
  await newSession('e2e-session');
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'e2e-session' }).first().click();
  // xterm re-paints the buffered rows on the switched-to pane asynchronously; poll
  // until the tick count has advanced past the baseline (continuity proven). This is
  // robust to re-paint timing without weakening the assertion.
  await expect.poll(async () => latestTick(page), { timeout: 10000 }).toBeGreaterThan(before);

  // 4) capture all child pids, then hover-terminate the first session
  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  const item = page.locator('.session-item', { hasText: 'e2e-session' }).first();
  await item.hover();
  await item.locator('.terminate').click();
  await expect(item.locator('.dot.running')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 5) close app → all child pids must be gone (kill-on-close)
  await electronApp.close();
  // App is closed, so wait via node (the page is gone) then verify pids.
  await new Promise((r) => setTimeout(r, 2500));
  for (const pid of pidsAll) expect(pidAlive(pid)).toBe(false);
});
