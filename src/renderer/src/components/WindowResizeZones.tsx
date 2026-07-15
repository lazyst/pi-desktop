import { useCallback, useRef, type MouseEvent } from 'react';
import { pi } from '../ipc';

type Zone = 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
const ZONES: Zone[] = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
const MIN_W = 480;
const MIN_H = 360;

interface DragState {
  zone: Zone;
  startX: number;
  startY: number;
  bounds: { x: number; y: number; width: number; height: number };
}

// A frameless window loses the OS edge-resize handles, so we re-add them with 8
// transparent hit zones along the window edges. Dragging a zone asks the main
// process for the current bounds, then nudges them via `window:set-bounds`.
export function WindowResizeZones() {
  const drag = useRef<DragState | null>(null);

  const onMove = useCallback((e: globalThis.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    let { x, y, width, height } = d.bounds;
    if (d.zone.includes('right')) width = Math.max(MIN_W, d.bounds.width + dx);
    if (d.zone.includes('left')) {
      width = Math.max(MIN_W, d.bounds.width - dx);
      x = d.bounds.x + (d.bounds.width - width);
    }
    if (d.zone.includes('bottom')) height = Math.max(MIN_H, d.bounds.height + dy);
    if (d.zone.includes('top')) {
      height = Math.max(MIN_H, d.bounds.height - dy);
      y = d.bounds.y + (d.bounds.height - height);
    }
    pi.setWindowBounds({ x, y, width, height });
  }, []);

  const onUp = useCallback(() => {
    drag.current = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }, [onMove]);

  const onMouseDown = (zone: Zone) => (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    pi.getWindowBounds().then((bounds) => {
      drag.current = { zone, startX, startY, bounds };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  };

  return (
    <>
      {ZONES.map((z) => (
        <div key={z} className={`rz rz-${z}`} onMouseDown={onMouseDown(z)} />
      ))}
    </>
  );
}
