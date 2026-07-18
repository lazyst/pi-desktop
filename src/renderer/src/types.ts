export type SessionStatus = 'running' | 'dead';
export interface SessionInfo {
  key: string;
  cwd: string;
  name: string;
  status: SessionStatus;
}
export interface SessionGroup {
  cwd: string;
  sessions: Array<{ key: string; name: string; time: string }>;
}
export interface OpenRequest { key?: string; cwd?: string; name?: string; }

export type Theme = 'dark' | 'light';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  maximized: boolean;
  bounds: Bounds;
}

export type CloseBehavior = 'close' | 'minimize-to-tray';

export interface AppConfig {
  theme: Theme;
  pinnedDirs: string[];
  // 用户在侧边栏“添加目录”显式注册、需要常驻展示的目录列表（不含子路径匹配）。
  // 左侧栏仅展示这些目录下的会话；其余磁盘会话只在设置面板“会话管理”中可见。
  addedDirs: string[];
  // 文件管理器面板（Sidebar 与终端区之间的独立栏）宽度，持久化、可拖拽右缘调整。
  filePanelWidth: number;
  window: WindowState;
  sidebarWidth: number;
  closeBehavior: CloseBehavior;
  // 全局字体大小（UI + 终端统一基准，单位 px）。持久化于主进程 config，
  // 与主题同构：单一根属性驱动整个 UI 与终端字号。范围 8–28，默认 13。
  fontSize: number;
}
