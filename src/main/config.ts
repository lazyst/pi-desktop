import type { AppConfig } from '../renderer/src/types';

// ⚠️ 此模块被 renderer（浏览器沙箱，nodeIntegration:false，无 node:os/path）经
// `defaultConfig` 间接 import。绝不能 import node:os / node:path —— 否则 sandbox
// renderer 模块求值时会尝试加载 node 模块，模块图加载失败，App 无法挂载（表现为
// 启动卡动画或点击新建终端后整屏黑屏，取决于崩溃发生的时机）。
// appWorkDir 的“文件夹名”在此声明（renderer 安全占位）；main 进程在 ensureAppWorkDir
// 中结合 os.homedir() 解析为绝对路径（见 index.ts 的 getDefaultAppWorkDir）。
export const DEFAULT_APP_WORK_DIR_NAME = 'defaultWorkSpace';

// 默认应用工作目录根（~/piDesktop），可在「设置 → 终端」改为其他目录。
// 返回文件夹名（renderer 安全）；绝对路径由 main 进程的 getDefaultAppWorkDir 计算。
export function getDefaultAppWorkDir(): string {
  return DEFAULT_APP_WORK_DIR_NAME;
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
    rightPanelWidth: 280,
    closeBehavior: 'minimize-to-tray',
    fontSize: 13,
    // 集成终端：默认 profile（null = 探测到的第一个 / 平台默认）。
    defaultTerminalProfile: null,
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
