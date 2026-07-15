import { useEffect, useState } from 'react';
import { getTheme, setTheme } from '../theme';
import { pi } from '../ipc';
import type { Theme, CloseBehavior } from '../types';

interface Props {
  onClose: () => void;
}

// Modal settings panel. Today it only switches the theme (task 4), but it is
// intentionally a general panel so more settings can be added later (see the
// "更多设置即将到来" hint).
export function SettingsPanel({ onClose }: Props) {
  const [theme, setLocal] = useState<Theme>(getTheme());
  // 关闭按钮行为：默认最小化到托盘，可在「直接关闭」间切换（见 docs/adr/0001）。
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-to-tray');

  useEffect(() => {
    pi.getConfig().then((cfg) => setCloseBehavior(cfg.closeBehavior)).catch(() => {});
  }, []);

  const choose = (t: Theme) => {
    setTheme(t);
    setLocal(t);
  };

  const chooseClose = (b: CloseBehavior) => {
    setCloseBehavior(b);
    // config 经异步 IPC 持久化；用 .catch 吸收拒绝（try/catch 抓不到 Promise 拒绝）。
    pi.setConfig({ closeBehavior: b }).catch(() => {});
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
            <IconCloseHint />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">主题</span>
          <div className="segmented" role="radiogroup" aria-label="主题">
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'dark'}
              className={`seg${theme === 'dark' ? ' active' : ''}`}
              onClick={() => choose('dark')}
            >
              暗色
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={theme === 'light'}
              className={`seg${theme === 'light' ? ' active' : ''}`}
              onClick={() => choose('light')}
            >
              亮色
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">关闭按钮</span>
          <div className="segmented" role="radiogroup" aria-label="关闭按钮行为">
            <button
              type="button"
              role="radio"
              aria-checked={closeBehavior === 'close'}
              className={`seg${closeBehavior === 'close' ? ' active' : ''}`}
              onClick={() => chooseClose('close')}
            >
              直接关闭
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={closeBehavior === 'minimize-to-tray'}
              className={`seg${closeBehavior === 'minimize-to-tray' ? ' active' : ''}`}
              onClick={() => chooseClose('minimize-to-tray')}
            >
              最小化到托盘
            </button>
          </div>
        </div>
        <p className="settings-hint">更多设置即将到来。</p>
      </div>
    </div>
  );
}

// Small inline ✕ so the panel doesn't depend on the window-control icon set.
function IconCloseHint() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
