// Image preview. Fetches the file via fs:readFile which returns a base64
// data URL (already bounds-checked to the allowed root on the main side).
// Supports mouse-wheel zoom (Ctrl/Cmd+wheel or plain wheel) and drag-to-pan
// when the image is zoomed in.
import { useEffect, useRef, useState, useCallback } from 'react';
import { pi } from '../ipc';

interface Props {
  root: string;
  path: string;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

export function ImagePreview({ root, path }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    setTooBig(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    (async () => {
      try {
        const res = await pi.fsReadFile(root, path);
        if (!cancelled) {
          if (res.dataUrl) setUrl(res.dataUrl);
          else setTooBig(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [root, path]);

  // Ctrl/Cmd + wheel → zoom; plain wheel → zoom too (images have no native scroll here).
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setScale((s) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * (1 + delta)));
      // 缩小回 1 时归零偏移，避免漂移
      if (next <= 1.001) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= 1) return; // 未放大时不平移
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [scale, offset]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  if (error) return <div className="preview-error">无法加载图片：{error}</div>;
  if (tooBig) return <div className="preview-error">图片过大，无法预览。</div>;
  if (!url) return <div className="preview-empty">加载中…</div>;

  return (
    <div
      className="image-preview"
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
    >
      <img
        src={url}
        alt={path}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'center center',
          cursor: scale > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'default',
          maxWidth: '100%',
          maxHeight: '100%',
        }}
      />
      <div className="image-preview-toolbar">
        <span className="image-preview-zoom">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.2))} title="放大">＋</button>
        <button type="button" onClick={() => setScale((s) => Math.max(MIN_SCALE, s / 1.2))} title="缩小">－</button>
        <button type="button" onClick={resetView} title="重置 (100%)">重置</button>
      </div>
    </div>
  );
}
