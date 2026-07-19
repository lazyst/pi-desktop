import { useEffect, useRef, useState, useCallback, type MouseEvent } from 'react';
import { pi } from '../ipc';
import { XtermTerminal } from './XtermTerminal';
import { IntegratedChannel } from './terminalChannel';

interface Props {
  // 终端实例 id，形如 'term-<uuid>'。同时作为 XtermTerminal 的 sessionKey（仅作标识），
  // 所有数据流走 IntegratedChannel（terminal:* IPC），与终端实例 id 完全对应。
  terminalId: string;
  // 是否当前可见（keep-alive 模式下非 active 不析构，仅隐藏 host + setActive(false)）。
  active: boolean;
}

// 集成终端壳：仿 TerminalPane，但驱动的是集成终端抽屉里的真实 shell 实例。
// 关键差异：
//  - 数据通道用 IntegratedChannel(pi, terminalId)（terminal:* IPC），而非 SessionChannel。
//  - 卸载时除了 unmount 实例，还要调 pi.destroyTerminal(terminalId) 让主进程杀掉 pty。
// 其余（keep-alive、ResizeObserver、跳到底部浮钮）与 TerminalPane 完全对齐，
// 保证切 tab 不重建、不闪首帧。
export function IntegratedTerminalPane({ terminalId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // keep-alive：实例只创建一次、跨 active 切换保留（对齐 VS Code setVisible 不析构语义）。
  const termRef = useRef<XtermTerminal | null>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    termRef.current?.handleContextMenu(e);
  }, []);

  const handleJumpBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  // 创建终端实例一次（keep-alive）：不随 active 频繁重建，避免切 tab 首帧闪。
  // 首次 active 时 mount，非 active 时实例已建但等待 setActive(true) 时 open。
  // 卸载：unmount 实例 + 通知主进程销毁 pty（集成终端特有收尾）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host || termRef.current) return;
    const term = new XtermTerminal({
      sessionKey: terminalId, // 仅作标识，数据全走 IntegratedChannel
      channel: new IntegratedChannel(pi, terminalId),
      pi,
    });
    // 视口贴底状态变化 → 驱动浮钮显隐。
    term.onScrollState = (bottom) => setAtBottom(bottom);
    termRef.current = term;
    if (active) term.mount(host);
    return () => {
      // 清理时只卸载 xterm 渲染实例，不杀主进程侧 pty。
      // 销毁 pty 的唯一入口是用户点 ×（handleCloseTab → pi.destroyTerminal）；
      // 此处若也调 destroyTerminal，会在 React StrictMode 的 mount→unmount→mount
      // 双调用（dev）或抽屉收起隐藏时误杀刚创建的 pty，导致“新建即消失 / 闪退”。
      // drawerOpen 收起只是 display:none 隐藏 Pane（不卸载），pty 自然保留（keep-alive）。
      term.unmount();
      termRef.current = null;
    };
  }, [terminalId]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  // 关键：切回可见时显式调 setActive(true) 而非仅 mount——mount 对“已挂载实例”是 no-op
  // （if mounted return），不会触发 resize；但 display:none 隐藏期间 xterm 尺寸为 0，
  // 切回后必须 flush + doResize 用真实容器尺寸重测，否则沿用隐藏期的 0 尺寸渲染，
  // 表现为“切回的终端变空白新终端、历史输出丢失”。切走时 active 已是 false，故
  // 此处 setActive(true) 能真正进入 doResize 分支（对齐 VS Code setVisible 的 _resize）。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) {
      term.mount(hostRef.current!); // 幂等：已挂载则直接 return
      term.setActive(true);         // 切回：flush + 强制 resize 校准尺寸
    } else {
      term.setActive(false);
    }
  }, [active]);

  // 尺寸变化：交给 XtermTerminal 走防抖 refit。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => termRef.current?.scheduleResize());
    ro.observe(host);
    return () => ro.disconnect();
  }, [terminalId]);

  // 非 active 时整块隐藏（keep-alive），CSS display:none。
  const hidden = !active;

  return (
    <>
      <div
        ref={hostRef}
        data-terminal={terminalId}
        className={active ? 'integrated-terminal-host active' : 'integrated-terminal-host'}
        onContextMenu={handleContextMenu}
      />
      {/* 「跳到底部」浮钮：仅在视口上滚离底、且当前面板为 active 时显示。 */}
      {active && !atBottom && (
        <button
          type="button"
          className="jump-bottom visible"
          title="跳到底部"
          aria-label="跳到底部"
          onClick={handleJumpBottom}
        >
          ↓
        </button>
      )}
      {hidden && <span hidden data-testid="integrated-hidden" />}
    </>
  );
}
