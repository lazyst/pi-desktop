import { useEffect, useState } from 'react';
import { pi } from '../ipc';
import { IconSettings, IconMinimize, IconMaximize, IconRestore, IconClose, IconTerminal } from './icons';

interface Props {
  onOpenSettings: () => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
}

// Custom title bar for the frameless window. Everything is painted with CSS
// variables, so its colours follow the active theme automatically (task 3).
// The bar itself is a drag region; only the buttons opt out via
// `-webkit-app-region: no-drag` (see app.css).
export function TitleBar({ onOpenSettings, onToggleTerminal, terminalOpen }: Props) {
  const [maximized, setMaximized] = useState(false);

  // Subscribe to maximize state so the restore/maximize icon stays in sync.
  // Must NOT return ipcRenderer.on's result (it's an object, not a cleanup fn) —
  // returning it makes React call it as the cleanup and crash ("destroy is not a function").
  useEffect(() => {
    pi.onMaximizeChange?.(setMaximized);
  }, []);

  return (
    <div className="titlebar">
      <span className="titlebar-title">Pi Desktop</span>
      <div className="titlebar-spacer" />
      <div className="titlebar-actions">
        <button
          className={`titlebar-btn${terminalOpen ? ' active' : ''}`}
          type="button"
          title="终端"
          aria-label="终端"
          onClick={onToggleTerminal}
        >
          <IconTerminal />
        </button>
        <button className="titlebar-btn" type="button" title="设置" aria-label="设置" onClick={onOpenSettings}>
          <IconSettings />
        </button>
        <button
          className="titlebar-btn"
          type="button"
          title="最小化"
          aria-label="最小化"
          onClick={() => pi.minimizeWindow()}
        >
          <IconMinimize />
        </button>
        <button
          className="titlebar-btn"
          type="button"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => pi.toggleMaximizeWindow()}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={() => pi.closeWindow()}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}
