/**
 * Monaco ↔ Tauri LSP bridge.
 *
 * Backend (`src-tauri/src/lsp.rs`) owns stdio language servers.
 * This module:
 *  - ensures the right server for a file
 *  - syncs textDocument didOpen/didChange/didSave
 *  - registers Monaco completion / hover / definition
 *  - applies publishDiagnostics as model markers
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import { lspServerForLanguage, type LspServerId } from "../languages";

export type LspServerStatus = {
  id: string;
  available: boolean;
  running: boolean;
  command?: string | null;
  root?: string | null;
  error?: string | null;
};

type Ctx = {
  projectId: string;
  chatId: string | null;
  rootAbs: string;
  remote: boolean;
};

let monacoApi: typeof Monaco | null = null;
let ctx: Ctx | null = null;
let unlistenNotif: UnlistenFn | null = null;
let providersRegistered = false;
const openDocs = new Map<
  string,
  { serverId: LspServerId; version: number; languageId: string }
>();
const changeTimers = new Map<string, number>();

function languageIdForMonaco(monacoLang: string): string {
  // LSP textDocument languageId
  if (monacoLang === "typescript" || monacoLang === "javascript") return monacoLang;
  if (monacoLang === "python") return "python";
  if (monacoLang === "rust") return "rust";
  if (monacoLang === "cpp" || monacoLang === "c") return monacoLang;
  return monacoLang;
}

export async function lspListStatus(): Promise<LspServerStatus[]> {
  return invoke<LspServerStatus[]>("lsp_status");
}

export async function setLspWorkspace(opts: {
  projectId: string;
  chatId?: string | null;
  remote: boolean;
}): Promise<void> {
  ctx = null;
  if (opts.remote) return;
  try {
    const rootAbs = await invoke<string>("get_workspace_abs_root", {
      projectId: opts.projectId,
      chatId: opts.chatId ?? null,
    });
    ctx = {
      projectId: opts.projectId,
      chatId: opts.chatId ?? null,
      rootAbs,
      remote: false,
    };
  } catch {
    ctx = null;
  }
}

export async function ensureLspListeners(
  monaco: typeof Monaco,
): Promise<void> {
  monacoApi = monaco;
  if (!unlistenNotif) {
    unlistenNotif = await listen<{
      serverId: string;
      method: string;
      params: unknown;
    }>("lsp-notification", (ev) => {
      if (ev.payload.method === "textDocument/publishDiagnostics") {
        applyDiagnostics(ev.payload.params as DiagnosticsParams);
      }
    });
  }
  if (!providersRegistered) {
    registerProviders(monaco);
    providersRegistered = true;
  }
}

export async function lspDidOpen(opts: {
  path: string;
  language?: string;
  content: string;
  monacoLanguage: string;
}): Promise<{ serverId: LspServerId | null; status?: LspServerStatus; error?: string }> {
  if (!ctx || ctx.remote) return { serverId: null };
  const serverId = lspServerForLanguage(opts.language, opts.path);
  if (!serverId) return { serverId: null };

  try {
    const status = await invoke<LspServerStatus>("lsp_ensure", {
      serverId,
      projectId: ctx.projectId,
      chatId: ctx.chatId,
    });
    if (!status.running) {
      return { serverId, status, error: status.error ?? "server not running" };
    }

    const uri = await invoke<string>("lsp_file_uri", {
      projectId: ctx.projectId,
      path: opts.path,
      chatId: ctx.chatId,
    });

    const languageId = languageIdForMonaco(opts.monacoLanguage);
    openDocs.set(uri, { serverId, version: 1, languageId });

    await invoke("lsp_notify", {
      serverId,
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: opts.content,
        },
      },
    });
    return { serverId, status };
  } catch (e) {
    return { serverId, error: String(e) };
  }
}

export function lspDidChange(uriOrPath: string, text: string): void {
  // Debounce rapid typing
  const key = uriOrPath;
  const prev = changeTimers.get(key);
  if (prev) window.clearTimeout(prev);
  changeTimers.set(
    key,
    window.setTimeout(() => {
      void flushDidChange(uriOrPath, text);
    }, 250),
  );
}

async function flushDidChange(path: string, text: string): Promise<void> {
  if (!ctx) return;
  try {
    const uri = await invoke<string>("lsp_file_uri", {
      projectId: ctx.projectId,
      path,
      chatId: ctx.chatId,
    });
    const doc = openDocs.get(uri);
    if (!doc) return;
    doc.version += 1;
    await invoke("lsp_notify", {
      serverId: doc.serverId,
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: doc.version },
        contentChanges: [{ text }],
      },
    });
  } catch {
    /* ignore */
  }
}

export async function lspDidSave(path: string, text: string): Promise<void> {
  if (!ctx) return;
  try {
    const uri = await invoke<string>("lsp_file_uri", {
      projectId: ctx.projectId,
      path,
      chatId: ctx.chatId,
    });
    const doc = openDocs.get(uri);
    if (!doc) return;
    await invoke("lsp_notify", {
      serverId: doc.serverId,
      method: "textDocument/didSave",
      params: {
        textDocument: { uri },
        text,
      },
    });
  } catch {
    /* ignore */
  }
}

export async function lspDidClose(path: string): Promise<void> {
  if (!ctx) return;
  try {
    const uri = await invoke<string>("lsp_file_uri", {
      projectId: ctx.projectId,
      path,
      chatId: ctx.chatId,
    });
    const doc = openDocs.get(uri);
    if (!doc) return;
    openDocs.delete(uri);
    await invoke("lsp_notify", {
      serverId: doc.serverId,
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
  } catch {
    /* ignore */
  }
}

type DiagnosticsParams = {
  uri: string;
  diagnostics: Array<{
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    severity?: number;
    message: string;
    source?: string;
  }>;
};

function applyDiagnostics(params: DiagnosticsParams): void {
  if (!monacoApi) return;
  const model = monacoApi.editor
    .getModels()
    .find((m) => m.uri.toString() === params.uri || m.uri.toString() === decodeURI(params.uri));
  // Also match by path suffix — Monaco model URIs may differ slightly
  const model2 =
    model ??
    monacoApi.editor.getModels().find((m) => {
      const u = m.uri.toString();
      return params.uri.endsWith(m.uri.path) || u.endsWith(params.uri.replace("file://", ""));
    });
  if (!model2) return;

  const sev = monacoApi.MarkerSeverity;
  const markers = (params.diagnostics ?? []).map((d) => ({
    severity:
      d.severity === 1
        ? sev.Error
        : d.severity === 2
          ? sev.Warning
          : d.severity === 3
            ? sev.Info
            : sev.Hint,
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: Math.max(d.range.end.character + 1, d.range.start.character + 2),
    source: d.source,
  }));
  monacoApi.editor.setModelMarkers(model2, "lsp", markers);
}

function registerProviders(monaco: typeof Monaco): void {
  const selector = [
    { language: "typescript" },
    { language: "javascript" },
    { language: "python" },
    { language: "rust" },
    { language: "cpp" },
    { language: "c" },
  ];

  monaco.languages.registerCompletionItemProvider(selector as never, {
    triggerCharacters: [".", ":", "<", '"', "'", "/", "@"],
    provideCompletionItems: async (model, position) => {
      const result = await lspRequestForModel(
        model,
        "textDocument/completion",
        {
          textDocument: { uri: await modelUri(model) },
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
        },
      );
      if (!result) return { suggestions: [] };
      const items = Array.isArray(result)
        ? result
        : ((result as { items?: unknown[] }).items ?? []);
      const suggestions = (items as Array<Record<string, unknown>>).map(
        (item, i) => {
          const label =
            typeof item.label === "string"
              ? item.label
              : String((item.label as { label?: string })?.label ?? "");
          const insertText =
            typeof item.insertText === "string" ? item.insertText : label;
          return {
            label,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText,
            range: undefined as unknown as Monaco.IRange,
            sortText: String(i).padStart(5, "0"),
          } satisfies Monaco.languages.CompletionItem;
        },
      );
      // Monaco requires range — use word at position
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: suggestions.map((s) => ({ ...s, range })),
      };
    },
  });

  monaco.languages.registerHoverProvider(selector as never, {
    provideHover: async (model, position) => {
      const result = await lspRequestForModel(model, "textDocument/hover", {
        textDocument: { uri: await modelUri(model) },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });
      if (!result || typeof result !== "object") return null;
      const contents = (result as { contents?: unknown }).contents;
      const value = hoverToMarkdown(contents);
      if (!value) return null;
      return { contents: [{ value }] };
    },
  });

  monaco.languages.registerDefinitionProvider(selector as never, {
    provideDefinition: async (model, position) => {
      const result = await lspRequestForModel(
        model,
        "textDocument/definition",
        {
          textDocument: { uri: await modelUri(model) },
          position: {
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
        },
      );
      if (!result) return null;
      const locs = Array.isArray(result) ? result : [result];
      return (locs as Array<Record<string, unknown>>)
        .map((loc) => {
          const target = (loc.targetUri ? loc : loc) as {
            uri?: string;
            targetUri?: string;
            range?: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            targetRange?: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
          };
          const uri = target.targetUri ?? target.uri;
          const range = target.targetRange ?? target.range;
          if (!uri || !range) return null;
          return {
            uri: monaco.Uri.parse(uri),
            range: {
              startLineNumber: range.start.line + 1,
              startColumn: range.start.character + 1,
              endLineNumber: range.end.line + 1,
              endColumn: range.end.character + 1,
            },
          };
        })
        .filter(Boolean) as Monaco.languages.Definition;
    },
  });
}

async function modelUri(model: Monaco.editor.ITextModel): Promise<string> {
  // Prefer LSP-tracked file URI if we opened via workspace path.
  // Monaco model uri may be inmemory:// or file:// from path prop.
  const u = model.uri.toString();
  if (u.startsWith("file:")) return u;
  // Fallback: match openDocs by path suffix
  for (const [uri] of openDocs) {
    if (uri.endsWith(model.uri.path) || model.uri.path.endsWith(uri.replace(/^file:\/\//, ""))) {
      return uri;
    }
  }
  return u;
}

async function lspRequestForModel(
  model: Monaco.editor.ITextModel,
  method: string,
  params: unknown,
): Promise<unknown | null> {
  const uri = await modelUri(model);
  const doc = openDocs.get(uri);
  if (!doc) return null;
  try {
    return await invoke("lsp_request", {
      serverId: doc.serverId,
      method,
      params,
    });
  } catch {
    return null;
  }
}

function hoverToMarkdown(contents: unknown): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) =>
        typeof c === "string"
          ? c
          : String((c as { value?: string }).value ?? ""),
      )
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof contents === "object" && contents && "value" in contents) {
    return String((contents as { value: string }).value);
  }
  return "";
}
