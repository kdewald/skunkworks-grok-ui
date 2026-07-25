import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { resolveMonacoLanguage } from "../monacoLanguages";
import type { LineRange } from "../editorTypes";
import {
  ensureLspListeners,
  lspDidChange,
  lspDidOpen,
  lspDidSave,
} from "../lsp/client";

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
  /** Fired when LSP attach status changes (for status UI). */
  onLspStatus?: (msg: string | null) => void;
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
 * Monaco file editor with optional LSP (completion, hover, definition, diagnostics).
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
  onLspStatus,
}: Props) {
  const edRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onCtxRef = useRef(onContextMenu);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onLspRef = useRef(onLspStatus);
  onSelRef.current = onSelectionChange;
  onCtxRef.current = onContextMenu;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onLspRef.current = onLspStatus;

  const lastEmitted = useRef(content);
  const pathRef = useRef(path);
  pathRef.current = path;

  const monacoLang = useMemo(
    () => resolveMonacoLanguage(language, path),
    [language, path],
  );

  const handleMount = useCallback<OnMount>((ed, monaco) => {
    edRef.current = ed;
    lastEmitted.current = ed.getValue();
    void ensureLspListeners(monaco);

    ed.onDidChangeCursorSelection(() => {
      onSelRef.current?.(lineRangeFromEditor(ed));
    });
    ed.onDidChangeModelContent(() => {
      const v = ed.getValue();
      if (v === lastEmitted.current) return;
      lastEmitted.current = v;
      onChangeRef.current?.(v);
      if (pathRef.current) {
        lspDidChange(pathRef.current, v);
      }
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
  }, []);

  useEffect(() => {
    edRef.current?.updateOptions({
      readOnly: !editable,
      domReadOnly: !editable,
    });
  }, [editable]);

  // Attach LSP when path/content opens (local workspace only — client no-ops if unset).
  useEffect(() => {
    if (!path || !content) {
      onLspRef.current?.(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await lspDidOpen({
        path,
        language,
        content,
        monacoLanguage: monacoLang,
      });
      if (cancelled) return;
      if (res.error) {
        onLspRef.current?.(
          res.serverId
            ? `LSP (${res.serverId}): ${res.error}`
            : null,
        );
      } else if (res.serverId) {
        onLspRef.current?.(`LSP: ${res.serverId}`);
      } else {
        onLspRef.current?.(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, language, monacoLang]); // content only on open — not every keystroke

  // Notify parent save path to also call lspDidSave externally.

  return (
    <div className="code-viewer-host monaco-viewer-host">
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
          minimap: { enabled: true, scale: 1, showSlider: "mouseover" },
          fontSize: 12.5,
          fontFamily:
            "IBM Plex Mono, SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace",
          lineHeight: 18,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          renderLineHighlight: "all",
          stickyScroll: { enabled: true },
          bracketPairColorization: { enabled: true },
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
          },
          padding: { top: 4, bottom: 24 },
          contextmenu: true,
          automaticLayout: true,
          quickSuggestions: editable,
          suggestOnTriggerCharacters: editable,
        }}
        loading={<div className="file-viewer-empty">Loading Monaco…</div>}
      />
    </div>
  );
}

export { lspDidSave };
