import { useEffect, useState } from 'react';
import { getTheme, setTheme } from '../theme';
import { pi } from '../ipc';
import { ConfirmDialog } from './ConfirmDialog';
import { IconTrash } from './icons';
import type { Theme, CloseBehavior, SessionGroup, TerminalProfile } from '../types';
import { getFontSize, bumpFontSize, onFontSizeChange, FONT_SIZE_MIN, FONT_SIZE_MAX } from '../fontSize';
import { PiConfigEditor } from './pi-settings/PiConfigEditor';
import { PiModelConfig } from './pi-settings/PiModelConfig';
import { PiMcpManager } from './pi-settings/PiMcpManager';
import { PiSkillsManager } from './pi-settings/PiSkillsManager';
import { PiExtensionsManager } from './pi-settings/PiExtensionsManager';

interface Props {
  onClose: () => void;
}

type NavKey = 'general' | 'sessions' | 'terminal' | 'pi-config' | 'pi-models' | 'pi-mcp' | 'pi-skills' | 'pi-extensions';

// Modal settings panel with a left-hand navigation:
//  - 常规：主题、关闭按钮行为（原有设置项迁移至此）。
//  - 会话管理：展示全部磁盘会话（按目录分组），支持单条删除、清空目录、批量删除。
//  - Pi 设置：集成 pi-tool 的配置管理功能（配置文件、模型、MCP、Skills、扩展）。
export function SettingsPanel({ onClose }: Props) {
  const [nav, setNav] = useState<NavKey>('general');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">设置</span>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}>
            <IconCloseHint />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置导航">
            <button
              type="button"
              className={`nav-item${nav === 'general' ? ' active' : ''}`}
              aria-current={nav === 'general'}
              onClick={() => setNav('general')}
            >
              常规
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'sessions' ? ' active' : ''}`}
              aria-current={nav === 'sessions'}
              onClick={() => setNav('sessions')}
            >
              会话管理
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'terminal' ? ' active' : ''}`}
              aria-current={nav === 'terminal'}
              onClick={() => setNav('terminal')}
            >
              终端
            </button>
            <div className="nav-separator" />
            <span className="nav-section-label">Pi 配置</span>
            <button
              type="button"
              className={`nav-item${nav === 'pi-config' ? ' active' : ''}`}
              aria-current={nav === 'pi-config'}
              onClick={() => setNav('pi-config')}
            >
              配置文件
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'pi-models' ? ' active' : ''}`}
              aria-current={nav === 'pi-models'}
              onClick={() => setNav('pi-models')}
            >
              模型配置
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'pi-mcp' ? ' active' : ''}`}
              aria-current={nav === 'pi-mcp'}
              onClick={() => setNav('pi-mcp')}
            >
              MCP 管理
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'pi-skills' ? ' active' : ''}`}
              aria-current={nav === 'pi-skills'}
              onClick={() => setNav('pi-skills')}
            >
              Skills 管理
            </button>
            <button
              type="button"
              className={`nav-item${nav === 'pi-extensions' ? ' active' : ''}`}
              aria-current={nav === 'pi-extensions'}
              onClick={() => setNav('pi-extensions')}
            >
              扩展管理
            </button>
          </nav>
          <div className="settings-content">
            {nav === 'general' ? <GeneralSettings /> :
             nav === 'sessions' ? <SessionManagement /> :
             nav === 'terminal' ? <TerminalSettings /> :
             nav === 'pi-config' ? <PiConfigEditor /> :
             nav === 'pi-models' ? <PiModelConfig /> :
             nav === 'pi-mcp' ? <PiMcpManager /> :
             nav === 'pi-skills' ? <PiSkillsManager /> :
             <PiExtensionsManager />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 常规 ────────────────────────────────────────────────────────────────────
function GeneralSettings() {
  const [theme, setLocal] = useState<Theme>(getTheme());
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('minimize-to-tray');
  // 字体大小：本地 state 镜像全局 fontSize，步进按钮 / Ctrl+滚轮都走 setFontSize 通道。
  const [fontSize, setFontSizeLocal] = useState<number>(getFontSize());

  useEffect(() => {
    pi.getConfig().then((cfg) => setCloseBehavior(cfg.closeBehavior)).catch(() => {});
  }, []);

  // 订阅全局字号变化：Ctrl+滚轮在 App 层调整时，这里同步显示（保持面板数值实时）。
  useEffect(() => {
    return onFontSizeChange(setFontSizeLocal);
  }, []);

  const choose = (t: Theme) => {
    setTheme(t);
    setLocal(t);
  };

  const chooseClose = (b: CloseBehavior) => {
    setCloseBehavior(b);
    pi.setConfig({ closeBehavior: b }).catch(() => {});
  };

  const step = (delta: number) => {
    const atMin = fontSize <= FONT_SIZE_MIN && delta < 0;
    const atMax = fontSize >= FONT_SIZE_MAX && delta > 0;
    if (atMin || atMax) return; // 已在边界，避免无谓写盘
    setFontSizeLocal(bumpFontSize(delta));
  };

  return (
    <>
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
        <span className="settings-label">关闭按钮行为</span>
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
      <div className="settings-row">
        <span className="settings-label">字体大小</span>
        <div className="font-stepper" role="group" aria-label="字体大小">
          <button
            type="button"
            className="stepper-btn"
            aria-label="减小字体"
            disabled={fontSize <= FONT_SIZE_MIN}
            onClick={() => step(-1)}
          >
            −
          </button>
          <span className="stepper-value" aria-live="polite">{fontSize}px</span>
          <button
            type="button"
            className="stepper-btn"
            aria-label="增大字体"
            disabled={fontSize >= FONT_SIZE_MAX}
            onClick={() => step(1)}
          >
            +
          </button>
        </div>
      </div>
      <p className="settings-hint">提示：也可按住 Ctrl（macOS 为 Cmd）+ 滚轮快速调整字体大小。</p>
    </>
  );
}

// ── 会话管理 ──────────────────────────────────────────────────────────────────
type PendingDelete =
  | { kind: 'session'; key: string; name: string }
  | { kind: 'directory'; cwd: string; count: number }
  | { kind: 'batch'; keys: string[]; count: number };

function SessionManagement() {
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<PendingDelete | null>(null);
  // 每个目录的折叠状态：默认收起（仅显示前 3 个会话），展开后显示全部。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const refresh = () => {
    pi.listSessions().then(setGroups).catch(() => setGroups([]));
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const enterSelect = () => { setSelectionMode(true); setSelected(new Set()); };
  const exitSelect = () => { setSelectionMode(false); setSelected(new Set()); };

  const handleDeleteConfirm = async () => {
    if (!confirm) return;
    const pending = confirm;
    setConfirm(null);
    setError(null);
    try {
      if (pending.kind === 'session') {
        await pi.deleteSession(pending.key);
      } else if (pending.kind === 'directory') {
        await pi.clearDirectory(pending.cwd);
      } else {
        await pi.deleteMany(pending.keys);
      }
      refresh();
      if (selectionMode) exitSelect();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const allKeys = groups.flatMap((g) => g.sessions.map((s) => s.key));
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allKeys));
  };

  // 每个目录默认最多展示 3 个会话，超出部分折叠；点击“展开 N 个 / 收起”切换。
  const COLLAPSE_THRESHOLD = 3;
  const toggleExpand = (cwd: string) =>
    setExpanded((m) => ({ ...m, [cwd]: !m[cwd] }));

  return (
    <div className="session-mgmt">
      <div className="session-mgmt-toolbar">
        {selectionMode ? (
          <>
            <label className="select-all">
              <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              <span>全选</span>
            </label>
            <span className="select-count">已选 {selected.size} 项</span>
            <button className="btn btn-danger" disabled={selected.size === 0} onClick={() => setConfirm({ kind: 'batch', keys: [...selected], count: selected.size })}>
              删除
            </button>
            <button className="btn" onClick={exitSelect}>取消</button>
          </>
        ) : (
          <button className="btn" onClick={enterSelect}>选择</button>
        )}
        {error && <span className="header-error">⚠ {error}</span>}
      </div>

      <div className="session-mgmt-list">
        {groups.length === 0 && <div className="empty-state">暂无会话。</div>}
        {groups.map((g) => {
          const total = g.sessions.length;
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.sessions : g.sessions.slice(0, COLLAPSE_THRESHOLD);
          const hidden = total - visible.length;
          return (
            <div key={g.cwd} className="group">
              <div className="group-title">
                <span className="group-name">
                  📁 {g.cwd} <span className="group-count">（会话数：{total}）</span>
                </span>
                <span className="group-actions">
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setConfirm({ kind: 'directory', cwd: g.cwd, count: total })}
                  >
                    清空目录
                  </button>
                </span>
              </div>
              {visible.map((s) => {
                const isSelected = selected.has(s.key);
                return (
                  <div
                    key={s.key}
                    className={`session-item${selectionMode ? ' selectable' : ''}${isSelected ? ' selected' : ''}`}
                    onClick={selectionMode ? () => toggleSelect(s.key) : undefined}
                  >
                    {selectionMode && (
                      <input
                        type="checkbox"
                        className="select-box"
                        checked={isSelected}
                        tabIndex={-1}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelect(s.key)}
                      />
                    )}
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {!selectionMode && (
                      <button className="icon-btn icon-danger session-delete" title={`删除会话 ${s.name}`} aria-label={`删除会话 ${s.name}`} onClick={() => setConfirm({ kind: 'session', key: s.key, name: s.name })}>
                        <IconTrash />
                      </button>
                    )}
                  </div>
                );
              })}
              {total > COLLAPSE_THRESHOLD && (
                <button
                  className="group-expand"
                  onClick={() => toggleExpand(g.cwd)}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'directory' ? '清空目录' : '删除会话'}
          message={
            confirm.kind === 'session'
              ? `确定删除会话「${confirm.name}」？该会话文件将被删除且不可恢复，若进程正在运行也会被终止。`
              : confirm.kind === 'directory'
                ? `确定清空目录「${confirm.cwd}」下的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
                : `确定删除选中的 ${confirm.count} 个会话？运行中的进程将被终止，文件不可恢复。`
          }
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

function TerminalSettings() {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [appWorkDir, setAppWorkDir] = useState('');
  const [scrollback, setScrollback] = useState<number>(5000);

  useEffect(() => {
    pi.getConfig()
      .then((cfg) => { setDefaultId(cfg.defaultTerminalProfile); setAppWorkDir(cfg.appWorkDir ?? ''); setScrollback(cfg.scrollback ?? 5000); })
      .catch(() => {});
    pi.listTerminalProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  // 下拉选中值：'' 表示使用探测到的第一个 / 平台默认。
  const selected = defaultId ?? '';

  const ensureCustom = (path: string, args: string[]) => {
    setProfiles((prev) => {
      const exists = prev.some((p) => p.id === 'custom');
      if (exists) return prev;
      return [
        ...prev,
        { id: 'custom', label: '自定义', path, args, platform: 'all', isCustom: true },
      ];
    });
  };

  const onSelect = (value: string) => {
    if (value === 'custom') {
      // 仅切换到自定义视图，不立即保存；具体 path/args 由“保存为默认”落盘。
      setDefaultId('custom');
      return;
    }
    setDefaultId(value);
    pi.setConfig({ defaultTerminalProfile: value }).catch(() => {});
  };

  const saveCustom = () => {
    if (!customPath.trim()) {
      setCustomError('请填写 shell 路径');
      return;
    }
    setCustomError(null);
    const args = customArgs.split(/\s+/).filter(Boolean);
    ensureCustom(customPath, args);
    setDefaultId('custom');
    pi.setConfig({
      defaultTerminalProfile: 'custom',
      terminalProfiles: { custom: { path: customPath, args } },
    }).catch(() => {});
  };

  return (
    <div className="terminal-settings">
      <div className="settings-row">
        <span className="settings-label">默认终端</span>
        <select
          className="profile-select"
          aria-label="默认终端"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          <option value="">（使用探测到的默认终端）</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">其他（自定义路径）</option>
        </select>
      </div>

      {selected === 'custom' && (
        <div className="custom-terminal">
          <div className="settings-row">
            <span className="settings-label">shell 路径</span>
            <input
              type="text"
              className="custom-path-input"
              aria-label="shell 路径"
              placeholder={'C:\\Program Files\\Git\\bin\\bash.exe'}
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">启动参数</span>
            <input
              type="text"
              className="custom-args-input"
              aria-label="启动参数"
              placeholder="--login -i"
              value={customArgs}
              onChange={(e) => setCustomArgs(e.target.value)}
            />
          </div>
          {customError && <p className="settings-hint error">{customError}</p>}
          <button type="button" className="btn" onClick={saveCustom}>保存为默认</button>
        </div>
      )}
      <p className="settings-hint">提示：新建集成终端时会使用此处选择的默认终端。</p>
      <div className="settings-row">
        <span className="settings-label">滚动缓冲区</span>
        <input
          type="number"
          className="app-work-dir-input"
          style={{ width: 100, textAlign: 'right' }}
          aria-label="滚动缓冲区行数"
          min={1000}
          max={100000}
          step={1000}
          value={scrollback}
          onChange={(e) => setScrollback(Number(e.target.value))}
          onBlur={() => {
            const clamped = Math.min(100000, Math.max(1000, Math.round(scrollback)));
            setScrollback(clamped);
            pi.setConfig({ scrollback: clamped }).catch(() => {});
          }}
        />
        <span className="settings-unit">行</span>
      </div>
      <p className="settings-hint">范围 1000–100000，修改后只影响之后新建的终端。</p>
      <div className="settings-row">
        <span className="settings-label">应用工作目录</span>
        <div className="app-work-dir">
          <input
            type="text"
            className="app-work-dir-input"
            aria-label="应用工作目录"
            placeholder={'~/piDesktop'}
            value={appWorkDir}
            onChange={(e) => setAppWorkDir(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await pi.pickDirectory();
              if (dir) setAppWorkDir(dir);
            }}
          >
            浏览…
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => pi.setConfig({ appWorkDir }).catch(() => {})}
          >
            保存
          </button>
        </div>
      </div>
      <p className="settings-hint">用于收容与具体项目无关、与 pi-agent 闲聊或临时的集成终端。修改后只影响之后新建的终端。</p>
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
