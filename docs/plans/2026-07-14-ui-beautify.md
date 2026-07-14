# Pi Desktop UI 美化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改动架构 / IPC / 会话模型的前提下，用设计令牌系统（CSS 变量 + 语义化 class）替换渲染进程散落的 inline style，并统一等宽字体、引入冷蓝 `#7c9cff` 主色与"激活轨"签名元素。

**Architecture:** 纯视觉层重写。新增 `tokens.css`（`:root` 变量 + 基础/焦点/reduced-motion/滚动条）与 `app.css`（语义化组件 class）；`main.tsx` 引入两者与字体包；`App.tsx` / `Sidebar.tsx` / `TerminalPane.tsx` 去掉 inline style、改用 class + token。不新增功能、不改 IPC 契约。使用 `@fontsource/jetbrains-mono` 本地打包 woff2（满足 spec "随应用本地打包" 的要求，无需手管字体文件）。

**Tech Stack:** React 18 + TypeScript, electron-vite (Vite), xterm.js, `@fontsource/jetbrains-mono`, Vitest + Playwright（回归）。

## Global Constraints

- 视觉方向：打磨现有深色开发者工具风（不换风格）。
- 字体：终端与界面统一等宽（`JetBrains Mono` 栈，回退 ui-monospace/Menlo/Consolas 等）。
- 主色：`--accent: #7c9cff`（冷蓝），仅用于激活态、焦点环、高亮；整体仍偏中性。
- 实现：设计令牌系统（CSS 变量集中管理），替换散落 inline style；禁止硬编码色值/尺寸。
- **必须保留的既有选择器**（单测 + e2e 依赖，改名会破坏测试）：`.session-item`（含 `data-key`）、`.dot`、`.dot.running`、`.terminate`、`.group`、`.modal-overlay`、`.modal-input`、`.modal-ok`、`.modal-cancel`、`.terminal-host`、`.terminal-host.active`；侧栏标题文案 `会话`；按钮文案 `+ 会话` / `+ 目录`。
- 质量底线：键盘焦点可见（`:focus-visible` 冷蓝焦点环）、尊重 `prefers-reduced-motion`、响应式（窄屏侧栏可用）、功能零回归（现有 vitest + playwright 通过）。
- xterm 按字符格渲染，连字在终端内不合成（仅 UI 文字体现）；终端 `fontFamily` 用与 `--font-mono` 同栈的 JS 常量（xterm 不读 CSS 变量）。

---

## File Structure

- `src/renderer/src/styles/tokens.css` —— **Create**。`:root` 变量 + `body` 基础样式 + `:focus-visible` 焦点环 + `prefers-reduced-motion` + 细滚动条。无 `@font-face`（由 `@fontsource` 提供）。
- `src/renderer/src/styles/app.css` —— **Create**。全部组件语义化 class（`.app-shell` `.sidebar` `.session-item` `.dot` `.terminate` `.header` `.modal-*` `.terminal-host` 等），**保留上述既有选择器名称并新增 `.active`**。
- `src/renderer/src/main.tsx` —— **Modify**。在最顶部按顺序引入字体包三档字重 + `tokens.css` + `app.css`。
- `src/renderer/src/components/Sidebar.tsx` —— **Modify**。去掉 inline style → class；新增可选 `activeKey` prop；激活项加 `.active`（激活轨 + 淡染）；会话项可键盘聚焦（`tabIndex` + Enter/Space 打开）+ `aria-label`。
- `src/renderer/src/App.tsx` —— **Modify**。去掉 inline style 与组件内 `<style>`；`main`/header/terminal-area 改用 class；向 `Sidebar` 传 `activeKey`；错误/状态改用 class。
- `src/renderer/src/components/TerminalPane.tsx` —— **Modify**。`fontFamily` 改为 `FONT_MONO` 常量；宿主 `div` 用 `.terminal-host` class（样式在 app.css）。
- `package.json` —— **Modify**（由 `pnpm add` 自动）。新增 `@fontsource/jetbrains-mono` 依赖。
- `src/renderer/src/__tests__/Sidebar.test.tsx` —— **Modify**。新增一条断言 `.active` class 的测试（Task 4 的 TDD 红→绿）。

---

## Task 1: 创建 tokens.css（设计令牌）

**Files:**
- Create: `src/renderer/src/styles/tokens.css`

**Interfaces:** 产出 CSS 自定义属性（`--bg-*`、`--border`、`--text*`、`--accent`、`--success`、`--danger`、`--focus-ring`、`--font-mono`、`--fs-*`、`--fw-*`、`--lh-*`、`--ls-label`、`--sp-*`、`--r-*`、`--shadow-modal`、`--transition`），后续所有组件 class 与组件均消费这些变量。

- [ ] **Step 1: 创建 `src/renderer/src/styles/tokens.css`**

```css
:root {
  /* Backgrounds */
  --bg-app: #0d1117;
  --bg-panel: #161b22;
  --bg-hover: #1c2230;
  --bg-active: rgba(124, 156, 255, 0.10);
  --bg-elevated: #1b2230;

  /* Borders */
  --border: #283040;
  --border-strong: #36405a;

  /* Text */
  --text: #c9d1d9;
  --text-muted: #8b949e;
  --text-faint: #6e7681;

  /* Accent + semantic */
  --accent: #7c9cff;
  --accent-hover: #93acff;
  --success: #3fb950;
  --danger: #f85149;
  --danger-hover: #ff6b62;
  --focus-ring: 0 0 0 2px rgba(124, 156, 255, 0.55);

  /* Type */
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;
  --fs-lg: 14px;
  --fs-xl: 16px;
  --fw-regular: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --lh-tight: 1.3;
  --lh-base: 1.45;
  --ls-label: 0.02em;

  /* Space / radius / shadow / motion */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --shadow-modal: 0 10px 40px rgba(0, 0, 0, 0.55);
  --transition: 140ms ease;
}

* { box-sizing: border-box; }

html, body, #root { height: 100%; margin: 0; }

body {
  background: var(--bg-app);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  line-height: var(--lh-base);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* Slim themed scrollbars (replaces App.tsx inline <style>) */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
* { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

/* Global keyboard focus ring (signature: cool-blue) */
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--r-sm);
}

/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 2: 运行类型检查确认无报错**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 无输出、退出码 0（纯新增 CSS，不影响 TS）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/styles/tokens.css
git commit -m "style: add design tokens (colors, type, space, motion) in tokens.css"
```

---

## Task 2: 创建 app.css（组件语义化 class）

**Files:**
- Create: `src/renderer/src/styles/app.css`

**Interfaces:** 消费 `tokens.css` 的变量；产出 `.app-shell` `.main` `.sidebar` `.sidebar-header` `.sidebar-title` `.sidebar-actions` `.btn` `.btn-primary` `.group` `.group-title` `.session-list` `.session-item` `.session-item.active` `.dot` `.dot.running` `.session-name` `.name` `.time` `.terminate` `.group-expand` `.header` `.header-title` `.header-status` `.header-status.running` `.header-error` `.terminal-area` `.empty-state` `.terminal-host` `.terminal-host.active` `.modal-overlay` `.modal` `.modal-label` `.modal-input` `.modal-actions` `.modal-cancel` `.modal-ok`。**必须保留** `.session-item` `.dot` `.dot.running` `.terminate` `.group` `.modal-overlay` `.modal-input` `.modal-ok` `.modal-cancel` `.terminal-host` `.terminal-host.active`（既有测试选择器）。

- [ ] **Step 1: 创建 `src/renderer/src/styles/app.css`**

```css
/* App shell */
.app-shell {
  display: flex;
  height: 100vh;
  background: var(--bg-app);
  color: var(--text);
  font-family: var(--font-mono);
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* Sidebar */
.sidebar {
  width: 280px;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  color: var(--text);
  position: relative;
}
.sidebar-header {
  padding: var(--sp-3);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar-title { font-weight: var(--fw-semibold); font-size: var(--fs-lg); }
.sidebar-actions { display: flex; gap: var(--sp-2); }

/* Buttons (sidebar + modal) */
.btn {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
  transition: background-color var(--transition), border-color var(--transition), color var(--transition);
}
.btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
.btn-primary { color: var(--accent); }
.btn-primary:hover { color: var(--accent-hover); background: var(--bg-active); border-color: var(--accent); }

/* Group */
.group { margin-bottom: var(--sp-1); }
.group-title {
  padding: var(--sp-2) var(--sp-3);
  color: var(--text-faint);
  font-size: var(--fs-xs);
  word-break: break-all;
  letter-spacing: var(--ls-label);
}

/* Session list */
.session-list { overflow-y: auto; flex: 1; padding: var(--sp-2) 0; }

/* Session item (signature: active rail) */
.session-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background-color var(--transition), border-color var(--transition);
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent);
}
.session-item:focus-visible { box-shadow: var(--focus-ring); }

/* Status dot */
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #444; flex: none;
  transition: background-color var(--transition), box-shadow var(--transition);
}
.dot.running {
  background: var(--success);
  box-shadow: 0 0 6px rgba(63, 185, 80, 0.6);
}

/* Session name block */
.session-name { flex: 1; min-width: 0; }
.session-name .name {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-name .time {
  font-size: var(--fs-xs);
  color: var(--text-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Terminate (shown on hover/focus) */
.terminate {
  display: none;
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  font-size: var(--fs-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
  font-family: var(--font-mono);
  transition: color var(--transition);
}
.terminate:hover { color: var(--danger-hover); }
.session-item:hover .terminate,
.session-item:focus-within .terminate { display: inline-flex; }

/* Group expand toggle */
.group-expand {
  padding: var(--sp-1) var(--sp-3) var(--sp-1) var(--sp-4);
  font-size: var(--fs-xs);
  color: var(--accent);
  cursor: pointer;
  letter-spacing: var(--ls-label);
}
.group-expand:hover { color: var(--accent-hover); }

/* Header (accent hairline) */
.header {
  height: 34px;
  border-bottom: 1px solid var(--accent);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-3);
  background: var(--bg-panel);
}
.header-title { font-weight: var(--fw-semibold); font-size: var(--fs-lg); }
.header-status { font-size: var(--fs-xs); color: var(--text-muted); }
.header-status.running { color: var(--success); }
.header-error { margin-left: auto; font-size: var(--fs-xs); color: var(--danger); }

/* Terminal area + host */
.terminal-area { flex: 1; position: relative; }
.terminal-host {
  position: absolute;
  inset: 0;
  padding: var(--sp-2);
  background: var(--bg-app);
  display: none;
}
.terminal-host.active { display: block; }

.empty-state { padding: var(--sp-4); color: var(--text-muted); }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  min-width: 320px;
  box-shadow: var(--shadow-modal);
}
.modal-label { margin-bottom: var(--sp-2); color: var(--text); }
.modal-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--sp-2);
  background: var(--bg-app);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: var(--r-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-md);
  transition: border-color var(--transition);
}
.modal-input:focus { outline: none; border-color: var(--border-strong); box-shadow: var(--focus-ring); }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-3); }
```

- [ ] **Step 2: 运行类型检查确认无报错**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 退出码 0（纯 CSS，不影响 TS）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/styles/app.css
git commit -m "style: add component classes in app.css (preserves test selectors)"
```

---

## Task 3: 在 main.tsx 引入字体包与两个样式表

**Files:**
- Modify: `src/renderer/src/main.tsx`
- Modify (自动): `package.json`（`pnpm add` 写入 `@fontsource/jetbrains-mono`）

**Interfaces:** 消费 `tokens.css` / `app.css`（Task 1/2）与 `@fontsource/jetbrains-mono`（Task 7 安装）。本任务先把样式引入接好；字体包在 Task 7 安装后其 `@font-face` 才生效。

- [ ] **Step 1: 安装字体包（本地打包 woff2）**

Run: `pnpm add @fontsource/jetbrains-mono`
Expected: 写入 `package.json` 的 `dependencies`；`node_modules/@fontsource/jetbrains-mono` 存在。

- [ ] **Step 2: 修改 `src/renderer/src/main.tsx`，在最顶部按顺序引入**

```tsx
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles/tokens.css';
import './styles/app.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 3: 运行类型检查确认无报错**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/main.tsx package.json pnpm-lock.yaml
git commit -m "style: wire font package + tokens/app styles in renderer entry"
```

---

## Task 4: 重构 Sidebar.tsx（令牌化 + activeKey + 可访问性）

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Modify (测试): `src/renderer/src/__tests__/Sidebar.test.tsx`

**Interfaces:** 消费 `app.css` 的 `.sidebar` `.sidebar-header` `.sidebar-title` `.sidebar-actions` `.btn` `.group` `.group-title` `.session-list` `.session-item` `.session-item.active` `.dot` `.dot.running` `.session-name` `.name` `.time` `.terminate` `.group-expand` `.modal-overlay` `.modal` `.modal-label` `.modal-input` `.modal-actions` `.modal-cancel` `.modal-ok`。**产出**可选 prop `activeKey?: string | null` 与 `.active` class（供 App 传入当前会话）。保留既有选择器 `.session-item`/`.dot`/`.dot.running`/`.terminate`/`.group`/`.modal-*` 与 `data-key`。

- [ ] **Step 1: 在 `Sidebar.test.tsx` 末尾新增一条"激活项带 .active"的失败测试（TDD 红）**

在文件顶部 `import type { SessionStatus }` 之后无需改动；在 `describe('Sidebar', ...)` 内、最后一个 `it` 之后追加：

```tsx
it('marks the active session item with .active class', () => {
  const onOpen = vi.fn(), onTerminate = vi.fn();
  (window as any).pi = {
    listSessions: vi.fn(), openSession: vi.fn(), terminate: vi.fn(),
    input: vi.fn(), resize: vi.fn(), onData: vi.fn(), onStatus: vi.fn(), onExit: vi.fn(),
  };
  render(
    <Sidebar
      sessions={sessions}
      statusMap={{ k1: 'running' }}
      activeKey="k1"
      onOpen={onOpen}
      onTerminate={onTerminate}
    />
  );
  const active = screen.getByText('e2e-session').closest('.session-item')!;
  expect(active).toHaveClass('active');
  const other = screen.getByText('other-session').closest('.session-item')!;
  expect(other).not.toHaveClass('active');
});
```

- [ ] **Step 2: 运行测试确认失败（红）**

Run: `pnpm test -- src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: FAIL —— 类型错误 `Property 'activeKey' does not exist on type ...`（Sidebar 尚未接受该 prop）。

- [ ] **Step 3: 用令牌化 class 重写 `src/renderer/src/components/Sidebar.tsx`**

```tsx
import { useState } from 'react';
import type { SessionStatus } from '../types';

interface Props {
  sessions: Array<{ key: string; cwd: string; name: string; time?: string }>;
  statusMap: Record<string, SessionStatus>;
  activeKey: string | null;
  onOpen: (req: { key?: string; cwd?: string; name?: string }) => void;
  onTerminate: (key: string) => void;
}

interface PromptState {
  label: string;
  defaultValue: string;
  onOk: (value: string) => void;
}

export function Sidebar({ sessions, statusMap, activeKey, onOpen, onTerminate }: Props) {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const openPrompt = (cfg: PromptState) => {
    setInputValue(cfg.defaultValue);
    setPrompt(cfg);
  };

  const groups: Array<{ cwd: string; items: Props['sessions'] }> = [];
  const cwdIndex = new Map<string, number>();
  for (const s of sessions) {
    let i = cwdIndex.get(s.cwd);
    if (i === undefined) {
      i = groups.length;
      cwdIndex.set(s.cwd, i);
      groups.push({ cwd: s.cwd, items: [] });
    }
    groups[i].items.push(s);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">会话</span>
        <div className="sidebar-actions">
          <button className="btn" onClick={() => openPrompt({
            label: '选择目录（真实文件夹路径）：',
            defaultValue: 'C:\\Users\\hcz\\project',
            onOk: (dir) => { if (dir) onOpen({ cwd: dir }); },
          })}>+ 目录</button>
          <button className="btn" onClick={() => openPrompt({
            label: '新会话名称：',
            defaultValue: 'new-session',
            onOk: (name) => { if (name) onOpen({ name }); },
          })}>+ 会话</button>
        </div>
      </div>
      <div className="session-list">
        {groups.map((g) => {
          const isOpen = !!expanded[g.cwd];
          const visible = isOpen ? g.items : g.items.slice(0, 5);
          const hidden = g.items.length - visible.length;
          return (
            <div key={g.cwd} className="group">
              <div className="group-title">📁 {g.cwd}</div>
              {visible.map((s) => {
                const running = statusMap[s.key] === 'running';
                const isActive = s.key === activeKey;
                return (
                  <div
                    key={s.key}
                    data-key={s.key}
                    className={`session-item${isActive ? ' active' : ''}`}
                    tabIndex={0}
                    aria-label={`打开会话 ${s.name}`}
                    onClick={() => onOpen({ key: s.key })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen({ key: s.key });
                      }
                    }}
                  >
                    <span className={`dot ${running ? 'running' : ''}`} />
                    <span className="session-name">
                      <div className="name">{s.name}</div>
                      {s.time && <div className="time">{s.time}</div>}
                    </span>
                    {running && (
                      <button className="terminate" title="终止进程" onClick={(e) => { e.stopPropagation(); onTerminate(s.key); }}>终止进程</button>
                    )}
                  </div>
                );
              })}
              {g.items.length > 5 && (
                <div
                  className="group-expand"
                  onClick={() => setExpanded((m) => ({ ...m, [g.cwd]: !isOpen }))}
                >
                  {isOpen ? '收起' : `展开 ${hidden} 个更多`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {prompt && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-label">{prompt.label}</div>
            <input
              className="modal-input"
              value={inputValue}
              autoFocus
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPrompt(null); prompt.onOk(inputValue); } }}
            />
            <div className="modal-actions">
              <button className="btn modal-cancel" onClick={() => setPrompt(null)}>取消</button>
              <button className="btn btn-primary modal-ok" onClick={() => { setPrompt(null); prompt.onOk(inputValue); }}>确定</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: 运行 Sidebar 测试确认通过（绿）**

Run: `pnpm test -- src/renderer/src/__tests__/Sidebar.test.tsx`
Expected: PASS（含新增 `.active` 断言；既有 cwd/绿点/点击/hover 终止用例仍通过）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx src/renderer/src/__tests__/Sidebar.test.tsx
git commit -m "style: tokenize Sidebar, add active rail + keyboard focus on session items"
```

---

## Task 5: 重构 App.tsx（令牌化 + 传递 activeKey + 移除内联 <style>）

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:** 消费 `app.css` 的 `.app-shell` `.main` `.header` `.header-title` `.header-status` `.header-status.running` `.header-error` `.terminal-area` `.empty-state`。向 `Sidebar` 传入 `activeKey`（来自 Task 4 新增的可选 prop）。

- [ ] **Step 1: 用令牌化 class 重写 `src/renderer/src/App.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { pi } from './ipc';
import type { SessionInfo, SessionStatus } from './types';

interface OpenSession extends SessionInfo { key: string; cwd: string; name: string; status: SessionStatus; }

interface DiskSession { key: string; cwd: string; name: string; time?: string; }

export default function App() {
  const [open, setOpen] = useState<OpenSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, SessionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskSession[]>([]);

  useEffect(() => {
    pi.onStatus((key, status) => setStatusMap((m) => ({ ...m, [key]: status })));
    pi.onExit((key) => {
      setStatusMap((m) => ({ ...m, [key]: 'dead' }));
      setOpen((list) => list.filter((s) => s.key !== key));
    });
    pi.listSessions()
      .then((groups) =>
        setDisk(
          groups.flatMap((g) =>
            g.sessions.map((s) => ({ key: s.key, cwd: g.cwd, name: s.name, time: s.time })),
          ),
        ),
      )
      .catch(() => setDisk([]));
  }, []);

  const sessions: DiskSession[] = (() => {
    const diskKeys = new Set(disk.map((s) => s.key));
    const liveOnly = open
      .filter((s) => !diskKeys.has(s.key))
      .map<DiskSession>((s) => ({ key: s.key, cwd: s.cwd, name: s.name }));
    return [...disk, ...liveOnly];
  })();

  const handleOpen = async (req: { key?: string; cwd?: string; name?: string }) => {
    setError(null);
    try {
      const info = await pi.openSession(req.key ? { key: req.key } : { cwd: req.cwd, name: req.name });
      setOpen((list) => list.some((s) => s.key === info.key) ? list : [...list, info as OpenSession]);
      setActiveKey(info.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const handleTerminate = (key: string) => { pi.terminate(key); };

  const active = open.find((s) => s.key === activeKey);
  const activeStatus = activeKey ? statusMap[activeKey] : undefined;

  return (
    <div className="app-shell">
      <Sidebar sessions={sessions} statusMap={statusMap} activeKey={activeKey} onOpen={handleOpen} onTerminate={handleTerminate} />
      <main className="main">
        <div className="header">
          <span className="header-title">{active ? `${active.name} · ${active.cwd}` : '—'}</span>
          <span className={`header-status ${activeStatus === 'running' ? 'running' : ''}`}>
            {activeStatus === 'running' ? '● 运行中' : '空闲'}
          </span>
          {error && <span className="header-error">⚠ {error}</span>}
        </div>
        <div className="terminal-area">
          {open.map((s) => (
            <TerminalPane key={s.key} sessionKey={s.key} active={s.key === activeKey} />
          ))}
          {!active && <div className="empty-state">从左侧选择一个会话，或新建会话。</div>}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: 运行全部单元测试确认无回归**

Run: `pnpm test`
Expected: PASS（Sidebar / TerminalPane 单测通过；无残留 inline style 导致的渲染差异）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "style: tokenize App shell/header, pass activeKey to Sidebar, drop inline <style>"
```

---

## Task 6: 重构 TerminalPane.tsx（FONT_MONO 常量 + .terminal-host class）

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`

**Interfaces:** 消费 `app.css` 的 `.terminal-host` / `.terminal-host.active`。`FONT_MONO` 常量须与 `tokens.css` 中 `--font-mono` 同栈（xterm 不读 CSS 变量）。

- [ ] **Step 1: 用 FONT_MONO 常量 + class 重写 `src/renderer/src/components/TerminalPane.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { pi } from '../ipc';
import '@xterm/xterm/css/xterm.css';

// Mirrors --font-mono in tokens.css. xterm reads a literal font-family string,
// not a CSS variable, so we repeat the stack here (kept in sync with tokens.css).
const FONT_MONO = "'JetBrains Mono','Fira Code','Cascadia Code',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

interface Props { sessionKey: string; active: boolean; }

export function TerminalPane({ sessionKey, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const openedRef = useRef(false);

  useEffect(() => {
    // xterm lineHeight is a multiplier (default 1.0); 1.2 is a comfortable
    // spacing that honors the spec's intent without over-loose rows.
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: FONT_MONO, fontSize: 13, lineHeight: 1.2 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; fitRef.current = fit;

    const onData = (key: string, data: string) => { if (key === sessionKey) term.write(data); };
    pi.onData(onData);

    term.onData((d) => pi.input(sessionKey, d));

    return () => {
      term.dispose();
      openedRef.current = false;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!active || !hostRef.current || !termRef.current || !fitRef.current) return;
    if (!openedRef.current) {
      termRef.current.open(hostRef.current);
      openedRef.current = true;
    }
    try { fitRef.current.fit(); } catch {}
    const { cols, rows } = termRef.current;
    pi.resize(sessionKey, cols, rows);
  }, [active, sessionKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (!active || !openedRef.current || !termRef.current || !fitRef.current) return;
      try { fitRef.current.fit(); } catch {}
      const { cols, rows } = termRef.current;
      pi.resize(sessionKey, cols, rows);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [active, sessionKey]);

  return <div ref={hostRef} data-session={sessionKey} className={active ? 'terminal-host active' : 'terminal-host'} />;
}
```

- [ ] **Step 2: 运行 TerminalPane 单测确认无回归**

Run: `pnpm test -- src/renderer/src/__tests__/TerminalPane.test.tsx`
Expected: PASS（`.terminal-host.active` class 仍存在，`onData` 注册行为不变）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx
git commit -m "style: tokenize TerminalPane font + host class"
```

---

## Task 7: 字体包接入校验（@fontsource 已装，确认本地打包生效）

**Files:**
- 无新文件（Task 3 已 `pnpm add` 并引入 400/500/600.css）。

**Interfaces:** 校验 `JetBrains Mono` 通过 `@fontsource/jetbrains-mono` 本地打包（离线可用），`--font-mono` 栈回退到其他系统等宽。

- [ ] **Step 1: 确认字体包已安装且字重文件存在**

Run: `ls node_modules/@fontsource/jetbrains-mono/400.css node_modules/@fontsource/jetbrains-mono/500.css node_modules/@fontsource/jetbrains-mono/600.css`
Expected: 三个文件均存在（否则回到 Task 3 Step 1 重新 `pnpm add`）。

- [ ] **Step 2: 类型检查**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: 退出码 0。

- [ ] **Step 3: Commit（若 Task 3 已提交可跳过；仅当本任务有补充改动时提交）**

```bash
git add -A && git commit -m "style: verify local JetBrains Mono packaging" || echo "nothing to commit"
```

---

## Task 8: 回归与视觉验收

**Files:** 无改动，纯验收。

**Interfaces:** 汇总 Task 1–7 的全部产出：令牌系统、组件 class、字体、激活轨、焦点环、reduced-motion。验收依据 spec §7（质量底线）。

- [ ] **Step 1: 运行全部单元测试**

Run: `pnpm test`
Expected: PASS（Sidebar / TerminalPane 全部用例，含 `.active`、`.dot.running`、`.terminate`、`.modal-*` 等选择器均保留）。

- [ ] **Step 2: 构建并运行 E2E（验证既有选择器在真实 Electron 中仍工作）**

Run: `pnpm build && pnpm test:e2e`
Expected: E2E 全绿 —— 特别是 `list → open → continuity → hover terminate → close kills` 与 `clicking a disk session` 两条用例依赖 `.session-item[data-key]`、`.dot.running`、`.terminate`、`.modal-input`、`.modal-ok`、`.terminal-host.active`、按钮文案 `+ 会话` / `+ 目录`、侧栏标题 `会话`，全部须通过。

- [ ] **Step 3: 手动视觉验收（启动 dev 或构建产物）**

Run: `pnpm dev`（或 `pnpm build && pnpm start`）
逐项核对：
  1. 侧栏/标题栏/终端底色为 `#0d1117`/`#161b22` 收敛深色，文字 `#c9d1d9`。
  2. 终端与界面统一等宽字体（JetBrains Mono；缺失时回退系统等宽）。
  3. 当前会话在侧栏显示 **2px 冷蓝激活轨 + 淡染底色**；标题栏底部冷蓝细线。
  4. Tab 焦点走到按钮 / 输入框 / 会话项时出现**冷蓝焦点环**；Enter/Space 可打开会话项。
  5. 系统开启"减少动效"后过渡/发光关闭，功能不受影响。
  6. 窄屏（窗口 < 640px）侧栏仍可用、终端正确 fit。

- [ ] **Step 4: 全部通过后收尾提交（若有未提交改动）**

```bash
git add -A && git status
git commit -m "style: finalize UI beautify (tokens, unified mono, cool-blue accent)" || echo "nothing to commit"
```
