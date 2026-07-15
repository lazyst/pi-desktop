import { pi } from './ipc';
import type { Theme } from './types';

const listeners = new Set<(t: Theme) => void>();

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
// 故此处先以默认 'dark' 上色，真实主题在 App 挂载后由 initTheme() 校正。
paint('dark');

// App 挂载后调用：从主进程配置读取持久化主题并应用（config 为异步来源）。
export async function initTheme(): Promise<void> {
  try {
    const cfg = await pi.getConfig();
    if (cfg.theme === 'light' || cfg.theme === 'dark') setTheme(cfg.theme);
  } catch {
    /* 读取失败则保持默认主题 */
  }
}
