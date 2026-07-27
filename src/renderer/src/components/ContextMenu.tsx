import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Root, Content, Item, Separator } from '@radix-ui/react-dropdown-menu';

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

  // 手动处理外部点击关闭（配合 Radix DismissableLayer）。
  // Radix 内部使用 pointerdown，但 jsdom 测试环境只 fire mouseDown，
  // 且捕获阶段 mousedown 确保焦点落在 xterm 终端内也能关闭。
  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
    // 依赖数组为空：onClose 经 ref 稳定引用，不随父组件重渲染变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 按鼠标点击处（clientX/clientY）定位；超出视口时夹取以保证完整可见。
  const MENU_W = 200;
  const MENU_H = Math.max(40, items.length * 30 + 8);
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_H - 8);

  return (
    <Root open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Content
        ref={ref}
        className="context-menu"
        style={{ position: 'fixed', left, top }}
        // 阻止关闭时自动聚焦到被点击的元素，避免焦点跳跃
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.kind === 'separator') {
            return <Separator key={i} className="context-menu-separator" />;
          }
          return (
            <Item
              key={i}
              className={[
                'context-menu-item',
                it.danger ? 'danger' : '',
                it.disabled ? 'disabled' : '',
              ].filter(Boolean).join(' ')}
              disabled={it.disabled}
              onClick={() => { if (!it.disabled) { it.onClick?.(); onClose(); } }}
              data-danger={it.danger ? 'true' : undefined}
            >
              {it.icon && <span className={`context-menu-item-icon ${it.icon}`} />}
              <span className="context-menu-item-label">{it.label}</span>
              {it.shortcut && <span className="context-menu-item-shortcut">{it.shortcut}</span>}
            </Item>
          );
        })}
      </Content>
    </Root>
  );
}

/**
 * 右键上下文菜单组件。
 *
 * 使用 @radix-ui/react-dropdown-menu 实现，提供内置的键盘导航和可访问性。
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
