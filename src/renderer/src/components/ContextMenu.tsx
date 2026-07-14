import { useEffect } from 'react';

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}
interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDocClick = () => onClose();
    const onScroll = () => onClose();
    const onResize = () => onClose();
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  // 按鼠标点击处（clientX/clientY）定位；超出视口时夹取以保证完整可见。
  const MENU_W = 160;
  const MENU_H = Math.max(36, items.length * 32 + 8);
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <div className="context-menu" style={{ left, top }} role="menu" onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={`context-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => { it.onClick(); onClose(); }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
