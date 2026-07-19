// Single-column (unified) diff renderer. Ported from pi-web/components/MessageView.tsx,
// driven by parseUnifiedPatch(). Renders a single-file or multi-file unified diff
// as a vertical stack of lines (like `git diff`): removed lines in red on top of
// added lines in green, context lines neutral — no side-by-side columns. This reads
// better in the narrow right-side drawer. Each file has a clickable header (file
// name + +N/-M stats) that collapses / expands the file's diff body.
import { useMemo, useState, Fragment } from 'react';
import { parseUnifiedPatch, type SplitDiffCell, type SplitDiffFile } from '../lib/patch';

/** Count added / removed lines within a single parsed file. */
function countChanges(file: SplitDiffFile): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const row of file.rows) {
    if (row.type !== 'line') continue;
    if (row.left.type === 'removed') deletions++;
    if (row.right.type === 'added') additions++;
  }
  return { additions, deletions };
}

export function SplitDiffView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  // 折叠状态：记录被折叠的文件下标集合（默认全部展开）。
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  if (!files) return <PatchTextView text={text} />;

  const toggle = (index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="diff-scroll">
      {files.map((file, fileIndex) => {
        const isCollapsed = collapsed.has(fileIndex);
        const fileName = file.newPath || file.oldPath || '（未命名文件）';
        const { additions, deletions } = countChanges(file);
        return (
          <div key={fileIndex} className="diff-file">
            <div
              className="diff-file-header diff-file-header-clickable"
              onClick={() => toggle(fileIndex)}
              title={fileName}
            >
              <span className={`diff-collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>▶</span>
              <span className="diff-file-name">{fileName}</span>
              {(additions > 0 || deletions > 0) && (
                <span className="diff-file-stats">
                  {additions > 0 && <span className="git-add">+{additions}</span>}
                  {deletions > 0 && <span className="git-del">−{deletions}</span>}
                </span>
              )}
            </div>

            {!isCollapsed && (
              <div className="diff-rows">
                {file.rows.map((row, rowIndex) => {
                  if (row.type === 'hunk') {
                    // 文件元数据头（diff --git / index / --- / +++）与 hunk 头（@@）
                    // 跨整行单栏显示，允许长路径折行。
                    return (
                      <div key={rowIndex} className="diff-hunk-cell diff-hunk-full">
                        {row.text}
                      </div>
                    );
                  }
                  // 单栏：parser 把一段删除与一段新增配对成行（left=旧, right=新）。
                  // 双栏时左右并排；单栏时需把两侧各自展开为独立行（删除在上、新增在下），
                  // 与 `git diff` 原生堆叠样式一致。某一侧为占位空 cell 时只渲染另一侧；
                  // 两侧为同类（context 配对）时只渲染一次，避免重复行。
                  const left = row.left;
                  const right = row.right;
                  const bothPresent = left.type !== 'empty' && right.type !== 'empty';
                  if (bothPresent && left.type !== right.type) {
                    // 修改配对（左删右增）→ 拆成两行：先删后增
                    return (
                      <Fragment key={rowIndex}>
                        <DiffRowView cell={left} />
                        <DiffRowView cell={right} />
                      </Fragment>
                    );
                  }
                  // 纯删除 / 纯新增 / context 配对 → 仅渲染非空或任一侧
                  const cell = left.type !== 'empty' ? left : right;
                  return <DiffRowView key={rowIndex} cell={cell} />;
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DiffRowView({ cell }: { cell: SplitDiffCell }) {
  const bg =
    cell.type === 'added'
      ? 'rgba(34,197,94,0.12)'
      : cell.type === 'removed'
        ? 'rgba(248,113,113,0.13)'
        : 'transparent';
  const marker =
    cell.type === 'added' ? '+' : cell.type === 'removed' ? '-' : ' ';
  const markerColor =
    cell.type === 'added' ? '#22c55e' : cell.type === 'removed' ? '#f87171' : 'var(--text-dim)';

  return (
    <div className="diff-row" style={{ background: bg }}>
      <span className="diff-lineno">{cell.lineNo ?? ''}</span>
      <span className="diff-marker" style={{ color: markerColor }}>{marker}</span>
      <span className="diff-text">{cell.text || ' '}</span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div className="diff-scroll">
      {lines.map((line, i) => {
        const kind =
          line.startsWith('@@') ? 'hunk' :
          line.startsWith('+') && !line.startsWith('+++') ? 'added' :
          line.startsWith('-') && !line.startsWith('---') ? 'removed' :
          'context';
        const bg =
          kind === 'added' ? 'rgba(34,197,94,0.12)' :
          kind === 'removed' ? 'rgba(248,113,113,0.13)' :
          kind === 'hunk' ? 'rgba(96,165,250,0.12)' :
          'transparent';
        const color =
          kind === 'added' ? '#22c55e' :
          kind === 'removed' ? '#f87171' :
          kind === 'hunk' ? 'var(--accent)' :
          'var(--text)';

        return (
          <div key={i} className="diff-line" style={{ background: bg, borderLeft: kind === 'context' ? '3px solid transparent' : `3px solid ${color}` }}>
            <span className="diff-lineno">{i + 1}</span>
            <span className="diff-text" style={{ color }}>{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
