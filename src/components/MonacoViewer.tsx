import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { resolveMonacoLanguage } from "../monacoLanguages";
import type { LineRange } from "./CodeViewer";

type Props = {
  content: string;
  language?: string;
  path?: string;
  /** When false (default for binary/truncated), editing is disabled. */
  editable?: boolean;
  onChange?: (value: string) => void;
  onSelectionChange?: (range: LineRange | null) => void;
  onContextMenu?: (e: MouseEvent, range: LineRange | null) => void;
  /** Cmd/Ctrl+S */
  onSave?: () => void;
  /** Optional label strip (used in compare mode). */
  label?: string;
};

function lineRangeFromEditor(
  ed: MonacoEditor.IStandaloneCodeEditor,
): LineRange | null {
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) return null;
  const start = Math.min(sel.startLineNumber, sel.endLineNumber);
  let end = Math.max(sel.startLineNumber, sel.endLineNumber);
  if (
    sel.endLineNumber > sel.startLineNumber &&
    sel.endColumn === 1 &&
    sel.endLineNumber === end
  ) {
    end = Math.max(start, end - 1);
  }
  return { start, end };
}

/**
 * Monaco file viewer/editor — same surface API as CodeViewer for A/B compare.
 */
export function MonacoViewer({
  content,
  language,
  path,
  editable = false,
  onChange,
  onSelectionChange,
  onContextMenu,
  onSave,
  label,
}: Props) {
  const edRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onCtxRef = useRef(onContextMenu);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onSelRef.current = onSelectionChange;
  onCtxRef.current = onContextMenu;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  // Avoid feedback loops when parent pushes the same content after save.
  const lastEmitted = useRef(content);

  const monacoLang = useMemo(
    () => resolveMonacoLanguage(language, path),
    [language, path],
  );

  const handleMount = useCallback<OnMount>(
    (ed, monaco) => {
      edRef.current = ed;
      lastEmitted.current = ed.getValue();

      ed.onDidChangeCursorSelection(() => {
        onSelRef.current?.(lineRangeFromEditor(ed));
      });
      ed.onDidChangeModelContent(() => {
        const v = ed.getValue();
        if (v === lastEmitted.current) return;
        lastEmitted.current = v;
        onChangeRef.current?.(v);
      });
      ed.onContextMenu((e) => {
        const dom = e.event?.browserEvent as MouseEvent | undefined;
        if (dom) {
          onCtxRef.current?.(dom, lineRangeFromEditor(ed));
          dom.preventDefault();
          dom.stopPropagation();
        }
      });

      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.();
      });
    },
    [],
  );

  // Keep readOnly in sync without remounting.
  useEffect(() => {
    edRef.current?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
    });
  }, [editable]);

  return (
    <div className="code-viewer-host monaco-viewer-host">
      {label && <div className="editor-pane-label">{label}</div>}
      <Editor
        className="monaco-editor-root"
        height="100%"
        theme="vs-dark"
        language={monacoLang}
        value={content}
        path={path ?? undefined}
        onMount={handleMount}
        options={{
          readOnly: !editable,
          domReadOnly: !editable,
          minimap: { enabled: false },
          fontSize: 12.5,
          fontFamily:
            "IBM Plex Mono, SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace",
          lineHeight: 18,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          renderLineHighlight: "line",
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          padding: { top: 4, bottom: 24 },
          contextmenu: false,
          automaticLayout: true,
        }}
        loading={<div className="file-viewer-empty">Loading Monaco…</div>}
      />
    </div>
  );
}
