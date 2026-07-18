// Code editor + syntax-highlighted preview built on CodeMirror 6.
// Language is loaded on demand by extension. Editing is enabled; the parent
// tracks the dirty state by comparing against the initial content via the
// `onChange` callback.
import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
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
    case 'markdown': return markdown();
    case 'yaml': return yaml();
    default: return [];
  }
}

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

  // Build the editor when the file path changes; load content from disk.
  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;

    (async () => {
      let content = '';
      let language = '';
      try {
        const res = await pi.fsReadFile(root, path);
        content = res.content;
        language = res.language;
      } catch {
        content = '';
      }
      if (cancelled) return;

      const updateListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
      });

      const extensions = [
        lineNumbers(),
        history(),
        highlightActiveLine(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        langCompartment.current.of(langExtension(language)),
        themeCompartment.current.of(themeIsDark() ? oneDark : []),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
        }),
        updateListener,
      ];

      if (hostRef.current) {
        view = new EditorView({
          parent: hostRef.current,
          state: EditorState.create({ doc: content, extensions }),
        });
        viewRef.current = view;
      }
    })();

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [root, path]);

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

  return <div className="code-preview" ref={hostRef} />;
}
