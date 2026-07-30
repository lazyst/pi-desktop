// 可拖拽分割线组件（纯渲染，无内部拖拽状态机）
//
// 视觉为 1px 中心线，hover/drag 时 scale 4× + 高亮色，
// 宽不可见命中区域（8px padding + 负 margin）。
// 拖拽逻辑由父组件通过 onMouseDown 传递。

import type { SplitDirection } from '../store/splitStore';

interface Props {
  direction: SplitDirection;
  onMouseDown: (e: React.MouseEvent) => void;
}

export function SplitDivider({ direction, onMouseDown }: Props) {
  const isHorizontal = direction === 'horizontal';
  return (
    <div
      className={`split-divider ${isHorizontal ? 'split-divider--horizontal' : 'split-divider--vertical'}`}
      onMouseDown={onMouseDown}
    />
  );
}