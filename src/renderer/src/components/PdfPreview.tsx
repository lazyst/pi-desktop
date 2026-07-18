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
type WebviewElement = HTMLElement & { src: string; addEventListener: (t: string, cb: () => void) => void; removeEventListener: (t: string, cb: () => void) => void };

export function PdfPreview({ absPath }: Props) {
  const ref = useRef<WebviewElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const onFail = () => setError('无法加载 PDF');
    wv.addEventListener('did-fail-load', onFail);
    // webview needs the src set after mount; setting it via attribute also works,
    // but doing it here keeps the type-check happy in non-Electron (test) builds.
    try {
      wv.src = `file://${absPath}`;
    } catch {
      setError('无法加载 PDF');
    }
    return () => wv.removeEventListener('did-fail-load', onFail);
  }, [absPath]);

  if (error) return <div className="preview-error">{error}</div>;

  return (
    <div className="pdf-preview">
      <webview ref={ref as unknown as Ref<HTMLElement>} className="pdf-webview" />
    </div>
  );
}
