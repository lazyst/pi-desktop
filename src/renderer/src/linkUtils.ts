// Markdown 预览内相对/外链解析纯函数（从原 CodePreview 抽出）。
// 仅依赖字符串，无 React / 编辑器依赖，便于单测。

// 判定一个 href 是否为「绝对外部协议」（需走系统默认程序打开）。
// 带协议 scheme（http(s)/mailto/等）视为外部；file: 视为本地（不在此列，由 webview 隔离处理）。
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:');
}

// 以当前文件目录（相对 root）为基准，把 markdown 相对链接解析为相对 root 的目标路径。
// 例：baseDir='docs'、href='./api.md' → 'docs/api.md'；href='../README.md' → 'docs/../README.md'。
// 仅剥掉 ./ 前缀与多余分隔符；.. 回退不做字符串级 parent-walk，而是原样保留，
// 交给主进程 fsBridge 用 nodePath.resolve + 越界校验做权威解析。
export function resolveRelativeLink(baseDir: string, href: string): string {
  const cleanBase = baseDir.replace(/[\\/]+$/, '');
  const cleanHref = href.replace(/^[\\/]+/, '').replace(/^\.\//, '');
  return cleanBase ? `${cleanBase}/${cleanHref}` : cleanHref;
}
