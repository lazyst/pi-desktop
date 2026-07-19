import { useCallback, useRef, type MouseEvent } from 'react';
import { TerminalTabBar } from './TerminalTabBar';
import type { TabItem } from './TerminalTabBar';
import { IntegratedTerminalPane } from './IntegratedTerminalPane';
import { IconTerminal } from './icons';

interface Props {
  open: boolean;
  height: number; // 抽屉高度（像素），由 App 管理（持久化 config.terminalDrawerHeight）
  tabs: { id: string; title: string }[];
  activeId: string | null;
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
// 所有 tab 的 IntegratedTerminalPane 全部渲染，非 active 的加 hidden class（display:none），
// 对齐 TerminalPane 的 keep-alive 模式（切 tab 不重建、不闪首帧）。
export function TerminalDrawer({
  open,
  height,
  tabs,
  activeId,
  onSelectTab,
  onCloseTab,
  onNewTerminal,
  onResizeHeight,
}: Props) {
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
          tabs={tabs as TabItem[]}
          activeId={activeId}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onNew={onNewTerminal}
        />
      </div>
      <div className="terminal-drawer-body">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={t.id === activeId ? 'integrated-terminal-slot active' : 'integrated-terminal-slot'}
          >
            <IntegratedTerminalPane terminalId={t.id} active={t.id === activeId} />
          </div>
        ))}
      </div>
    </div>
  );
}
