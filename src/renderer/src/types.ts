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
  // 右栏（文件树 / Git）宽度，持久化、可拖拽。
  rightPanelWidth: number;
  window: WindowState;
  sidebarWidth: number;
  closeBehavior: CloseBehavior;
  // 全局字体大小（UI + 终端统一基准，单位 px）。持久化于主进程 config，
  // 与主题同构：单一根属性驱动整个 UI 与终端字号。范围 8–28，默认 13。
  fontSize: number;
  // 集成终端：默认终端 profile 的 id；null 表示用探测到的第一个 / 平台默认。
  defaultTerminalProfile: string | null;
  // 用户自定义的终端 profile 覆盖（key 为 profile id，如 'custom'），覆盖探测到的 profile。
  terminalProfiles: Record<string, { path: string; args: string[] }>;
  // 终端 scrollback 行数（xterm scrollback 选项）。默认 5000，范围 1000–100000。
  scrollback: number;
  // 应用工作目录分组的根目录：用于收容与具体项目无关、与 pi-agent 闲聊或临时用的集成终端。
  // 默认 ~/piDesktop（见 config.defaultConfig）；可在「设置 → 终端」中改为其他目录。
  // 该目录下的集成终端统一归入侧边栏的「应用工作目录」分组，不挂靠任何项目 cwd。
  appWorkDir: string;
  // 侧边栏中已折叠的目录分组 cwd 列表，用于跨会话持久化折叠状态。
  collapsedGroups: string[];
}

export type Platform = 'windows' | 'macos' | 'linux';

// 一个可用的终端 profile（shell 描述）。id 稳定（如 'pwsh' / 'cmd' / 'git-bash' / 'default' / 'custom'）。
export interface TerminalProfile {
  id: string;
  label: string;       // 展示名，如 'PowerShell' / 'Command Prompt' / 'Git Bash'
  path: string;        // shell 可执行文件绝对路径
  args: string[];      // 启动参数，如 git-bash 用 ['--login','-i']
  platform: Platform | 'all';
  isCustom?: boolean;  // 用户自定义的「其他」路径
}

// 一个已创建的集成终端实例信息。
export interface IntegratedTerminalInfo {
  id: string;          // 形如 'term-<uuid>'
  profileId: string;
  cwd: string;
  title: string;       // 展示标题（profile label 或 cwd 末段）
}
