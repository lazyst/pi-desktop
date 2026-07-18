// Right-side slide-out drawer for single-file preview / editing.
// • Overlay (semi-transparent) over the terminal area, click to dismiss.
// • Resizable from the left edge (initial 45% window width, clamped).
// • Per-type rendering: images → ImagePreview, pdf → PdfPreview,
//   text/code → CodePreview.
// • Dirty tracking + explicit save (fs:writeFile) + close-confirm when dirty.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pi } from '../ipc';
import { CodePreview } from './CodePreview';
import { ImagePreview } from './ImagePreview';
import { PdfPreview } from './PdfPreview';
import { ConfirmDialog } from './ConfirmDialog';

export interface DrawerFile {
  root: string;
  path: string; // relative path within root
  absPath?: string;
}

interface Props {
  file: DrawerFile | null;
  onClose: () => void;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r\n|\r|\n/).length;
}

export function FileDrawer({ file, onClose }: Props) {
  const [widthPct, setWidthPct] = useState(45);
  const [dirty, setDirty] = useState(false);
  const [initialContent, setInitialContent] = useState('');
  const [currentContent, setCurrentContent] = useState('');
  const [kind, setKind] = useState<'code' | 'image' | 'pdf' | 'binary' | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const draggingRef = useRef(false);

  // Load metadata (kind + initial content) when the file changes.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setDirty(false);
    setError(null);
    setKind('loading');
    setInitialContent('');
    setCurrentContent('');
    (async () => {
      try {
        const res = await pi.fsReadFile(file.root, file.path);
        if (cancelled) return;
        if (res.isImage) setKind('image');
        else if (res.isPdf) setKind('pdf');
        else if (res.isBinary) setKind('binary');
        else {
          setKind('code');
          setInitialContent(res.content);
          setCurrentContent(res.content);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setKind('binary');
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  // Resize from left edge.
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

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };

  const doSave = useCallback(async () => {
    if (!file) return;
    setSaving(true);
    setError(null);
    try {
      await pi.fsWriteFile(file.root, file.path, currentContent);
      setInitialContent(currentContent);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [file, currentContent]);

  // Ctrl/Cmd+S → save (when there are unsaved changes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // Only intercept when this drawer is the active file editor and there is something to save.
        if (file && kind === 'code' && dirty && !saving) {
          e.preventDefault();
          void doSave();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, kind, dirty, saving, doSave]);

  if (!file) return null;

  const fileName = basename(file.path);

  return (
    <>
      <div className="drawer-overlay" onClick={requestClose} role="presentation" />
      <div className="drawer" style={{ width: `${widthPct}%` }}>
        <div className="drawer-resizer" onMouseDown={onResizeStart} />
        <div className="drawer-header">
          <span className="drawer-title" title={file.path}>{fileName}</span>
          {kind === 'code' && (
            <span className="drawer-meta">
              {currentContent ? `${countLines(currentContent)} 行` : ''}
            </span>
          )}
          {dirty && <span className="drawer-dirty" title="有未保存改动">●</span>}
          {error && <span className="drawer-error">{error}</span>}
          <span className="drawer-spacer" />
          {kind === 'code' && (
            <button
              type="button"
              className="btn btn-primary drawer-save"
              disabled={!dirty || saving}
              onClick={() => void doSave()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          )}
          <button type="button" className="btn drawer-close" onClick={requestClose}>关闭</button>
        </div>

        <div className="drawer-body">
          {kind === 'loading' && <div className="preview-empty">加载中…</div>}
          {kind === 'code' && (
            <CodePreview root={file.root} path={file.path} onChange={(c) => {
              setCurrentContent(c);
              setDirty(c !== initialContent);
            }} />
          )}
          {kind === 'image' && <ImagePreview root={file.root} path={file.path} />}
          {kind === 'pdf' && file.absPath && <PdfPreview absPath={file.absPath} />}
          {kind === 'pdf' && !file.absPath && <div className="preview-error">PDF 预览需要本地绝对路径。</div>}
          {kind === 'binary' && !error && (
            <div className="preview-error">该文件为二进制或过大，无法预览。</div>
          )}
        </div>
      </div>

      {confirmClose && (
        <ConfirmDialog
          title="关闭文件"
          message="文件有未保存的改动，确定关闭？改动将不会写入磁盘。"
          confirmLabel="关闭并丢弃"
          cancelLabel="继续编辑"
          onConfirm={() => { setConfirmClose(false); onClose(); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
