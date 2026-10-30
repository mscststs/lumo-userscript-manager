import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { cn } from '@/lib/utils';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  readOnly?: boolean;
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function CodeEditor({ value, onChange, className, readOnly = false }: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastValue = useRef(value);

  useEffect(() => {
    if (!container.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        javascript({ jsx: false, typescript: false }),
        themeCompartment.current.of(isDark() ? githubDark : githubLight),
        EditorView.lineWrapping,
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString();
            lastValue.current = next;
            onChangeRef.current(next);
          }
        }),
      ],
    });
    const editor = new EditorView({ state, parent: container.current });
    view.current = editor;

    const observer = new MutationObserver(() => {
      editor.dispatch({
        effects: themeCompartment.current.reconfigure(isDark() ? githubDark : githubLight),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    return () => {
      observer.disconnect();
      editor.destroy();
      view.current = null;
    };
    // The editor is intentionally created once; external value updates are
    // applied by the effect below without replacing the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
  }, [value]);

  return <div ref={container} className={cn('h-full min-h-[320px] overflow-hidden', className)} />;
}
