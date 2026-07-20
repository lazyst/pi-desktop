// 编辑器共用的小工具：主题判定与字号缩放读取。
// 从原 CodePreview 抽出 themeIsDark，并新增 getFontScale（读根节点 --font-scale）。
// Monaco 与 CodeMirror 共享，避免重复实现。

/** 当前是否为暗色主题（读根节点 data-theme，缺省按暗色）。 */
export function themeIsDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  return true; // no attribute → default dark palette
}

/** 当前字号缩放比例（--font-scale：1 表示基准 13px）。缺省 1。 */
export function getFontScale(): number {
  const raw = document.documentElement.style.getPropertyValue('--font-scale');
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
