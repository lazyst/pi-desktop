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
import { IconClose, IconNewSession, IconFile, IconGitDiff, IconSession, IconTerminal } from './icons';
import { buildGroupedRows } from './tabGrouping';
export type { RenderedRow } from './tabGrouping';

export type TabKind = 'session' | 'preview' | 'diff' | 'integrated-terminal';

export interface TabBarItem {
  id: string;
  title: string;
  kind: TabKind;
  closable?: boolean;   // 默认 true；某些特殊 tab 可设为不可关闭
  /** 分组归并键（ADR-0001 TabAutoGroup）：同键的 tab 在 tab 条上归为一段，段间插视觉分隔。
   *  不传则视为「无分组键」，与其他无键 tab 混排。纯展示层，不进 store 数据模型。
   *  例：中间区 session/diff 用 cwd、preview 用 root；终端区用 cwd。 */
  groupKey?: string;
}

interface Props {
  tabs: TabBarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;     // 可选：提供则在最右显示「+」新建按钮
  showNew?: boolean;      // 是否显示新建按钮（默认 onNew 存在且为 true）
  // 拖拽重排（ADR-0001 TabReorder）：传入则启用 @dnd-kit 同区域排序；
  // 拖拽结束后回调「按当前视觉顺序的 id 列表」，由父层（CenterPane）调 store.reorderTabs。
  // 不传则纯展示（如右栏固定 files/git 两个 tab）。
  onReorder?: (orderedIds: string[]) => void;
  // TabAutoGroup（ADR-0001 E3）：传入则按 item.groupKey 归并分组，组间插视觉分隔。
  // 纯展示层归类，不进 store（无 group 实体）；与 onReorder 拖拽重排互不冲突——
  // 分隔符为非 sortable 静态元素，所有 tab 仍在同一 SortableContext 中可跨段拖拽。
  // 分组仅改变展示顺序/分隔，不改变 tabs 数据顺序（父层传入顺序即视觉顺序）。
  groupBy?: (t: TabBarItem) => string | undefined;
}

const renderKindIcon = (kind: TabKind) => {
  switch (kind) {
    case 'session':
      return <IconSession size={14} />;
    case 'preview':
      return <IconFile size={14} />;
    case 'diff':
      return <IconGitDiff size={14} />;
    case 'integrated-terminal':
      return <IconTerminal size={14} />;
    default:
      return null;
  }
};

// 单个可排序的 tab：接入 useSortable，拖拽时应用 transform/transition。
// 整个 tab 可拖；关闭 × 仍走 onClick（stopPropagation 已阻止切 tab）。
function SortableTab({
  item,
  activeId,
  onSelect,
  onClose,
}: {
  item: TabBarItem;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖拽中的 tab 提到最上层并略降透明度，避免被非 active 样式盖住。
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.85 : undefined,
  };

  const closable = item.closable ?? true;

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
      <span className="terminal-tab-icon">{renderKindIcon(item.kind)}</span>
      <span className="terminal-tab-title">{item.title}</span>
      {closable && (
        <button
          type="button"
          className="tab-close"
          aria-label="关闭"
          title="关闭"
          ref={setActivatorNodeRef}
          onClick={(e) => {
            e.stopPropagation();
            onClose(item.id);
          }}
        >
          <IconClose size={12} />
        </button>
      )}
    </div>
  );
}

// 通用 Tab 条：支持三种 tab kind（session/preview/diff）显示不同前缀图标，
// 每个 tab 右侧 × 关单个 tab，最右可选「+」新建按钮。复用 TerminalTabBar 的
// 视觉类名体系（terminal-tabbar / terminal-tab / tab-close / tab-new），CSS 无需大改。
// 当前 active 的 tab 加 active class；关闭 × 默认隐藏，hover 才显示（CSS 控制）。
//
// 拖拽重排（ADR-0001 TabReorder）：当传入 onReorder 时，整个 tab 条包进
// DndContext + SortableContext，每个 tab 成为 useSortable 项；拖拽结束把「视觉顺序
// 的 id 列表」交给 onReorder（父层调 store.reorderTabs 仅改 order，不碰渲染实例）。
// 渲染顺序完全由父层传入的 tabs 顺序（即 store.order 排序后的结果）决定，本组件不
// 另存一份顺序快照，从而保证 store 重排后 TabBar 视觉顺序即时跟随。
export function TabBar({ tabs, activeId, onSelect, onClose, onNew, showNew, onReorder, groupBy }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // 分组展示行（TabAutoGroup）：纯展示归类，不影响 tabs 数据顺序。
  const rows = buildGroupedRows(tabs, groupBy);

  const newVisible = showNew ?? onNew !== undefined;

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
              <span className="terminal-tab-icon">{renderKindIcon(row.item.kind)}</span>
              <span className="terminal-tab-title">{row.item.title}</span>
              {(row.item.closable ?? true) && (
                <button
                  type="button"
                  className="tab-close"
                  aria-label="关闭"
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(row.item.id);
                  }}
                >
                  <IconClose size={12} />
                </button>
              )}
            </div>
          ),
        )}
        {newVisible && onNew && (
          <button
            type="button"
            className="tab-new terminal-new-btn"
            aria-label="新建"
            title="新建"
            onClick={onNew}
          >
            <IconNewSession size={14} />
          </button>
        )}
      </div>
    );
  }

  // tabs 顺序即视觉顺序（父层已按 store.order 排序传入）。拖拽结束依据当前
  // tabs 顺序计算旧/新下标，arrayMove 后把新顺序回传 onReorder。
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tabs.findIndex((t) => t.id === String(active.id));
    const newIndex = tabs.findIndex((t) => t.id === String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(tabs, oldIndex, newIndex).map((t) => t.id);
    onReorder(reordered);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
        <div className="terminal-tabbar" role="tablist">
          {rows.map((row, i) =>
            row.type === 'sep' ? (
              // 分组分隔符：非 sortable 静态元素，不参与拖拽排序计算；
              // 仍需渲染在 SortableContext 内以共享 flex 行布局，但不进 items 数组。
              <span key={`sep-${i}`} className="terminal-tab-group-sep" aria-hidden="true" />
            ) : (
              <SortableTab
                key={row.item.id}
                item={row.item}
                activeId={activeId}
                onSelect={onSelect}
                onClose={onClose}
              />
            ),
          )}
          {newVisible && onNew && (
            <button
              type="button"
              className="tab-new terminal-new-btn"
              aria-label="新建"
              title="新建"
              onClick={onNew}
            >
              <IconNewSession size={14} />
            </button>
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}
