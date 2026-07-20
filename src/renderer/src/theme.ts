import { pi } from './ipc';
import type { Theme } from './types';
export type { Theme };
// 终端主题已抽到独立的 lib/terminal-themes（对齐 orca lib/terminal-theme.ts），
// 主题定义/背景跟随容器逻辑集中于该模块，本文件仅做向后兼容委托导出，不重复维护调色板。
import { getTermTheme, TERM_THEMES } from './lib/terminal-themes';
export { getTermTheme, TERM_THEMES };

const listeners = new Set<(t: Theme) => void>();

// 同步读取主进程在窗口创建时经 additionalArguments 注入的初始 config（见 preload 的
// getInitialConfig），使首屏主题（含随后打开的终端）无需等待异步 IPC，杜绝暗→亮闪烁。
function readInitialTheme(): Theme {
  try {
    const cfg = (window as any).pi?.getInitialConfig?.();
    if (cfg && (cfg.theme === 'light' || cfg.theme === 'dark')) return cfg.theme;
  } catch { /* 无注入配置（如测试）时回退默认主题 */ }
  return 'dark';
}

// 主题持久化改为主进程 config（见 docs/adr/0001），不再用 localStorage。

// Drive the whole UI from a single attribute on <html>. `:root` holds the dark
// defaults; `[data-theme="light"]` (in tokens.css) overrides the same token names,
// so every component — sidebar, title bar, modals — follows the theme for free.
function paint(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
}

export function getTheme(): Theme {
  return (document.documentElement.getAttribute('data-theme') as Theme) ?? 'dark';
}

export function setTheme(t: Theme) {
  paint(t);
  // config 经异步 IPC 持久化；用 .catch 吸收拒绝（try/catch 抓不到 Promise 拒绝）。
  pi.setConfig({ theme: t }).catch(() => {});
  listeners.forEach((l) => l(t));
}

export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// 首屏尽早上色以避免闪烁：config 在主进程、须经异步 IPC 读取，
// 故先以 readInitialTheme()（同步注入值，回退 'dark'）上色，App 挂载后由 initTheme() 校正。
paint(readInitialTheme());

// App 挂载后调用：从主进程配置读取持久化主题并应用（config 为异步来源）。
export async function initTheme(): Promise<void> {
  try {
    const cfg = await pi.getConfig();
    // 同步初始主题（readInitialTheme）已先行上色；仅当与持久化值不一致才纠正并持久化，
    // 避免每次启动都多发一次无谓的 config 写与 listener 通知。
    if ((cfg.theme === 'light' || cfg.theme === 'dark') && cfg.theme !== getTheme()) {
      setTheme(cfg.theme);
    }
  } catch {
    /* 读取失败则保持默认主题 */
  }
}
