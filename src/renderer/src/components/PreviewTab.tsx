// 中间区 Tab 内容组件：单文件预览 / 编辑（keep-alive 友好）。
// 由右侧 FileDrawer 抽屉改造而来——去掉 overlay / 左侧拖拽 resizer / 关闭按钮，
// 改为占满 tab 内容的形态。关闭由统一 Tab 条的 × 负责；dirty 时由 tab 条/父组件
// 负责确认（本组件通过 onClose 语义外的 tab 条处理，这里保留 ConfirmDialog 兜底）。
// key 行为完全等价于原抽屉：
//   • 文本/代码 → CodePreview，dirty 跟踪 + 显式保存（fsWriteFile）
//   • 图片 → ImagePreview
//   • 二进制/过大 → 系统默认程序打开（fsOpenWithSystem）
//   • 预览内相对链接点击 → onOpenFile（在应用内切到目标文件）
import { useCallback, useEffect, useRef, useState } from 'react';
import { pi } from '../ipc';
import { CodePreview } from './CodePreview';
import { ImagePreview } from './ImagePreview';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  root: string;
  path: string;
  /** 是否当前可见 tab（keep-alive：非 active 时父容器用 CSS 隐藏，本组件仍挂载）。 */
  active: boolean;
  /** 预览内相对链接点击 → 在应用内切到目标文件（语义同文件树 onOpenFile）。 */
  onOpenFile?: (relPath: string, fileName: string, root: string) => void;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

// 由 root + 相对路径算出绝对路径（渲染进程无 Node 集成，用纯字符串拼接；
// file:// 对 / 与 \\ 均接受）。
function toAbsolutePath(root: string, relPath: string): string {
  if (!root) return relPath;
  return `${root.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r\n|\r|\n/).length;
}

export function PreviewTab({ root, path, active, onOpenFile }: Props) {
  const [dirty, setDirty] = useState(false);
  const [initialContent, setInitialContent] = useState('');
  const [currentContent, setCurrentContent] = useState('');
  const [kind, setKind] = useState<'code' | 'image' | 'binary' | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Load metadata (kind + initial content) when the file changes.
  useEffect(() => {
    let cancelled = false;
    setDirty(false);
    setError(null);
    setKind('loading');
    setInitialContent('');
    setCurrentContent('');
    (async () => {
      try {
        const res = await pi.fsReadFile(root, path);
        if (cancelled) return;
        // 二进制 / 过大文件：无内置预览器，交系统默认程序打开（等同双击文件）。
        if (res.isBinary) {
          const abs = toAbsolutePath(root, path);
          const ok = await pi.fsOpenWithSystem(abs);
          if (!cancelled) setKind('binary');
          if (!ok && !cancelled) setError('无法用系统程序打开该文件');
          return;
        }
        if (res.isImage) setKind('image');
        else {
          setKind('code');
          setInitialContent(res.content);
          setCurrentContent(res.content);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setKind('binary');
      }
    })();
    return () => { cancelled = true; };
  }, [root, path]);

  const doSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await pi.fsWriteFile(root, path, currentContent);
      setInitialContent(currentContent);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [root, path, currentContent]);

  // Ctrl/Cmd+S → save (when there are unsaved changes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // Only intercept when this tab is the active file editor and there is something to save.
        if (active && kind === 'code' && dirty && !saving) {
          e.preventDefault();
          void doSave();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, kind, dirty, saving, doSave]);

  // 当 dirty 且父组件触发关闭（tab 条 ×）时，由父组件调用本回调兜底确认。
  // 这里保留 ConfirmDialog UI；父组件可直接用 onBeforeClose 语义，本项目目前由 tab 条处理。
  const requestClose = () => {
    if (dirty) setConfirmClose(true);
  };

  const fileName = basename(path) || path || '未命名文件';

  return (
    <div className="preview-tab">
      <div className="preview-tab-header">
        <span className="preview-tab-title" title={path}>{fileName}</span>
        {kind === 'code' && (
          <span className="drawer-meta">
            {currentContent ? `${countLines(currentContent)} 行` : ''}
          </span>
        )}
        {dirty && <span className="drawer-dirty" title="未保存">●</span>}
        {error && <span className="drawer-error">{error}</span>}
        <span className="drawer-spacer" />
        {kind !== 'binary' && kind !== 'loading' && (
          <button
            type="button"
            className="btn drawer-save"
            disabled={!dirty || saving}
            onClick={() => void doSave()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        )}
      </div>

      <div className="preview-tab-body">
        {kind === 'code' && (
          <CodePreview
            root={root}
            path={path}
            onChange={(c) => {
              setCurrentContent(c);
              setDirty(c !== initialContent);
            }}
            onOpenFile={onOpenFile ? (relPath, name) => onOpenFile(relPath, name, root) : undefined}
          />
        )}
        {kind === 'image' && <ImagePreview root={root} path={path} />}
        {kind === 'binary' && <div className="preview-empty">二进制文件，已用系统程序打开。</div>}
        {kind === 'loading' && <div className="preview-empty">加载中…</div>}
        {error && <div className="preview-error">{error}</div>}
      </div>

      {confirmClose && (
        <ConfirmDialog
          title="关闭文件"
          message="文件有未保存的改动，确定关闭？改动将不会写入磁盘。"
          confirmLabel="关闭并丢弃"
          cancelLabel="继续编辑"
          onConfirm={() => { setConfirmClose(false); setDirty(false); }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  );
}
