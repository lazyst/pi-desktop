// ```mermaid 代码块的渲染组件：用 mermaid 把描述渲染成 SVG。
// 与 orca 的 MermaidBlock 同职责，但独立实现、仅依赖 mermaid（无 orca 内部依赖）。
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let initialized = false;
function ensureInit() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    fontFamily: 'var(--font-mono, monospace)',
  });
  initialized = true;
}

let seq = 0;

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    ensureInit();
    const id = `mermaid-${seq++}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="md-mermaid-error">
        <div className="md-mermaid-error-title">Mermaid 渲染失败</div>
        <pre>{error}</pre>
        <pre className="md-mermaid-source">{code}</pre>
      </div>
    );
  }
  return <div className="md-mermaid" ref={ref} />;
}
