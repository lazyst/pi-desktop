// 可拖拽分割线组件（纯渲染，无内部拖拽状态机）
//
// 视觉为 1px 中心线，hover/drag 时 scale 4× + 高亮色，
// 宽不可见命中区域（8px padding + 负 margin）。
// 拖拽逻辑由父组件通过 onMouseDown 传递。
//
// 同时注册为 @dnd-kit droppable（id 前缀 split-divider-），
// 使 SplitPaneDragProvider 的 onDragOver 可以检测并忽略该区域。

import { useDroppable } from '@dnd-kit/core';
import type { SplitDirection } from '../store/splitStore';

interface Props {
  direction: SplitDirection;
  onMouseDown: (e: React.MouseEvent) => void;
}

export function SplitDivider({ direction, onMouseDown }: Props) {
  const isHorizontal = direction === 'horizontal';

  // 注册为 droppable，id 前缀为 split-divider-（SplitPaneDragProvider 据此忽略）
  const { setNodeRef } = useDroppable({
    id: `split-divider-${Math.random().toString(36).slice(2, 9)}`,
  });

  return (
    <div
      ref={setNodeRef}
      className={`split-divider ${isHorizontal ? 'split-divider--horizontal' : 'split-divider--vertical'}`}
      onMouseDown={onMouseDown}
    />
  );
}