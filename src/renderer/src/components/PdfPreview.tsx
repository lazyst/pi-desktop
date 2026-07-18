// PDF preview via Electron <webview>. The webview loads the file through the
// main process by way of a file:// URL that has already been bounds-checked to
// the allowed root. webview is more stable for PDFs than an <iframe>.
import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';

interface Props {
  /** Absolute path under the allowed root, exposed to the webview as file://. */
  absPath: string;
}

// Minimal structural type for the Electron webview custom element.
type WebviewElement = HTMLElement & {
  src: string;
  addEventListener: (t: string, cb: (...args: any[]) => void) => void;
  removeEventListener: (t: string, cb: (...args: any[]) => void) => void;
};

// webview 导航白名单：仅允许加载受 bounds-check 的本地 file:// 同源 PDF。
// 其余（任何 http(s)/data:/外部跳转）一律拦截，避免 PDF 内嵌链接把隔离的
// webview 带离本地上下文（见 grilling 会话结论：file:// 不进通用 openExternal 通道）。
function isAllowedWebviewUrl(url: string): boolean {
  return url.startsWith('file://');
}

export function PdfPreview({ absPath }: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const onFail = () => setError('无法加载 PDF');
    // 拦截 webview 内任何非 file:// 跳转（如 PDF 超链接、重定向）。
    const onWillNavigate = (e: { url: string; preventDefault: () => void }) => {
      if (!isAllowedWebviewUrl(e.url)) e.preventDefault();
    };
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('will-navigate', onWillNavigate);
    // webview needs the src set after mount; setting it via attribute also works,
    // but doing it here keeps the type-check happy in non-Electron (test) builds.
    try {
      wv.src = `file://${absPath}`;
    } catch {
      setError('无法加载 PDF');
    }
    return () => {
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('will-navigate', onWillNavigate);
    };
  }, [absPath]);

  if (error) return <div className="preview-error">{error}</div>;

  return (
    <div className="pdf-preview">
      <webview ref={ref as unknown as Ref<HTMLElement>} className="pdf-webview" />
    </div>
  );
}
