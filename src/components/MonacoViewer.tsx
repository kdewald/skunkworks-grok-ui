import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { resolveMonacoLanguage } from "../monacoLanguages";
import type { LineRange } from "../editorTypes";
import {
  ensureLspListeners,
  lspDidChange,
  lspDidOpen,
  monacoModelPath,
} from "../lsp/client";

type Props = {
  content: string;
  language?: string;
  /** Workspace-relative path (used for LSP didOpen / didChange). */
  path?: string;
  /**
   * Absolute filesystem path for the Monaco model URI. Must match the LSP
   * file:// URI or go-to-definition / diagnostics won't attach to the model.
   * When omitted, falls back to `monacoModelPath(path)` once the LSP workspace is set.
   */
  modelPath?: string;
  /** When false (default for binary/truncated), editing is disabled. */
  editable?: boolean;
  /**
   * When the host pane becomes visible again (e.g. Chat → Files), bump or set
   * true so Monaco re-layouts after `display: none` (scroll/cursor stay put).
   */
  visible?: boolean;
  onChange?: (value: string) => void;
  onSelectionChange?: (range: LineRange | null) => void;
  /** Cmd/Ctrl+S */
  onSave?: () => void;
  /** Fired when LSP attach status changes (for status UI). */
  onLspStatus?: (msg: string | null) => void;
  /**
   * Context-menu / action: add the current non-empty line selection to chat.
   * Wired into Monaco's own context menu so it sits next to Go to Definition.
   */
  onAddSelectionToChat?: (range: LineRange) => void;
  /** Context-menu / action: add the whole file to chat. */
  onAddFileToChat?: () => void;
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
  modelPath: modelPathProp,
  editable = false,
  visible = true,
  onChange,
  onSelectionChange,
  onSave,
  onLspStatus,
  onAddSelectionToChat,
  onAddFileToChat,
}: Props) {
  const edRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onLspRef = useRef(onLspStatus);
  const onAddSelRef = useRef(onAddSelectionToChat);
  const onAddFileRef = useRef(onAddFileToChat);
  onSelRef.current = onSelectionChange;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onLspRef.current = onLspStatus;
  onAddSelRef.current = onAddSelectionToChat;
  onAddFileRef.current = onAddFileToChat;

  const lastEmitted = useRef(content);
  const pathRef = useRef(path);
  pathRef.current = path;

  const monacoLang = useMemo(
    () => resolveMonacoLanguage(language, path),
    [language, path],
  );

  // Absolute FS path so Monaco model URI matches LSP file:// (relative paths break go-to-def).
  const modelPath = useMemo(
    () => modelPathProp ?? monacoModelPath(path) ?? path,
    [modelPathProp, path],
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

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    // Register in Monaco's own context menu (sits with Go to Definition).
    // A separate overlay menu was buried under Monaco's z-index ~10000 layer.
    ed.addAction({
      id: "skunkworks.addSelectionToChat",
      label: "Add Selection to Chat",
      contextMenuGroupId: "9_skunkworks",
      contextMenuOrder: 1,
      precondition: "editorHasSelection",
      run: (editor) => {
        const range = lineRangeFromEditor(
          editor as MonacoEditor.IStandaloneCodeEditor,
        );
        if (range) onAddSelRef.current?.(range);
      },
    });
    ed.addAction({
      id: "skunkworks.addFileToChat",
      label: "Add File to Chat",
      contextMenuGroupId: "9_skunkworks",
      contextMenuOrder: 2,
      run: () => {
        onAddFileRef.current?.();
      },
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

  // Host panes use display:none when inactive; re-measure when shown again so
  // the same scroll/cursor position paints into the correct viewport size.
  useEffect(() => {
    if (!visible) return;
    const ed = edRef.current;
    if (!ed) return;
    const id = requestAnimationFrame(() => {
      ed.layout();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  return (
    <div className="code-viewer-host monaco-viewer-host">
      <Editor
        className="monaco-editor-root"
        height="100%"
        theme="vs-dark"
        language={monacoLang}
        value={content}
        path={modelPath ?? undefined}
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

