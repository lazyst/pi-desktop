import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * getShellProfiles 测试（任务 T1）。
 *
 * 实现函数为 src/main/shellProfiles.ts 的 detectTerminalProfiles()。
 * 平台分发由 process.platform 驱动；路径是否存在由 fs.existsSync 决定。
 * 因此测试统一 mock fs.existsSync（通过 vi.mock 提供可控的「存在白名单」），
 * 并对 process.platform 做 getter spy，从而在每个用例里强制出目标平台与存在性。
 *
 * 注意：实现以 `import * as fs from 'node:fs'` 形式引入，namespace 对象的属性不可
 * 用 vi.spyOn 重定义，故必须改用 vi.mock('node:fs') 整体替换 existsSync。
 */

// 被 mock 的 fs.existsSync 实际读取的「存在白名单」，由每个用例写入。
let existingPaths: Set<string> = new Set();

vi.mock('node:fs', () => ({
  existsSync: (p: string) => existingPaths.has(String(p)),
}));

// 在指定平台上运行，并设置「被认为存在」的路径白名单。
function withPlatform(platform: NodeJS.Platform, paths: Iterable<string>): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  existingPaths = new Set(paths);
}

import { detectTerminalProfiles } from '../shellProfiles';

describe('detectTerminalProfiles', () => {
  beforeEach(() => {
    // 默认 PATH 为空，避免 findOnPath 在 Windows 用例里读到宿主机的真实 PATH。
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '' } as NodeJS.ProcessEnv);
    existingPaths = new Set();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. 平台分发：Windows / macOS / Linux 各至少一条用例 ──

  it('Windows: 返回 cmd 及被探测到的 pwsh 等平台 profile', () => {
    const windir = process.env.windir || 'C:\\Windows';
    withPlatform('win32', [`${windir}\\System32\\cmd.exe`, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']);

    const profiles = detectTerminalProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('cmd');
    expect(ids).toContain('pwsh');
    for (const p of profiles) {
      expect(['windows', 'all']).toContain(p.platform);
    }
  });

  it('macOS: 返回 $SHELL 默认值与存在的额外 shell', () => {
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv);
    withPlatform('darwin', ['/bin/zsh', '/bin/bash']);

    const profiles = detectTerminalProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('default');
    expect(ids).toContain('bash');
    for (const p of profiles) {
      expect(['macos', 'all']).toContain(p.platform);
    }
  });

  it('Linux: 返回 $SHELL 默认值与存在的额外 shell', () => {
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '', SHELL: '/bin/bash' } as NodeJS.ProcessEnv);
    withPlatform('linux', ['/bin/bash', '/usr/bin/fish']);

    const profiles = detectTerminalProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('default');
    // fish 的多个候选路径会被去重为单个 id 'fish'（extra 数组第一个）。
    expect(ids).toContain('fish');
    for (const p of profiles) {
      expect(['linux', 'all']).toContain(p.platform);
    }
  });

  // ── 2. 只返回 existsSync 为 true 的（构造一个不存在路径的假 profile 验证被过滤）──

  it('只返回 fs.existsSync 为 true 的路径，过滤掉不存在的候选', () => {
    const windir = process.env.windir || 'C:\\Windows';
    // 故意让 pwsh / git-bash / windows-powershell 的所有候选都不存在，只保留 cmd。
    withPlatform('win32', [`${windir}\\System32\\cmd.exe`]);

    const profiles = detectTerminalProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('cmd');
    expect(ids).not.toContain('pwsh');
    expect(ids).not.toContain('git-bash');
    expect(ids).not.toContain('windows-powershell');
    // 所有返回项都必须确实被 existsSync 判定存在。
    for (const p of profiles) {
      expect(existingPaths.has(p.path)).toBe(true);
    }
  });

  // ── 3. id 唯一性 ──

  it('返回的所有 profile id 唯一', () => {
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv);
    // macOS 上让多个 fish 候选同时存在，验证去重逻辑。
    withPlatform('darwin', ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish']);

    const profiles = detectTerminalProfiles();
    const ids = profiles.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    // 多个 fish 候选只保留一个（'fish'，因排在 extra 数组第一个）。
    const fishCount = ids.filter((id) => id.startsWith('fish')).length;
    expect(fishCount).toBe(1);
  });

  // ── 4. fallback：mock 全部不存在时返回至少一个合理 profile ──

  it('fallback: 全部路径不存在时仍返回至少一个合理 profile', () => {
    withPlatform('win32', []);

    const profiles = detectTerminalProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    // Windows fallback 兜底到 cmd。
    expect(profiles[0].id).toBe('cmd');
    expect(profiles[0].platform).toBe('windows');
  });

  it('fallback (macOS/Linux): 全部不存在时兜底到 $SHELL / /bin/sh / /bin/bash', () => {
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '', SHELL: '/bin/zsh' } as NodeJS.ProcessEnv);
    withPlatform('darwin', []);

    const profiles = detectTerminalProfiles();
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    expect(['default', 'sh', 'bash']).toContain(profiles[0].id);
  });

  // ── 5. Git Bash args 为 ['--login','-i']（若 git-bash 被探测到）──

  it('Git Bash 被探测到时 args 为 ["--login","-i"]', () => {
    const userProfile = process.env.UserProfile || 'C:\\Users\\test';
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, PATH: '', UserProfile: userProfile } as NodeJS.ProcessEnv);
    // 让 scoop 版 git-bash 路径存在（UserProfile 反推 + scoop 直接探测都命中此路径）。
    const gitBashPath = `${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe`;
    withPlatform('win32', [gitBashPath]);

    const profiles = detectTerminalProfiles();
    const gitBash = profiles.find((p) => p.id === 'git-bash');
    expect(gitBash).toBeDefined();
    expect(gitBash!.args).toEqual(['--login', '-i']);
    expect(gitBash!.label).toBe('Git Bash');
  });

  it('Git Bash 未被探测到时不返回 git-bash profile', () => {
    withPlatform('win32', []);

    const profiles = detectTerminalProfiles();
    expect(profiles.find((p) => p.id === 'git-bash')).toBeUndefined();
  });
});
