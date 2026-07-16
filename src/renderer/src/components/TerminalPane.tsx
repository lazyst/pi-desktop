import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { pi } from '../ipc';
import { IconArrowDown } from './icons';
import { XtermTerminal } from './XtermTerminal';

interface Props {
  sessionKey: string;
  active: boolean;
}

// React 壳：仅负责生命周期（active 时挂载 XtermTerminal、非 active 时卸载）、
// 提供 host div、转发右键菜单与置底按钮。所有 xterm 渲染 / 缓冲 / 度量逻辑已收编进
// XtermTerminal（见 docs/adr/0002）。对外契约（props、IPC 信道、行为语义）与原 TerminalPane
// 完全一致，对 App.tsx / 主进程 / preload 完全透明。
export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermTerminal>();
  const [showJump, setShowJump] = useState(false);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    termRef.current?.handleContextMenu(e);
  }, []);

  // active 切换：挂载 / 卸载 XtermTerminal 实例。
  useEffect(() => {
    if (!active || !hostRef.current) return;
    const term = new XtermTerminal({ sessionKey, pi });
    term.onShowJump(setShowJump);
    termRef.current = term;
    term.mount(hostRef.current);
    return () => {
      term.unmount();
      termRef.current = undefined;
    };
  }, [active, sessionKey]);

  // 尺寸变化：交给 XtermTerminal 走防抖 refit（流式窗口内冻结，见 docs/adr/0002 T1）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    const ro = new ResizeObserver(() => termRef.current?.scheduleResize());
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, sessionKey]);

  return (
    <>
      <div
        ref={hostRef}
        data-session={sessionKey}
        className={active ? 'terminal-host active' : 'terminal-host'}
        onContextMenu={handleContextMenu}
      />
      {active && (
        <button
          className={`jump-bottom${showJump ? ' visible' : ''}`}
          title="滚动到最新"
          aria-label="滚动到最新"
          onClick={() => termRef.current?.scrollToBottom()}
        >
          <IconArrowDown />
        </button>
      )}
    </>
  );
}
