import { useCallback, useMemo, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { resolveMonacoLanguage } from "../monacoLanguages";
import type { LineRange } from "./CodeViewer";

type Props = {
  content: string;
  language?: string;
  path?: string;
  onSelectionChange?: (range: LineRange | null) => void;
  onContextMenu?: (e: MouseEvent, range: LineRange | null) => void;
  /** Optional label strip (used in compare mode). */
  label?: string;
};

function lineRangeFromEditor(
  ed: MonacoEditor.IStandaloneCodeEditor,
): LineRange | null {
  const sel = ed.getSelection();
  if (!sel || sel.isEmpty()) return null;
  const start = Math.min(sel.startLineNumber, sel.endLineNumber);
  // Monaco end column 1 on a lower line means the previous line is the last full line.
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
 * Read-only Monaco file viewer — same surface API as CodeViewer for A/B compare.
 * CodeMirror remains the default; this path is for side-by-side evaluation.
 */
export function MonacoViewer({
  content,
  language,
  path,
  onSelectionChange,
  onContextMenu,
  label,
}: Props) {
  const edRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onCtxRef = useRef(onContextMenu);
  onSelRef.current = onSelectionChange;
  onCtxRef.current = onContextMenu;

  const monacoLang = useMemo(
    () => resolveMonacoLanguage(language, path),
    [language, path],
  );

  const handleMount = useCallback<OnMount>((ed) => {
    edRef.current = ed;
    ed.onDidChangeCursorSelection(() => {
      onSelRef.current?.(lineRangeFromEditor(ed));
    });
    ed.onContextMenu((e) => {
      // Monaco's event is editor-relative; use the browser event when present.
      const dom = e.event?.browserEvent as MouseEvent | undefined;
      if (dom) {
        onCtxRef.current?.(dom, lineRangeFromEditor(ed));
        dom.preventDefault();
        dom.stopPropagation();
      }
    });
  }, []);

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
          readOnly: true,
          domReadOnly: true,
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
