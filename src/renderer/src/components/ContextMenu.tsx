import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  /** 图标 CSS 类名（如 codicon 或 SVG 图标类），渲染在 label 左侧。 */
  icon?: string;
  danger?: boolean;
  onClick?: () => void;
  /** 'separator' 表示渲染为分隔线，此时 label/onClick/danger 均忽略。 */
  kind?: 'separator';
  /** 键盘快捷键提示（仅用于展示，不绑定实际快捷键）。 */
  shortcut?: string;
  /** 禁用态：灰色不可点击，键盘导航跳过。 */
  disabled?: boolean;
}
interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function ContextMenuInner({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 用 ref 稳定 onClose 引用，避免父组件内联函数导致 useEffect 反复清理/重建。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    // 捕获阶段的 mousedown：即使焦点落在 xterm 终端内（其可能阻止事件冒泡），
    // document 层也能在捕获阶段拿到该事件，从而点按菜单外部（如主终端区）即关闭菜单。
    const onPointerDown = (e: MouseEvent) => {
      // 只处理左键点击，忽略右键和中键。右键 mousedown 先于 contextmenu 触发，
      // 若不排除会导致刚弹出的菜单立即关闭（mousedown 捕获阶段先于 React 合成事件）。
      if (e.button !== 0) return;
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
    // 依赖数组为空：onClose 经 ref 稳定引用，不随父组件重渲染变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘导航：上下箭头循环、Home/End 跳转首尾
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('.context-menu-item:not(.disabled)');
    if (!buttons || buttons.length === 0) return;

    const currentIndex = Array.from(buttons).findIndex((b) => b === document.activeElement);

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = currentIndex + 1 < buttons.length ? currentIndex + 1 : 0;
        buttons[next]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1;
        buttons[prev]?.focus();
        break;
      }
      case 'Home': {
        e.preventDefault();
        buttons[0]?.focus();
        break;
      }
      case 'End': {
        e.preventDefault();
        buttons[buttons.length - 1]?.focus();
        break;
      }
    }
  };

  // 按鼠标点击处（clientX/clientY）定位；超出视口时夹取以保证完整可见。
  const MENU_W = 200;
  const MENU_H = Math.max(40, items.length * 30 + 8);
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left, top }}
      role="menu"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => {
        if (it.kind === 'separator') {
          return <div key={i} className="context-menu-separator" />;
        }
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={[
              'context-menu-item',
              it.danger ? 'danger' : '',
              it.disabled ? 'disabled' : '',
            ].filter(Boolean).join(' ')}
            disabled={it.disabled}
            tabIndex={-1}
            onClick={() => { if (!it.disabled) { it.onClick?.(); onClose(); } }}
          >
            {it.icon && <span className={`context-menu-item-icon ${it.icon}`} />}
            <span className="context-menu-item-label">{it.label}</span>
            {it.shortcut && <span className="context-menu-item-shortcut">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 右键上下文菜单组件。
 *
 * 使用 createPortal 渲染到 document.body，确保菜单不受父级 CSS transform 属性
 * 影响定位基准。若父级有 transform/translateX(0)（如 .rp-tab-content 的滑动切换），
 * 会导致 position:fixed 的菜单定位到该容器而非视口，造成菜单位置偏移和 scroll 事件误触发。
 */
export function ContextMenu(props: Props) {
  return createPortal(
    <ContextMenuInner {...props} />,
    document.body,
  );
}