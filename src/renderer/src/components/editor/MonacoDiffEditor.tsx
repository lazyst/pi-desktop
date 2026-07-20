// Monaco 封装的「diff 编辑表面」（EditorSurface 的 diff 形态，同源 Monaco）。
// 取代自研 SplitDiffView（unified 单栏解析渲染）。
//
// 设计要点（对齐 MonacoCodeEditor / ADR-0002 / issue 09）：
//   • 用 @monaco-editor/react 的 <DiffEditor>：original（左/旧）与 modified（右/新）
//     双模型，由 monaco 内部计算行内差异（inline diff），无需自研分割算法。
//   • 主题跟随：监听根节点 data-theme，切换 vs-dark / light（与代码编辑器一致）。
//   • 字号跟随：监听 --font-scale（fontSize.ts 写入根节点），按比例设 editor fontSize。
//   • keep-alive：DiffTab 始终挂载、非 active 由 CSS display:none（对齐代码编辑器），
//     故这里无需额外视图状态缓存；组件卸载时由 keepCurrentModel 保留历史 diff 模型。
//   • 只读：diff 是纯浏览表面，readOnly + renderSideBySide 并排呈现。
//
// 注意：本组件只负责「把一个 unified patch 文本渲染成 diff」，不解析 patch 结构
// （Monaco 的 diff 输入是 original/modified 两份完整文本，而非 git 的 unified 格式）。
// 因此由父组件（DiffTab）把 git diff 还原成 original/modified 文本后传入。
import { useEffect, useRef } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { monaco } from './monaco-setup';
import { themeIsDark, getFontScale } from '../../editorUtils';

interface Props {
  /** 原始（左侧）文本，对应 git diff 的「旧版本」内容。 */
  original: string;
  /** 修改后（右侧）文本，对应 git diff 的「新版本」内容。 */
  modified: string;
  /** 语言 id（如 typescript / markdown / json…），用于两侧着色。 */
  language: string;
}

// 把 root + 标识合成稳定、合法的 monaco model uri，作为 original/modified 双模型的 key。
// originalModelPath / modifiedModelPath 会经 monaco.Uri.parse 传给 createModel，
// 故这里直接构造合法 uri 即可保证跨 diff 渲染复用同一对模型（keep-alive 锚点）。
// 用 `file://` scheme + encode 防止特殊字符破坏 uri 解析。
function diffModelUri(key: string, side: 'original' | 'modified'): string {
  return `file:///${encodeURIComponent(`${key}//${side}`)}`;
}

export function MonacoDiffEditor({ original, modified, language }: Props) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);

  // 主题跟随：监听根节点 data-theme。
  useEffect(() => {
    const apply = () => monaco.editor.setTheme(themeIsDark() ? 'vs-dark' : 'vs');
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // 字号跟随：监听 --font-scale（fontSize.ts 写到根节点）。
  useEffect(() => {
    const apply = () => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.updateOptions({ fontSize: Math.round(13 * getFontScale()) });
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);

  const handleMount: DiffOnMount = (ed) => {
    editorRef.current = ed;
    // 初始字号对齐当前 --font-scale，双模型（original/modified）一并设置。
    const fontSize = Math.round(13 * getFontScale());
    ed.updateOptions({ fontSize });
    ed.getOriginalEditor().updateOptions({ fontSize });
    ed.getModifiedEditor().updateOptions({ fontSize });
  };

  // diff 的 key 锚定在（仓库 + commit）上：工作区 diff 用 ''、提交 diff 用 hash。
  // 这里用空 key——DiffTab 每次 diff 文本变化都会整体替换，模型由上面的 uri 复用。
  const modelKey = '';

  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language || 'plaintext'}
      theme={themeIsDark() ? 'vs-dark' : 'vs'}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      originalModelPath={diffModelUri(modelKey, 'original')}
      modifiedModelPath={diffModelUri(modelKey, 'modified')}
      options={{
        readOnly: true,
        automaticLayout: true, // 容器尺寸变化（tab 切换/CSS 隐藏）自动重排
        fontSize: Math.round(13 * getFontScale()),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontFamily: 'var(--font-mono)',
        wordWrap: 'on',
        renderSideBySide: true,
        renderOverviewRuler: false,
        ignoreTrimWhitespace: false,
        // 行内差异高亮（字符级），与代码编辑器视觉一致。
        diffWordWrap: 'on',
        originalAriaLabel: '原始内容',
        modifiedAriaLabel: '修改后内容',
      }}
      className="monaco-diff-editor"
      onMount={handleMount}
    />
  );
}
