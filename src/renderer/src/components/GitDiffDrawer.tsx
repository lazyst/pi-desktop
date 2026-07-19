// Right-side slide-out drawer for Git diffs (read-only).
// • Mirror of FileDrawer's slide-out UX: overlay + left-edge resize + close button.
// • Shows either the working-tree diff (unstaged + staged) when `commitHash` is
//   null, or a single commit's diff when `commitHash` is set.
// • A "← 返回工作区改动" button appears while viewing a commit diff, letting the
//   user jump back to the working-tree diff without re-opening the drawer.
// • No write/push/checkout — purely a viewer (aligned with GitView's read-only scope).
import { useCallback, useEffect, useRef, useState } from 'react';
import { pi } from '../ipc';
import { SplitDiffView } from './SplitDiffView';

interface Props {
  cwd: string;
  /** null → working-tree diff; a hash → that commit's diff. */
  commitHash: string | null;
  onClose: () => void;
}

export function GitDiffDrawer({ cwd, commitHash, onClose }: Props) {
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [widthPct, setWidthPct] = useState(45);
  const draggingRef = useRef(false);

  // Fetch the right diff whenever the target (cwd / commit) changes.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff('');
    (async () => {
      try {
        const d = await pi.gitDiff(cwd, commitHash ?? undefined);
        if (!cancelled) setDiff(d);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd, commitHash]);

  // Resize from the left edge (mirrors FileDrawer).
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startPct = widthPct;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = startX - ev.clientX; // dragging left increases width
      const deltaPct = (dx / window.innerWidth) * 100;
      const next = Math.max(25, Math.min(80, startPct + deltaPct));
      setWidthPct(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const title = commitHash ? '提交改动' : '工作区改动';
  const empty = !loading && !error && diff.trim().length === 0;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} role="presentation" />
      <div className="drawer git-diff-drawer" style={{ width: `${widthPct}%` }}>
        <div className="drawer-resizer" onMouseDown={onResizeStart} />
        <div className="drawer-header">
          <span className="drawer-title">{title}</span>
          <span className="drawer-spacer" />
          <button type="button" className="btn drawer-close" onClick={onClose}>关闭</button>
        </div>

        <div className="drawer-body">
          {loading && <div className="git-empty">加载 diff…</div>}
          {error && <div className="preview-error">{error}</div>}
          {!loading && !error && empty && (
            <div className="git-empty">{commitHash ? '该提交无改动' : '无改动'}</div>
          )}
          {!loading && !error && !empty && <SplitDiffView text={diff} />}
        </div>
      </div>
    </>
  );
}
