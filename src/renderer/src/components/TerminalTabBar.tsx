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
import { buildGroupedRows } from './tabGrouping';
export type { RenderedRow } from './tabGrouping';

export interface TabItem {
  id: string;
  title: string;
  /** 分组归并键（ADR-0001 TabAutoGroup）：同键的终端 tab 归为一段，段间插视觉分隔。
   *  不传则视为「无分组键」。纯展示层，不进 store 数据模型。终端区用 cwd。 */
  groupKey?: string;
}

// TerminalTabBar 的 TabItem.groupKey 承载分组键（见上方接口）。

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  // 拖拽重排（ADR-0001 TabReorder）：传入则启用 @dnd-kit 同区域排序；
  // 拖拽结束回调「按当前视觉顺序的 id 列表」，由父层（TerminalDrawer）调 store.reorderTabs。
  onReorder?: (orderedIds: string[]) => void;
  // TabAutoGroup（ADR-0001 E3）：传入则按 item.groupKey 归并分组，组间插视觉分隔。
  // 纯展示层归类，不进 store（无 group 实体）；与拖拽重排互不冲突。
  groupBy?: (t: TabItem) => string | undefined;
}

// TerminalTabBar 分组展示行复用共享 buildGroupedRows（与 TabBar 同源，避免重复实现）。
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
export function TerminalTabBar({ tabs, activeId, onSelect, onClose, onNew, onReorder, groupBy }: Props) {
  // 分组展示行（TabAutoGroup）：纯展示归类，不影响 tabs 数据顺序。
  const rows = buildGroupedRows(tabs, groupBy);

  // 无可重排（无 onReorder）时退化为纯展示，保持与原行为完全一致。
  if (!onReorder) {
    return (
      <div className="terminal-tabbar" role="tablist">
        {rows.map((row, i) =>
          row.type === 'sep' ? (
            <span key={`sep-${i}`} className="terminal-tab-group-sep" aria-hidden="true" />
          ) : (
            <div
              key={row.item.id}
              role="tab"
              aria-selected={row.item.id === activeId}
              className={row.item.id === activeId ? 'terminal-tab active' : 'terminal-tab'}
              onClick={() => onSelect(row.item.id)}
              title={row.item.title}
            >
              <span className="terminal-tab-title">{row.item.title}</span>
              <button
                type="button"
                className="tab-close"
                aria-label="关闭终端"
                title="关闭终端"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(row.item.id);
                }}
              >
                <IconClose size={12} />
              </button>
            </div>
          ),
        )}
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
          {rows.map((row, i) =>
            row.type === 'sep' ? (
              // 分组分隔符：非 sortable 静态元素，不参与拖拽排序计算。
              <span key={`sep-${i}`} className="terminal-tab-group-sep" aria-hidden="true" />
            ) : (
              <SortableTermTab
                key={row.item.id}
                item={row.item}
                activeId={activeId}
                onSelect={onSelect}
                onClose={onClose}
              />
            ),
          )}
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
