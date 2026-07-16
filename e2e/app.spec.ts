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
  // xterm 6.0.0 的 WebGL 渲染器把文本画在 <canvas> 上、不创建 .xterm-rows DOM 层，
  // 故改用 host 的 data-output 镜像（见 XtermTerminal.appendMirror）断言真实输出。
  await expect(page.locator('.terminal-host.active')).toHaveAttribute('data-output', /fake-pi ready/, { timeout: 15000 });
  const before = Number((await page.locator('.terminal-host.active').getAttribute('data-output'))?.match(/tick (\d+)/)?.[1] ?? '0');
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);
  // 记录 session-A 首个进程 pid，用于验证“切走再切回”是否复用同一进程。
  const aPid = (await page.evaluate(() => (window as any).pi.debug())).pids[0];

  await page.locator('.session-item', { hasText: 'session-B' }).click();
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(2);
  await page.waitForTimeout(3000);
  await page.locator('.session-item', { hasText: 'session-A' }).click();
  await expect.poll(async () => Number((await page.locator('.terminal-host.active').getAttribute('data-output'))?.match(/tick (\d+)/)?.[1] ?? '0'), { timeout: 10000 }).toBeGreaterThan(before);

  // 切回同一会话必须复用原进程（而非新起一个）：原 A 进程 pid 必须仍在被追踪的进程集中。
  // 修复前会再 spawn 一个 pi 并覆盖池记录，使原进程被孤儿化、不再被追踪 → 该断言失败。
  const pidsAll = (await page.evaluate(() => (window as any).pi.debug())).pids as number[];
  expect(pidsAll).toContain(aPid);
  const item = page.locator('.session-item', { hasText: 'session-A' }).first();
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
  await expect(page.locator('.terminal-host.active')).toHaveAttribute('data-output', /fake-pi ready/, { timeout: 15000 });

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  await page.locator('.terminal-host.active').click();
  await page.keyboard.type('hello from new session\n');

  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 8000 });
  // 没发消息的 live 会话不出现；只有新建的这一个 pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  await electronApp!.close();
});

test('promoted session reuses the live process (no duplicate) and is highlighted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-reuse-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proj-'));
  writeDiskSession(dir, proj, 'seeded-session');
  const { page } = await launch({ PI_DESKTOP_FAKE: '1', PI_DESKTOP_SESSIONS_DIR: dir });

  await expect(page.getByText('会话', { exact: true })).toBeVisible({ timeout: 15000 });

  // hover 目录 → 点新建会话图标（需求 2）。这会创建一个 live 会话（key live-<uuid>）。
  await page.locator('.group', { hasText: proj }).locator('[data-action="new-session"]').click();
  await expect(page.locator('.terminal-host.active')).toHaveAttribute('data-output', /fake-pi ready/, { timeout: 15000 });
  // 新建会话在写盘前，终端标题显示占位名 “new-session”
  await expect(page.locator('.header-title')).toContainText('new-session');

  // 发送首条消息 → fake-pi 写盘 → 晋升进侧边栏
  await page.locator('.terminal-host.active').click();
  await page.keyboard.type('hello from new session\n');
  await expect(page.locator('.session-item', { hasText: 'hello from new session' })).toBeVisible({ timeout: 8000 });

  // 晋升后终端标题应更新为真实会话名（首条消息），不再显示占位名 “new-session”
  await expect(page.locator('.header-title')).toContainText('hello from new session');
  await expect(page.locator('.header-title')).not.toContainText('new-session ·');

  // 晋升后只有一个 live pty 在跑（seeded 是 disk-only）
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 点击晋升后的侧边栏会话：必须复用同一个 live 进程，而非再 spawn 一个重复进程
  await page.locator('.session-item', { hasText: 'hello from new session' }).click();
  await page.waitForTimeout(500);
  expect((await page.evaluate(() => (window as any).pi.debug())).count).toBe(1);

  // 晋升后的会话应被高亮为当前活动会话
  await expect(
    page.locator('.group', { hasText: proj }).locator('.session-item.active', { hasText: 'hello from new session' }),
  ).toBeVisible({ timeout: 5000 });

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

  // pin 持久化在主进程 config.json（见 docs/adr/0001），经 pi.getConfig() 验证已写入。
  // 注：不要用 localStorage 断言——pin 不走 localStorage，且 Electron 的 localStorage 跨运行残留会污染。
  const stored = await page.evaluate(() => (window as any).pi.getConfig());
  expect((stored.pinnedDirs as string[]).includes(proj)).toBe(true);

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
  await expect(page.locator('.terminal-host.active')).toHaveAttribute('data-output', /fake-pi ready/, { timeout: 15000 });
  // 焦点移到 xterm 的输入 textarea（而非 host 容器），确保键盘输入真正进入 pty，
  // 不会因焦点停在未失焦的会话项上、被 Sidebar 的 onKeyDown 误当作“重新打开会话”。
  const host = page.locator('.terminal-host.active');
  await host.locator('.xterm-helper-textarea').click();
  // Flood the terminal so it overflows the viewport (FAB only shows when scrolled up).
  for (let i = 0; i < 60; i++) {
    await page.keyboard.type(`fill ${i}\n`);
  }
  // 60 行确已进入终端（经 data-output 镜像断言，WebGL 渲染器下无 .xterm-rows DOM 层）。
  await expect(page.locator('.terminal-host.active')).toHaveAttribute('data-output', /fill 59/, { timeout: 10000 });
  const vp = page.locator('.terminal-host.active .xterm-viewport');
  // 注意：xterm 6.0.0 的 WebGL 渲染器下 .xterm-viewport 的 scrollHeight 不随缓冲区增长
  // （文本在 <canvas> 上，原生 scrollTop 恒为 0）。置底按钮改由 xterm buffer API
  // (viewportY < baseY) 驱动（见 XtermTerminal.bindScroll），故这里不再等物理溢出。
  // Scroll up with a REAL wheel so it travels through xterm's own wheel handler, which moves
  // the internal viewportY (ydisp) and fires term.onScroll → drives the jump button. Retry a
  // few times because the fake pty keeps ticking and re-syncs the viewport to the bottom.
  await vp.hover({ force: true });
  let scrolledUp = false;
  for (let i = 0; i < 30 && !scrolledUp; i++) {
    await page.mouse.wheel(0, -1000);
    await page.waitForTimeout(80);
    scrolledUp = await page.locator('.jump-bottom.visible').count().then((c) => c > 0);
  }
  expect(scrolledUp).toBe(true);
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  // Requirement 5 (layout): the FAB must NOT overlap the native vertical scrollbar.
  // The xterm scrollbar is the rightmost 10px of the viewport (which sits 8px inside the
  // terminal host padding). Assert the button's right edge sits left of the scrollbar.
  const noOverlap = await page.evaluate(() => {
    const btn = document.querySelector('.jump-bottom.visible') as HTMLElement | null;
    const vp = document.querySelector('.terminal-host.active .xterm-viewport') as HTMLElement | null;
    if (!btn || !vp) return false;
    const b = btn.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    const scrollbarLeft = v.right - 10; // 10px webkit scrollbar width (见 .xterm-viewport CSS)
    return b.right <= scrollbarLeft + 1;
  });
  expect(noOverlap).toBe(true);

  // Requirement 4 (runtime): once scrolled up, the jump button stays visible (the buffer is NOT
  // force-snapped to the bottom by incoming data — xterm's native auto-follow only applies when
  // already at the bottom). Verify stability over a few fake-pty ticks.
  await page.waitForTimeout(2500);
  await expect(page.locator('.jump-bottom.visible')).toBeVisible({ timeout: 5000 });

  await page.locator('.jump-bottom.visible').click();
  // Returned to bottom: the visible (active) FAB is gone.
  await expect(page.locator('.jump-bottom.visible')).toHaveCount(0);

  await electronApp!.close();
});
