import { useEffect, useRef, useState, useCallback, type MouseEvent, type KeyboardEvent } from 'react';
import { pi } from '../ipc';
import {
  acquirePane,
  mountPane,
  setPaneActive,
  schedulePaneResize,
  setPaneScrollHandler,
  scrollPaneToBottom,
  paneHandleContextMenu,
  releasePane,
} from './paneManager';
import { useTabStore } from '../store/tabStore';
import { basenameOf } from '../lib/mdPath';
import type { XtermTerminal } from './XtermTerminal';
import type { AppConfig } from '../types';

// 工作区根目录缓存（避免每次点击都读一次 config IPC）。
let _workspaceRootsCache: string[] | null = null;
let _configPromise: Promise<AppConfig | null> | null = null;

/** 获取已知工作区根目录列表（从 config 提取 addedDirs + appWorkDir）。
 *  缓存结果，避免高频 IPC 调用。
 *  对齐 VS Code 的 workspace 解析：对终端文件链接，先尝试匹配工作区根目录，
 *  再回退到文件所在目录。 */
async function getWorkspaceRoots(): Promise<string[]> {
  if (_workspaceRootsCache) return _workspaceRootsCache;
  if (!_configPromise) {
    _configPromise = pi.getConfig().catch(() => null);
  }
  const cfg = await _configPromise;
  if (!cfg) return [];
  const roots = new Set<string>();
  if (Array.isArray(cfg.addedDirs)) cfg.addedDirs.forEach((r: string) => roots.add(r));
  if (cfg.appWorkDir) roots.add(cfg.appWorkDir);
  _workspaceRootsCache = Array.from(roots);
  return _workspaceRootsCache;
}

// 清空缓存（测试用 / config 变更时由外部调用）。
export function clearWorkspaceRootsCache(): void {
  _workspaceRootsCache = null;
  _configPromise = null;
}

interface Props {
  // 终端实例 id，形如 'term-<uuid>'。同时作为 XtermTerminal 的 sessionKey（仅作标识），
  // 数据流的通道选择（IntegratedChannel）由 PaneManager 据本壳的 kind 决定。
  terminalId: string;
  // 是否当前可见（keep-alive 模式下非 active 不析构，仅隐藏 host + setActive(false)）。
  active: boolean;
}

// 集成终端壳（替代原 IntegratedTerminalPane）：仿 SessionPane，但驱动集成终端实例。
// 关键差异（已收编进 PaneManager.acquirePane 的 channel 选择）：
//  - 数据通道用 IntegratedChannel（terminal:* IPC），而非 SessionChannel。
//  - 卸载实例由 PaneManager.releasePane 完成；杀掉主进程侧 pty 的唯一入口是用户点 ×
//    （App.handleCloseTab → pi.destroyTerminal），本壳不负责。
// 其余（keep-alive、ResizeObserver、跳到底部浮钮）与 SessionPane 完全对齐，保证切 tab 不重建、
// 不闪首帧。对外 DOM 契约（.integrated-terminal-host / data-terminal / 隐藏 span）与原组件一致。
export function IntegratedPane({ terminalId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  // 视口是否贴底（驱动「跳到底部」浮钮显隐）。
  const [atBottom, setAtBottom] = useState(true);
  // 查找面板可见性 + 当前查询串（对齐 VS Code TerminalFindWidget）。
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [findRegex, setFindRegex] = useState(false);
  const [findWord, setFindWord] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    paneHandleContextMenu(terminalId, e);
  }, [terminalId]);

  const handleJumpBottom = useCallback(() => {
    scrollPaneToBottom(terminalId);
  }, [terminalId]);

  // 创建终端实例一次（keep-alive）：经 PaneManager.acquirePane 取/建 IntegratedChannel 实例，
  // 跨 active 切换保留。非 active 时实例已建但等待 setActive(true) 时 open。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = acquirePane({ key: terminalId, kind: 'integrated', pi });
    termRef.current = term;
    // 视口贴底状态变化 → 驱动浮钮显隐。
    setPaneScrollHandler(terminalId, (bottom) => setAtBottom(bottom));
    // 接入 shell integration capability 回传：
    //  - cwd 检测 → 更新主进程缓存并推侧边栏目录分组（对齐 VS Code CwdDetectionCapability）。
    //  - 文件链接点击 → 在系统文件管理器选中（应用无内置编辑器，系统打开已由 link 本身触发）。
    term.onCwdChange = (cwd) => pi.updateTerminalCwd?.(terminalId, cwd);
    // 文件链接点击：在 pi-desktop 编辑器中打开文件。
    // 根据绝对路径尝试匹配工作区根目录，转为 (root, relPath) 后调用 openPreview。
    term.onOpenFile = async (_path, _line, _col) => {
      const absPath = _path.replace(/\\/g, '/');
      // 获取已知工作区根目录（从 config 及当前激活 cwd）
      const roots = await getWorkspaceRoots();
      const state = useTabStore.getState();
      if (state.activeCwd && !roots.includes(state.activeCwd)) {
        roots.unshift(state.activeCwd);
      }
      for (const root of roots) {
        const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
        if (absPath.startsWith(normalizedRoot + '/')) {
          const relPath = absPath.slice(normalizedRoot.length + 1);
          useTabStore.getState().openPreview(root, relPath, basenameOf(relPath));
          return;
        }
      }
      // 无匹配：尝试直接打开（根目录设为该文件所在目录）
      const dir = absPath.lastIndexOf('/') > 0 ? absPath.slice(0, absPath.lastIndexOf('/')) : absPath;
      const name = basenameOf(absPath);
      useTabStore.getState().openPreview(dir, name, name);
    };
    if (active) mountPane(terminalId, host);
    return () => {
      // 清理时只卸载 xterm 渲染实例（经 PaneManager.releasePane 注销），
      // 不杀主进程侧 pty：销毁 pty 的唯一入口是用户点 ×（App.handleCloseTab → pi.destroyTerminal）；
      // 此处若也调 destroyTerminal，会在 React StrictMode 的 mount→unmount→mount 双调用（dev）
      // 时误杀刚创建的 pty，导致"新建即消失 / 闪退"。
      // 隐藏期只是 CSS opacity:0（不卸载），pty 自然保留（keep-alive）。
      const buf = term.serializeScrollback();
      if (buf) pi.saveTerminalBuffer?.(terminalId, buf);
      releasePane(terminalId);
      termRef.current = null;
    };
  }, [terminalId]);

  // active 切换：通知 XtermTerminal 可见性（不销毁），首次 active 时 mount，切回时校准尺寸。
  // 滚动位置保存/恢复由 CenterPane 在 activeCwd 切换前完成（对齐 Orca captureScrollState）。
  useEffect(() => {
    if (active) {
      mountPane(terminalId, hostRef.current!); // 幂等：已挂载则直接 return
      setPaneActive(terminalId, true);         // 切回：flush + 强制 resize 校准尺寸
    } else {
      setPaneActive(terminalId, false);
    }
  }, [active, terminalId]);

  // 尺寸变化：交给 PaneManager → XtermTerminal 走防抖 refit。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => schedulePaneResize(terminalId));
    ro.observe(host);
    return () => ro.disconnect();
  }, [terminalId]);

  // 终端内查找：Ctrl/Cmd+F 打开查找面板，Esc 关闭，Enter/Shift+Enter 前/后查找。
  const runFind = useCallback((backward: boolean) => {
    const term = termRef.current;
    if (!term || !findText) return;
    if (backward) term.findPrevious(findText, { caseSensitive: findCase, regex: findRegex, wholeWord: findWord });
    else term.findNext(findText, { caseSensitive: findCase, regex: findRegex, wholeWord: findWord });
  }, [findText, findCase, findRegex, findWord]);

  const handleFindKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runFind(e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setFindOpen(false);
    }
  }, [runFind]);

  // 全局 Ctrl/Cmd+F 打开查找面板（仅当本面板 active）。
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // 非 active 时整块隐藏（keep-alive），CSS opacity:0 + pointer-events:none。
  // opacity:0 保留完整布局尺寸，xterm canvas 不丢失 WebGL 上下文，切回时内容立即可见。
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
      {/* 终端内查找面板（对齐 VS Code TerminalFindWidget）：Ctrl/Cmd+F 唤起。 */}
      {active && findOpen && (
        <div className="terminal-find-widget" role="search">
          <input
            ref={findInputRef}
            type="text"
            value={findText}
            placeholder="在终端中查找"
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={handleFindKey}
            aria-label="查找"
          />
          <button
            type="button"
            className={findCase ? 'active' : ''}
            title="区分大小写 (Alt+C)"
            onClick={() => setFindCase((v) => !v)}
          >Aa</button>
          <button
            type="button"
            className={findRegex ? 'active' : ''}
            title="正则 (Alt+R)"
            onClick={() => setFindRegex((v) => !v)}
          >.*</button>
          <button
            type="button"
            className={findWord ? 'active' : ''}
            title="整词 (Alt+W)"
            onClick={() => setFindWord((v) => !v)}
          >ab</button>
          <button type="button" title="上一个 (Shift+Enter)" onClick={() => runFind(true)}>↑</button>
          <button type="button" title="下一个 (Enter)" onClick={() => runFind(false)}>↓</button>
          <button type="button" title="关闭 (Esc)" onClick={() => setFindOpen(false)}>×</button>
        </div>
      )}
      {hidden && <span hidden data-testid="integrated-hidden" />}
    </>
  );
}
