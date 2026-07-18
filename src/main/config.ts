import type { AppConfig } from '../renderer/src/types';

// 默认配置（见 docs/adr/0001）。窗口几何默认 1100×720、非最大化。
export function defaultConfig(): AppConfig {
  return {
    theme: 'dark',
    pinnedDirs: [],
    addedDirs: [],
    window: { maximized: false, bounds: { x: 0, y: 0, width: 1100, height: 720 } },
    sidebarWidth: 280,
    closeBehavior: 'minimize-to-tray',
  };
}

// 解析 config.json 原文；损坏 / 非对象时回退默认（不抛异常，保证启动不崩）。
export function parseConfig(raw: string | null): AppConfig {
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultConfig();
    return mergeConfig(defaultConfig(), parsed as Partial<AppConfig>);
  } catch {
    console.warn('[config] config.json corrupt, using defaults');
    return defaultConfig();
  }
}

// 浅合并：顶层字段替换（如传入 window 会整体替换，不深合并）。
export function mergeConfig(base: AppConfig, partial: Partial<AppConfig>): AppConfig {
  return { ...base, ...partial };
}
