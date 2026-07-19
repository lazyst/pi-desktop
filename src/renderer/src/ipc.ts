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
  fsReadFile(root: string, path: string, maxBytes?: number): Promise<{ content: string; language: string; size: number; isBinary: boolean; isImage: boolean; isPdf: boolean; dataUrl?: string }>;
  fsWriteFile(root: string, path: string, content: string): Promise<void>;
  fsStat(root: string, path: string): Promise<{ size: number; mtime: number; isDir: boolean }>;
  // ── Git 只读查看（D）──
  gitStatus(cwd: string): Promise<{ isGit: boolean; branch: string | null; dirty: boolean; ahead: number; behind: number; porcelain: string }>;
  gitLog(cwd: string, limit?: number): Promise<Array<{ hash: string; author: string; date: string; message: string }>>;
  gitDiff(cwd: string, ref?: string): Promise<string>;
  // 启动动画：renderer 首屏就绪后通知主进程显示窗口并淡出 splash（见 docs/adr/0003）。
  splashDone(): void;
  // 受控外部链接通道：请求主进程用系统默认程序打开 URL（浏览器/mail 客户端）。
  // 协议白名单（http(s)/mailto）在主进程集中校验，file:// 不在此通道（见 PdfPreview）。
  openExternal(url: string): Promise<boolean>;
  // ── 集成终端（抽屉内嵌的真实 shell）──
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
}

// Resolve `window.pi` lazily so the live IPC object injected by Electron at
// runtime (or by tests) is always used, instead of a snapshot captured at
// module-load time (when `window.pi` is still undefined).
export const pi: PiApi = new Proxy({} as PiApi, {
  get: (_target, prop) => (window as any).pi?.[prop],
});
