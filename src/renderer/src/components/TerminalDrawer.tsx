import { useCallback, useMemo, useRef, type MouseEvent } from 'react';
import { TerminalTabBar } from './TerminalTabBar';
import type { TabItem } from './TerminalTabBar';
import { IntegratedPane } from './IntegratedPane';
import { IconTerminal } from './icons';
import { useTabStore } from '../store/tabStore';
import type { Tab } from '../store/tabStore';

interface Props {
  open: boolean;
  height: number; // 抽屉高度（像素），由 store 持有（初始化自 config.terminalDrawerHeight）
  // 交互回调：终端 tab 的选中 / 关闭由 App 协调（关闭需同时调主进程 destroyTerminal 与 store 状态），
  // 新建 / 高度拖拽同理。终端列表与激活态改由 store 直接订阅（见下方 useTabStore），不再透传。
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTerminal: () => void;
  onResizeHeight: (h: number) => void; // 拖拽顶部边缘调高度，实时回调
}

// 抽屉高度夹取区间（像素）。
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

const clampHeight = (h: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h));

// VS Code 式集成终端抽屉：底部抽屉 + 可拖拽高度 + tab 条 + 多终端（keep-alive）。
// 所有 tab 的 IntegratedPane 全部渲染，非 active 的加 hidden class（display:none），
// 对齐 SessionPane 的 keep-alive 模式（切 tab 不重建、不闪首帧）。
export function TerminalDrawer({
  open,
  height,
  onSelectTab,
  onCloseTab,
  onNewTerminal,
  onResizeHeight,
}: Props) {
  // 终端实例列表 / 当前激活终端直接订阅 store（issue 03：App 仅把主进程推送写回 store，
  // 抽屉组件自行取数，消除 App→CenterPane→TerminalDrawer 的 props 透传）。
  const terminals = useTabStore((s) => s.terminals);
  const activeId = useTabStore((s) => s.activeTermId);
  // 订阅 tabs 以便 order 变化（拖拽重排）驱动终端 tab 顺序刷新。
  const tabs = useTabStore((s) => s.tabs);
  // 拖拽重排（ADR-0001 TabReorder）：仅改同 location 的 order，不碰集成终端渲染实例。
  const reorderTabs = useTabStore((s) => s.reorderTabs);
  // TabBar 视觉顺序需跟随 store.order（拖拽重排只改 order），故按各终端在 tabs 中的
  // order 升序展示；terminals 本身是主进程推送的原序，不反映拖拽结果。
  const orderedTerminals = useMemo(
    () =>
      [...terminals].sort((a, b) => {
        const ta = tabs.find((t) => t.id === a.id);
        const tb = tabs.find((t) => t.id === b.id);
        return (ta?.order ?? 0) - (tb?.order ?? 0);
      }),
    [terminals, tabs],
  );
  const resizerStart = useRef<{ startY: number; startHeight: number } | null>(null);
  const onResizeRef = useRef(onResizeHeight);
  onResizeRef.current = onResizeHeight;

  const onResizerMove = useCallback((e: globalThis.MouseEvent) => {
    const s = resizerStart.current;
    if (!s) return;
    // 向上拖（clientY 变小）→ 高度增大。
    const next = clampHeight(s.startHeight + (s.startY - e.clientY));
    onResizeRef.current(next);
  }, []);

  const onResizerUp = useCallback(() => {
    resizerStart.current = null;
    document.removeEventListener('mousemove', onResizerMove);
    document.removeEventListener('mouseup', onResizerUp);
  }, [onResizerMove]);

  const onResizerDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      resizerStart.current = { startY: e.clientY, startHeight: height };
      document.addEventListener('mousemove', onResizerMove);
      document.addEventListener('mouseup', onResizerUp);
    },
    [height, onResizerMove, onResizerUp],
  );

  if (!open) return null;

  return (
    <div className="terminal-drawer" style={{ height }} data-testid="terminal-drawer">
      <div
        className="terminal-drawer-resizer"
        onMouseDown={onResizerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整终端高度"
      />
      <div className="terminal-drawer-header">
        <IconTerminal size={14} className="terminal-drawer-icon" />
        <TerminalTabBar
          tabs={orderedTerminals.map((t) => ({
            id: t.id,
            title: t.title,
            // TabAutoGroup（issue 12 / ADR-0001 E3）：终端按 cwd 归并分组。
            // cwd 取 store tabs 里对应 integrated-terminal tab 的 cwd（终端列表本身无 cwd）。
            groupKey:
              (tabs.find((x) => x.id === t.id && x.kind === 'integrated-terminal') as
                | Extract<Tab, { kind: 'integrated-terminal' }>
                | undefined)?.cwd ?? '',
          })) as TabItem[]}
          activeId={activeId}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onNew={onNewTerminal}
          onReorder={(orderedIds) => reorderTabs('panel', orderedIds)}
          // 按 groupKey 稳定归并：同 cwd 聚一段、段间插视觉分隔；与拖拽重排互不冲突。
          groupBy={(t) => t.groupKey}
        />
      </div>
      <div className="terminal-drawer-body">
        {orderedTerminals.map((t) => (
          <div
            key={t.id}
            className={t.id === activeId ? 'integrated-terminal-slot active' : 'integrated-terminal-slot'}
          >
            <IntegratedPane terminalId={t.id} active={t.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
