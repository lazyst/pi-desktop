// Code editor + syntax-highlighted preview built on CodeMirror 6.
// Language is loaded on demand by extension. Editing is enabled; the parent
// tracks the dirty state by comparing against the initial content via the
// `onChange` callback.
//
// Markdown files get an extra twist: a Preview/Edit toggle. In Preview mode the
// rendered HTML is shown (read-only); in Edit mode the CodeMirror editor is
// active so the user can make changes and save them (Ctrl/Cmd+S in the drawer).
import { useEffect, useRef, useState } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { pi } from '../ipc';

function themeIsDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  return true; // no attribute → default dark palette
}

function langExtension(language: string) {
  switch (language) {
    case 'typescript': return javascript({ typescript: true });
    case 'javascript': return javascript();
    case 'python': return python();
    case 'json': return json();
    case 'markdown': return markdownLang();
    case 'yaml': return yaml();
    default: return [];
  }
}

// Permissive sanitize schema: allow GFM tables, task lists, and KaTeX spans.
const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
  strip: [...(defaultSchema.strip || []), 'iframe', 'object', 'style', 'form'],
};

interface Props {
  root: string;
  path: string; // relative path within root
  onChange?: (content: string) => void;
}

export function CodePreview({ root, path, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [language, setLanguage] = useState('');
  const [content, setContent] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  // Tracks the content the editor was last built from, so toggling preview
  // mode back to edit re-creates the editor with the current text.
  const editorContentRef = useRef('');

  const isMarkdown = language === 'markdown';

  // Load content from disk when the file path changes.
  useEffect(() => {
    let cancelled = false;
    setPreviewMode(false);
    setLanguage('');
    setContent('');
    editorContentRef.current = '';

    (async () => {
      let fileContent = '';
      let fileLanguage = '';
      try {
        const res = await pi.fsReadFile(root, path);
        fileContent = res.content;
        fileLanguage = res.language;
      } catch {
        fileContent = '';
        fileLanguage = '';
      }
      if (cancelled) return;

      setLanguage(fileLanguage);
      setContent(fileContent);
      // Markdown files open in preview mode by default (rendered HTML).
      setPreviewMode(fileLanguage === 'markdown');
    })();

    return () => { cancelled = true; };
  }, [root, path]);

  // Create / destroy the CodeMirror editor based on the current mode.
  // The editor is only mounted when we are NOT in markdown-preview mode.
  const showEditor = !isMarkdown || !previewMode;
  useEffect(() => {
    if (!showEditor) {
      viewRef.current?.destroy();
      viewRef.current = null;
      return;
    }
    if (!hostRef.current) return;

    const doc = editorContentRef.current || content;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const next = u.state.doc.toString();
        setContent(next);
        onChangeRef.current?.(next);
      }
    });

    const extensions = [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      langCompartment.current.of(langExtension(language)),
      themeCompartment.current.of(themeIsDark() ? oneDark : []),
      EditorView.theme({
        '&': { height: '100%', fontSize: 'calc(13px * var(--font-scale))' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
      }),
      updateListener,
    ];

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({ doc, extensions }),
    });
    viewRef.current = view;

    return () => {
      // Remember the latest text so re-entering edit mode preserves edits.
      editorContentRef.current = view.state.doc.toString();
      view.destroy();
      viewRef.current = null;
    };
  }, [showEditor, root, path, language]);

  // React to theme switches while open.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(themeIsDark() ? oneDark : []),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="code-preview-wrap">
      {isMarkdown && (
        <div className="code-preview-toolbar">
          <div className="code-preview-toggle">
            <button
              type="button"
              className={previewMode ? '' : 'is-active'}
              onClick={() => setPreviewMode(false)}
            >
              编辑
            </button>
            <button
              type="button"
              className={previewMode ? 'is-active' : ''}
              onClick={() => setPreviewMode(true)}
            >
              预览
            </button>
          </div>
        </div>
      )}
      {isMarkdown && previewMode ? (
        <div className="markdown-body markdown-file-preview">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], [rehypeKatex, { throwOnError: false, strict: false }]]}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="code-preview" ref={hostRef} />
      )}
    </div>
  );
}
