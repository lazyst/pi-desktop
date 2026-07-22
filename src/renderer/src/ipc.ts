import type { OpenRequest, SessionGroup, SessionInfo, SessionStatus, AppConfig, Bounds, TerminalProfile, IntegratedTerminalInfo } from './types';

export interface PiApi {
  listSessions(): Promise<SessionGroup[]>;
  openSession(req: OpenRequest): Promise<SessionInfo>;
  terminate(key: string): Promise<void>;
  deleteSession(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  clearDirectory(cwd: string): Promise<void>;
  input(key: string, data: string): void;
  resize(key: string, cols: number, rows: number): void;
  debug(): Promise<{ count: number; pids: number[] }>;
  pickDirectory(): Promise<string | null>;
  // 图片粘贴落盘：渲染端把剪贴板里的图片读成 base64 传来，主进程写临时文件并返回绝对路径。
  saveImage(data: string, ext: string): Promise<string | null>;
  // 拖拽文件落终端：把拖入的 File 解析为绝对路径（Electron 31+ 用 webUtils.getPathForFile
  // 替代已弃用的 File.path；非 Electron 环境返回空串）。绝对路径是拖拽落终端的硬要求，
  // 拿不到就不插入（绝不退化成相对/裸文件名）。
  getPathForFile(file: File): string;
  onData(cb: (key: string, data: string) => void): () => void;
  onStatus(cb: (key: string, status: SessionStatus) => void): () => void;
  onExit(cb: (key: string) => void): () => void;
  onRelink(cb: (from: string, to: string) => void): () => void;
  onIndex(cb: (groups: SessionGroup[]) => void): () => void;
  // 背压回传（对齐 VS Code _writeProcessData 回调里的 acknowledgeDataEvent）：
  // 渲染端每消费 N 字节即通知主进程，使其对 PTY 做流控，避免高速输出淹没前端缓冲。
  // 可选：旧/测试实现可能不存在该字段，XtermTerminal 调用前会判空。
  acknowledgeDataEvent?(key: string, bytes: number): void;
  // 无边框窗口的窗口控制（对应自建标题条）
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  getWindowBounds(): Promise<Bounds>;
  setWindowBounds(bounds: Bounds): void;
  onMaximizeChange(cb: (maximized: boolean) => void): () => void;
  // 配置存储（主进程 config.json 唯一真源，见 docs/adr/0001）
  getInitialConfig(): AppConfig | null; // 窗口创建时经 additionalArguments 同步注入，首屏零闪烁
  getConfig(): Promise<AppConfig>;
  setConfig(partial: Partial<AppConfig>): Promise<void>;
  // ── 文件管理器 / 预览（A + B）──
  fsListDir(root: string, dir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>;
  fsReadFile(root: string, path: string, maxBytes?: number): Promise<{ content: string; language: string; size: number; isBinary: boolean; isImage: boolean; dataUrl?: string }>;
  fsWriteFile(root: string, path: string, content: string): Promise<void>;
  fsStat(root: string, path: string): Promise<{ size: number; mtime: number; isDir: boolean }>;
  // ── 文件管理写操作（新建 / 重命名 / 删除 / 复制 / 移动）──
  fsMkdir(root: string, dir: string): Promise<void>;
  fsCreateFile(root: string, path: string, content?: string): Promise<void>;
  fsRename(root: string, from: string, to: string): Promise<void>;
  fsRemove(root: string, path: string): Promise<void>;
  fsCopy(root: string, from: string, to: string): Promise<void>;
  fsListNames(root: string, dir: string): Promise<string[]>;
  fsUniqueName(base: string, existing: string[]): Promise<string>;
  // 目录监听（外部变更自动刷新，对齐 VS Code FileWatcher）：订阅某目录，返回取消订阅函数。
  fsWatch(root: string, dir: string, cb: () => void): () => void;
  // 文件监听（外部修改自动刷新编辑器）：订阅某个文件，文件变更时回调；返回取消订阅函数。
  fsWatchFile(root: string, path: string, cb: () => void): () => void;
  // ── Git 只读查看（D）──
  gitStatus(cwd: string): Promise<{ isGit: boolean; branch: string | null; additions: number; deletions: number; ahead: number; behind: number; porcelain: string }>;
  gitLog(cwd: string, limit?: number): Promise<Array<{ hash: string; author: string; date: string; message: string }>>;
  gitDiff(cwd: string, ref?: string): Promise<string>;
  // 工作区实时监听：订阅某仓库 cwd，变更时回调；返回取消订阅函数。
  gitWatch(cwd: string, cb: () => void): () => void;
  // 启动动画：renderer 首屏就绪后通知主进程显示窗口并淡出 splash（见 docs/adr/0003）。
  splashDone(): void;
  // 受控外部链接通道：请求主进程用系统默认程序打开 URL（浏览器/mail 客户端）。
  // 协议白名单（http(s)/mailto）在主进程集中校验，file:// 不在此通道（本地文件走 fsOpenWithSystem）。
  openExternal(url: string): Promise<boolean>;
  // 用系统默认程序打开本地文件（二进制/无内置预览器的文件，如 pdf/exe/zip/docx 等）。
  // 等效于在系统文件管理器双击该文件，不走 openExternal 的协议白名单。
  fsOpenWithSystem(absPath: string): Promise<boolean>;
  // 在系统文件管理器中打开文件/目录所在位置并选中（资源管理器“打开所在文件夹”）。
  fsShowInFolder(absPath: string): Promise<boolean>;
  // ── 集成终端（真实 shell）──
  /** 统一终端创建入口：新建终端或打开已有会话文件。command='pi' 时 spawn pi 进程，否则 spawn shell。 */
  spawnTerminal(req: { command?: string; cwd: string; profile?: any; sessionFile?: string; name?: string; key?: string }): Promise<any>;
  listTerminalProfiles(): Promise<TerminalProfile[]>;
  createTerminal(req: { profile: TerminalProfile; cwd: string }): Promise<IntegratedTerminalInfo>;
  // 在「应用工作目录」分组下创建集成终端（cwd 取 config.appWorkDir，主进程确保目录存在）。
  createTerminalInAppWorkDir(req: { profile: TerminalProfile }): Promise<IntegratedTerminalInfo>;
  // 列出当前所有存活的集成终端实例信息（含各自 cwd），供侧边栏按目录分组统计计数。
  listIntegratedTerminals(): Promise<IntegratedTerminalInfo[]>;
  destroyTerminal(id: string): Promise<void>;
  // 主进程在终端 create/destroy/exit 时主动推送的最新实例列表（含各自 cwd），
  // 供侧边栏按目录分组实时刷新计数（对齐 ADR §6「主动推送，避免轮询」）。
  onTerminalList(cb: (list: IntegratedTerminalInfo[]) => void): () => void;
  terminalInput(id: string, data: string): void;
  terminalResize(id: string, cols: number, rows: number): void;
  onTerminalData(cb: (id: string, data: string) => void): () => void;
  onTerminalExit(cb: (id: string) => void): () => void;
  // 滚动缓冲区持久化（对齐 VS Code terminal.integrated.bufferState 的内存暂存版）：
  // 集成终端销毁时上报序列化的 VT 数据流，下次同 id 重建时取回 replay。
  saveTerminalBuffer(id: string, data: string): void;
  loadTerminalBuffer(id: string): Promise<string | undefined>;
  // 集成终端 cwd 变化回传（对齐 VS Code CwdDetectionCapability → 侧边栏目录分组实时刷新）：
  // 注入脚本发的 OSC 633;P;Cwd= 检测到可信 cwd 后，渲染端经此更新主进程缓存并推送实例列表。
  updateTerminalCwd(id: string, cwd: string): void;
}

// Resolve `window.pi` lazily so the live IPC object injected by Electron at
// runtime (or by tests) is always used, instead of a snapshot captured at
// module-load time (when `window.pi` is still undefined).
export const pi: PiApi = new Proxy({} as PiApi, {
  get: (_target, prop) => (window as any).pi?.[prop],
});
