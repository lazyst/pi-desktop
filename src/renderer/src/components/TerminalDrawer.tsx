import { useCallback, useRef, type MouseEvent } from 'react';
import { TerminalTabBar } from './TerminalTabBar';
import type { TabItem } from './TerminalTabBar';
import { IntegratedPane } from './IntegratedPane';
import { IconTerminal } from './icons';
import { useTabStore } from '../store/tabStore';

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
          tabs={terminals.map((t) => ({ id: t.id, title: t.title })) as TabItem[]}
          activeId={activeId}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onNew={onNewTerminal}
        />
      </div>
      <div className="terminal-drawer-body">
        {terminals.map((t) => (
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
