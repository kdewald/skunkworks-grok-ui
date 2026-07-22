import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { loadLanguageSupport, resolveLanguageKey } from "../languages";

export type LineRange = { start: number; end: number };

type Props = {
  content: string;
  /** Backend language id and/or path for extension mapping. */
  language?: string;
  path?: string;
  onSelectionChange?: (range: LineRange | null) => void;
  onContextMenu?: (e: MouseEvent, range: LineRange | null) => void;
};

/** Align One Dark base with our Ghostty palette (highlight colors come from oneDark). */
const grokEditorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "12.5px",
      backgroundColor: "#1d1f21",
    },
    ".cm-scroller": {
      fontFamily:
        "IBM Plex Mono, SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace",
      lineHeight: "1.45",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "#f0c674",
      paddingBottom: "24px",
    },
    ".cm-gutters": {
      backgroundColor: "#1d1f21",
      color: "#7a808a",
      border: "none",
      borderRight: "1px solid #3a3f4b",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "#2c313c",
      color: "#c5c8c6",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(240, 198, 116, 0.22) !important",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#f0c674",
    },
  },
  { dark: true },
);

function lineRangeFromState(state: EditorState): LineRange | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const from = state.doc.lineAt(sel.from).number;
  const to = state.doc.lineAt(
    Math.max(sel.from, sel.to - (sel.to > sel.from ? 1 : 0)),
  ).number;
  return { start: Math.min(from, to), end: Math.max(from, to) };
}

export function CodeViewer({
  content,
  language,
  path,
  onSelectionChange,
  onContextMenu,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSelRef = useRef(onSelectionChange);
  const onCtxRef = useRef(onContextMenu);
  onSelRef.current = onSelectionChange;
  onCtxRef.current = onContextMenu;

  // Recreate editor when path, language, or content identity changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;

    void (async () => {
      const langKey = resolveLanguageKey(language, path);
      const langExt = await loadLanguageSupport(langKey);
      if (cancelled || !hostRef.current) return;

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          onSelRef.current?.(lineRangeFromState(update.state));
        }
      });

      const contextHandler = EditorView.domEventHandlers({
        contextmenu(event, v) {
          const range = lineRangeFromState(v.state);
          onCtxRef.current?.(event, range);
          event.preventDefault();
          return true;
        },
      });

      // oneDark already includes syntaxHighlighting(oneDarkHighlightStyle).
      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        bracketMatching(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        oneDark,
        grokEditorTheme,
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        updateListener,
        contextHandler,
        ...langExt,
      ];

      viewRef.current?.destroy();
      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions,
        }),
        parent: hostRef.current,
      });
      viewRef.current = view;
    })();

    return () => {
      cancelled = true;
      // Always tear down whatever is mounted (local `view` may still be null
      // if cleanup runs mid-async load).
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
      host.replaceChildren();
    };
  }, [language, path, content]);

  return <div className="code-viewer-host" ref={hostRef} />;
}
