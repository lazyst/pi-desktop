// 自定义单栏 diff 视图（unified diff），按文件分块展示，每文件可折叠。
// 替代 MonacoDiffEditor 的并排双栏模式。
//
// 设计要点：
//   • 输入：git 的 unified diff 文本（由 gitDiff 生成）
//   • 解析：复用 parseUnifiedPatch 得到每个文件的 diff 行
//   • 每个文件渲染为可折叠的块：点击文件名横条展开/收起
//   • 文件头显示文件名、新增/删除行数统计
//   • 每行 diff 显示行号、+/- 前缀、内容，着色参考 pi-web DiffView
//   • 默认仅展开第一个有改动的文件（或全部折叠）
import { useCallback, useState } from 'react';
import { parseUnifiedPatch } from '../lib/patch';
import type { SplitDiffFile, SplitDiffRow } from '../lib/patch';

interface Props {
  diff: string;
}

/** 展开/收起状态 key。用文件名标识。 */
type ExpandState = Record<string, boolean>;

/** 统计某文件的增删行数。 */
function countChanges(rows: SplitDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'line') {
      if (row.left.type === 'removed') removed++;
      if (row.right.type === 'added') added++;
    }
  }
  return { added, removed };
}

/** 取文件名：去掉 a/ 或 b/ 前缀，取最后一段。 */
function displayName(file: SplitDiffFile): string {
  const raw = file.newPath || file.oldPath || '';
  // 去掉 a/ 或 b/ 前缀
  const cleaned = raw.replace(/^[ab]\//, '');
  return cleaned || '（未命名文件）';
}

/** 取文件名的目录部分（用于在 header 里显示路径）。 */
function dirName(file: SplitDiffFile): string {
  const raw = displayName(file);
  const idx = raw.lastIndexOf('/');
  return idx > 0 ? raw.slice(0, idx + 1) : '';
}

/** 取文件名的 basename（用于在 header 里高亮显示）。 */
function baseName(file: SplitDiffFile): string {
  const raw = displayName(file);
  const idx = raw.lastIndexOf('/');
  return idx > 0 ? raw.slice(idx + 1) : raw;
}

export function SingleDiffView({ diff }: Props) {
  const files = parseUnifiedPatch(diff);

  // 默认展开第一个文件，其余折叠
  const [expanded, setExpanded] = useState<ExpandState>(() => {
    if (!files || files.length === 0) return {};
    const state: ExpandState = {};
    state[displayName(files[0])] = true;
    return state;
  });

  const toggle = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  if (!files || files.length === 0) {
    return <div className="git-empty">无改动</div>;
  }

  return (
    <div className="sdv">
      {files.map((file) => {
        const name = displayName(file);
        const { added, removed } = countChanges(file.rows);
        const isExpanded = expanded[name] ?? false;

        return (
          <div key={name} className="sdv-file">
            {/* 可点击的文件名横条 */}
            <div
              className="sdv-file-header"
              role="button"
              tabIndex={0}
              onClick={() => toggle(name)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(name); } }}
            >
              <span className="sdv-file-header-icon">{isExpanded ? '▼' : '▶'}</span>
              <span className="sdv-file-header-dir">{dirName(file)}</span>
              <span className="sdv-file-header-name">{baseName(file)}</span>
              <span className="sdv-file-header-stats">
                {added > 0 && <span className="sdv-stat-added">+{added}</span>}
                {removed > 0 && <span className="sdv-stat-removed">-{removed}</span>}
              </span>
            </div>

            {/* Diff 行 */}
            {isExpanded && (
              <div className="sdv-lines">
                {file.rows.map((row, ri) => {
                  if (row.type === 'hunk') {
                    return (
                      <div key={ri} className="sdv-hunk">
                        {row.text}
                      </div>
                    );
                  }
                  // row.type === 'line'
                  const { left, right } = row;

                  // 处理「连续删除 + 新增」的块：先渲染所有 removed，再渲染所有 added
                  // 但由于 parseUnifiedPatch 已经按对齐方式产出 row，每个 row 可能
                  // 同时包含 left 和 right。对于 unified 视图，我们逐行渲染：
                  //   - left=removed, right=empty  → 删除行（-）
                  //   - left=empty, right=added    → 新增行（+）
                  //   - left=context, right=context → 上下文行（ ）
                  //   - left=removed, right=added  → 替换（先 - 再 +）
                  const cells: Array<{ lineNo: number | null; text: string; type: 'removed' | 'added' | 'context' }> = [];
                  if (left.type === 'removed') {
                    cells.push({ lineNo: left.lineNo, text: left.text, type: 'removed' });
                  }
                  if (right.type === 'added') {
                    cells.push({ lineNo: right.lineNo, text: right.text, type: 'added' });
                  }
                  // 如果两侧都是 context，只渲染一次
                  if (left.type === 'context' && right.type === 'context') {
                    cells.push({ lineNo: left.lineNo, text: left.text, type: 'context' });
                  }

                  return cells.map((cell, ci) => (
                    <DiffLine
                      key={`${ri}-${ci}`}
                      lineNo={cell.lineNo}
                      text={cell.text}
                      type={cell.type}
                    />
                  ));
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiffLine({
  lineNo,
  text,
  type,
}: {
  lineNo: number | null;
  text: string;
  type: 'removed' | 'added' | 'context';
}) {
  const prefix = type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
  const bg =
    type === 'added'
      ? 'var(--diff-added-bg)'
      : type === 'removed'
        ? 'var(--diff-removed-bg)'
        : 'transparent';
  const prefixColor =
    type === 'added'
      ? 'var(--diff-added)'
      : type === 'removed'
        ? 'var(--diff-removed)'
        : 'var(--text-dim)';
  const borderColor =
    type === 'added'
      ? 'var(--diff-added)'
      : type === 'removed'
        ? 'var(--diff-removed)'
        : 'transparent';

  return (
    <div
      className="sdv-line"
      style={{
        background: bg,
        borderLeft: `3px solid ${borderColor}`,
      }}
    >
      <span className="sdv-line-no">{lineNo ?? ''}</span>
      <span className="sdv-line-prefix" style={{ color: prefixColor }}>{prefix}</span>
      <span className="sdv-line-text">{text || '\u00a0'}</span>
    </div>
  );
}