// 应用内内存剪贴板（一期不做系统剪贴板桥接）。
// 用于文件树的复制 / 剪切，跨组件、跨时间共享，关闭面板即丢失（符合文件管理器的常见预期）。

export interface ClipItem {
  root: string;
  relPath: string;
  isDir: boolean;
}

export type ClipMode = 'copy' | 'cut';

export interface ClipState {
  mode: ClipMode;
  items: ClipItem[];
}

type Listener = () => void;

let state: ClipState | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const clipboard = {
  get(): ClipState | null {
    return state;
  },
  set(next: ClipState | null): void {
    state = next;
    emit();
  },
  clear(): void {
    state = null;
    emit();
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
