import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { IconClose, IconNewSession } from './icons';

export interface TabItem {
  id: string;
  title: string;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  // 拖拽重排（ADR-0001 TabReorder）：传入则启用 @dnd-kit 同区域排序；
  // 拖拽结束回调「按当前视觉顺序的 id 列表」，由父层（TerminalDrawer）调 store.reorderTabs。
  onReorder?: (orderedIds: string[]) => void;
}

// 单个可排序的终端 tab：接入 useSortable，拖拽时应用 transform/transition。
function SortableTermTab({
  item,
  activeId,
  onSelect,
  onClose,
}: {
  item: TabItem;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={item.id === activeId}
      className={item.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
      onClick={() => onSelect(item.id)}
      title={item.title}
    >
      <span className="terminal-tab-title">{item.title}</span>
      <button
        type="button"
        className="tab-close"
        aria-label="关闭终端"
        title="关闭终端"
        ref={setActivatorNodeRef}
        onClick={(e) => {
          e.stopPropagation();
          onClose(item.id);
        }}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

// 集成终端 tab 条：列出所有终端实例，点击切 tab，每个 tab 右侧 × 关单个终端，
// 最右「+」新建终端。当前 active 的 tab 加 active class；关闭 × 默认隐藏，hover 才显示
// （CSS .tab-close 控制，T8 阶段补样式）。
//
// 拖拽重排（ADR-0001 TabReorder）：当传入 onReorder 时，整个 tab 条包进
// DndContext + SortableContext；拖拽结束把「视觉顺序的 id 列表」交给 onReorder
// （父层调 store.reorderTabs('panel', ...) 仅改 order，不碰集成终端渲染实例）。
export function TerminalTabBar({ tabs, activeId, onSelect, onClose, onNew, onReorder }: Props) {
  // 无可重排（无 onReorder）时退化为纯展示，保持与原行为完全一致。
  if (!onReorder) {
    return (
      <div className="terminal-tabbar" role="tablist">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            className={t.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
            onClick={() => onSelect(t.id)}
            title={t.title}
          >
            <span className="terminal-tab-title">{t.title}</span>
            <button
              type="button"
              className="tab-close"
              aria-label="关闭终端"
              title="关闭终端"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="tab-new"
          aria-label="新建终端"
          title="新建终端"
          onClick={onNew}
        >
          <IconNewSession size={14} />
        </button>
      </div>
    );
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // tabs 顺序即视觉顺序（父层已按 store.order 排序传入）。拖拽结束依据当前
  // tabs 顺序计算旧/新下标，arrayMove 后把新顺序回传 onReorder。
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tabs.findIndex((t) => t.id === String(active.id));
    const newIndex = tabs.findIndex((t) => t.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(tabs, oldIndex, newIndex).map((t) => t.id);
    onReorder?.(reordered);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        <div className="terminal-tabbar" role="tablist">
          {tabs.map((t) => (
            <SortableTermTab
              key={t.id}
              item={t}
              activeId={activeId}
              onSelect={onSelect}
              onClose={onClose}
            />
          ))}
          <button
            type="button"
            className="tab-new"
            aria-label="新建终端"
            title="新建终端"
            onClick={onNew}
          >
            <IconNewSession size={14} />
          </button>
        </div>
      </SortableContext>
    </DndContext>
  );
}
