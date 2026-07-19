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
  // 集成终端抽屉的高度（像素）。
  terminalDrawerHeight: number;
  // 用户自定义的终端 profile 覆盖（key 为 profile id，如 'custom'），覆盖探测到的 profile。
  terminalProfiles: Record<string, { path: string; args: string[] }>;
  // 应用工作目录分组的根目录：用于收容与具体项目无关、与 pi-agent 闲聊或临时用的集成终端。
  // 默认 ~/piDesktop（见 config.defaultConfig）；可在「设置 → 终端」中改为其他目录。
  // 该目录下的集成终端统一归入侧边栏的「应用工作目录」分组，不挂靠任何项目 cwd。
  appWorkDir: string;
}

export type Platform = 'windows' | 'macos' | 'linux';

export type TabKind = 'session' | 'preview' | 'diff';

// 通用 Tab 模型：中间区统一 Tab 条承载三种 tab 类型（session 终端会话 / preview 文件预览 / diff git diff）。
// keep-alive：所有 tab 内容都渲染，非 active 的 display:none 隐藏（对齐现有 TerminalPane / IntegratedTerminalPane）。
export interface BaseTab {
  id: string;        // 唯一 id（session 用 sessionKey；preview 用 `preview:${root}//${path}`；diff 用 `diff:${cwd}//${commitHash ?? 'work'}`）
  kind: TabKind;
  title: string;     // Tab 条显示的标题
}

export interface SessionTab extends BaseTab {
  kind: 'session';
  key: string;       // sessionKey（.jsonl 绝对路径 / live-<uuid>）
  cwd: string;
  name: string;
}

export interface PreviewTab extends BaseTab {
  kind: 'preview';
  root: string;      // 仓库根目录
  path: string;      // 相对 root 的文件路径
}

export interface DiffTab extends BaseTab {
  kind: 'diff';
  cwd: string;
  commitHash: string | null;  // null = 工作区 diff
}

export type AnyTab = SessionTab | PreviewTab | DiffTab;

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
