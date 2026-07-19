import type { AppConfig } from '../renderer/src/types';
import * as os from 'node:os';
import * as path from 'node:path';

// 默认应用工作目录根（~/piDesktop），可在「设置 → 终端」改为其他目录。
// ⚠️ 必须在函数内惰性求值，不能写成顶层常量 `path.join(os.homedir(), 'piDesktop')`：
// config.ts 同时被 renderer（浏览器沙箱，无 node:os）经 `defaultConfig` import，
// 模块顶层直接调用 os.homedir() 会在 renderer 端抛 "os.homedir is not a function"，
// 导致整个模块加载失败、App 无法挂载、永久卡在启动动画（见回归修复）。
export function getDefaultAppWorkDir(): string {
  // ⚠️ renderer（浏览器沙箱）无可用的 node:os，而 defaultConfig() 会被 renderer 经
  // fontSize.ts / App.tsx 调用。此处必须惰性 + 安全降级：有 node:os 才拼真实路径，
  // 否则返回中性占位（真实值由主进程 config 经 getConfig() 异步下发，App 初始态为 ''，
  // 不会用到此占位）。否则会在 renderer 端抛 "os.homedir is not a function" 导致模块
  // 加载失败、App 无法挂载、永久卡在启动动画。
  if (typeof (os as any)?.homedir === 'function') return path.join(os.homedir(), 'piDesktop');
  return 'piDesktop';
}

// 默认配置（见 docs/adr/0001）。窗口几何默认 1100×720、非最大化。
export function defaultConfig(): AppConfig {
  return {
    theme: 'dark',
    pinnedDirs: [],
    addedDirs: [],
    window: { maximized: false, bounds: { x: 0, y: 0, width: 1100, height: 720 } },
    sidebarWidth: 280,
    filePanelWidth: 260,
    closeBehavior: 'minimize-to-tray',
    fontSize: 13,
    // 集成终端：默认 profile（null = 探测到的第一个 / 平台默认）。
    defaultTerminalProfile: null,
    // 集成终端抽屉高度（像素）。
    terminalDrawerHeight: 220,
    // 用户自定义终端 profile 覆盖（key 为 profile id）。
    terminalProfiles: {},
    // app work dir group root (defaults to ~/piDesktop)
    appWorkDir: getDefaultAppWorkDir(),
  };
}

// 字体大小允许范围（px）。过小的字号无法阅读、过大撑破布局，故夹在此区间。
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 28;

/** 把任意输入夹进 [FONT_SIZE_MIN, FONT_SIZE_MAX] 且取整；非法输入回退默认 13。 */
export function clampFontSize(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return defaultConfig().fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, v));
}

// 解析 config.json 原文；损坏 / 非对象时回退默认（不抛异常，保证启动不崩）。
export function parseConfig(raw: string | null): AppConfig {
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultConfig();
    const merged = mergeConfig(defaultConfig(), parsed as Partial<AppConfig>);
    // 数值字段单独校准，避免损坏/越界值污染全局（见 FONT_SIZE_MIN/MAX）。
    merged.fontSize = clampFontSize((parsed as Partial<AppConfig>).fontSize);
    return merged;
  } catch {
    console.warn('[config] config.json corrupt, using defaults');
    return defaultConfig();
  }
}

// 浅合并：顶层字段替换（如传入 window 会整体替换，不深合并）。
export function mergeConfig(base: AppConfig, partial: Partial<AppConfig>): AppConfig {
  return { ...base, ...partial };
}
