// 编辑器共用的小工具：主题判定与字号缩放读取。
// 从原 CodePreview 抽出 themeIsDark，并新增 getFontScale（读根节点 --font-scale）。
// Monaco 与 CodeMirror 共享，避免重复实现。

import { useEffect } from 'react';
import type { editor } from 'monaco-editor';
import * as monaco from 'monaco-editor';

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

/** 当前应设的 Monaco 字号（基准 13px × 缩放比例，取整）。 */
export function getMonacoFontSize(): number {
  return Math.round(13 * getFontScale());
}

/**
 * 主题跟随：监听根节点 data-theme，切换 vs-dark / light（与 Monaco 主题体系一致）。
 * Monaco 的 setTheme 是全局单例，故任意编辑器组件调用都等价；在各自组件内调用
 * 即可保证挂载时立即对齐当前主题。
 * 被 MonacoCodeEditor / MonacoDiffEditor 共用，避免重复实现。
 */
export function useMonacoThemeFollow(): void {
  useEffect(() => {
    const apply = () => monaco.editor.setTheme(themeIsDark() ? 'vs-dark' : 'vs');
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
}

/**
 * 字号跟随：监听 --font-scale（fontSize.ts 写到根节点的 inline style），按比例刷新
 * 传入 editor 的字号。返回 apply 回调，挂载时由调用方对 original/modified 双模型分别调用。
 * 被 MonacoCodeEditor / MonacoDiffEditor 共用，避免重复实现。
 */
export function useMonacoFontFollow(
  getEditor: () => editor.IStandaloneCodeEditor | editor.IStandaloneDiffEditor | null,
): () => void {
  const apply = () => {
    const ed = getEditor();
    if (!ed) return;
    const fontSize = getMonacoFontSize();
    ed.updateOptions({ fontSize });
  };
  useEffect(() => {
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);
  return apply;
}
