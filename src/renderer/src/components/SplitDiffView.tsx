// Two-column split diff renderer. Ported from pi-web/components/MessageView.tsx
// (SplitPatchView + SplitDiffCellView), made a standalone component driven by
// parseUnifiedPatch(). Renders a single-file or multi-file unified diff.
import { useMemo } from 'react';
import { parseUnifiedPatch, type SplitDiffCell } from '../lib/patch';

export function SplitDiffView({ text }: { text: string }) {
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div className="diff-scroll">
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          className="diff-file"
        >
          {showFileHeaders && (
            <div className="diff-file-header">
              <SplitDiffHeader title={file.oldPath || 'Before'} side="left" />
              <SplitDiffHeader title={file.newPath || 'After'} side="right" />
            </div>
          )}

          <div className="diff-grid">
            {file.rows.map((row, rowIndex) => {
              if (row.type === 'hunk') {
                return (
                  <div key={rowIndex} className="diff-hunk" style={{ display: 'contents' }}>
                    <span className="diff-hunk-cell">{row.text}</span>
                    <span className="diff-hunk-cell">{row.text}</span>
                  </div>
                );
              }
              return (
                <div key={rowIndex} style={{ display: 'contents' }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: 'left' | 'right' }) {
  return (
    <div className={`diff-header-cell ${side === 'left' ? 'diff-header-left' : 'diff-header-right'}`} title={title}>
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: 'left' | 'right' }) {
  const bg =
    cell.type === 'added'
      ? 'rgba(34,197,94,0.12)'
      : cell.type === 'removed'
        ? 'rgba(248,113,113,0.13)'
        : cell.type === 'empty'
          ? 'var(--bg-subtle, #0b0e14)'
          : 'transparent';
  const marker =
    cell.type === 'added' ? '+' : cell.type === 'removed' ? '-' : ' ';
  const markerColor =
    cell.type === 'added' ? '#22c55e' : cell.type === 'removed' ? '#f87171' : 'var(--text-dim)';

  return (
    <div className={`diff-cell ${side === 'left' ? 'diff-cell-left' : 'diff-cell-right'}`} style={{ background: bg }}>
      <span className="diff-lineno">{cell.lineNo ?? ''}</span>
      <span className="diff-marker" style={{ color: markerColor }}>{marker}</span>
      <span className="diff-text">{cell.text || ' '}</span>
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
            <span className="diff-text" style={{ color }}>{line || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}
