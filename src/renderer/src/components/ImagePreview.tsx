// Image preview. Fetches the file via fs:readFile which returns a base64
// data URL (already bounds-checked to the allowed root on the main side).
import { useEffect, useState } from 'react';
import { pi } from '../ipc';

interface Props {
  root: string;
  path: string;
}

export function ImagePreview({ root, path }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooBig, setTooBig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    setTooBig(false);
    (async () => {
      try {
        const res = await pi.fsReadFile(root, path);
        if (!cancelled) {
          if (res.dataUrl) setUrl(res.dataUrl);
          else setTooBig(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [root, path]);

  if (error) return <div className="preview-error">无法加载图片：{error}</div>;
  if (tooBig) return <div className="preview-error">图片过大，无法预览。</div>;
  if (!url) return <div className="preview-empty">加载中…</div>;

  return (
    <div className="image-preview">
      <img src={url} alt={path} />
    </div>
  );
}
