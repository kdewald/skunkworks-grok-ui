/**
 * Monaco ↔ Tauri LSP bridge.
 *
 * Backend (`src-tauri/src/lsp.rs`) owns stdio language servers.
 * This module:
 *  - ensures the right server for a file
 *  - syncs textDocument didOpen/didChange/didSave
 *  - registers Monaco completion / hover / definition
 *  - applies publishDiagnostics as model markers
 *
 * URI alignment: Monaco models must use absolute file paths so their
 * `file://` URIs match what we send to the language server. Relative
 * workspace paths produce models like `file:///src/foo.rs` that never
 * match openDocs / definition targets.
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

type OpenDoc = {
  serverId: LspServerId;
  version: number;
  languageId: string;
  /** Workspace-relative path used by the Files UI. */
  relPath: string;
};

let monacoApi: typeof Monaco | null = null;
let ctx: Ctx | null = null;
let unlistenNotif: UnlistenFn | null = null;
let providersRegistered = false;

/** LSP file:// URI → open doc metadata. */
const openDocs = new Map<string, OpenDoc>();
/** Workspace-relative path → LSP file:// URI. */
const uriByRelPath = new Map<string, string>();

function languageIdForMonaco(monacoLang: string): string {
  // LSP textDocument languageId
  if (monacoLang === "typescript" || monacoLang === "javascript") return monacoLang;
  if (monacoLang === "python") return "python";
  if (monacoLang === "rust") return "rust";
  if (monacoLang === "cpp" || monacoLang === "c") return monacoLang;
  return monacoLang;
}

/** Normalize path separators and collapse trailing slash (except root). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/** file:///Users/foo/bar → /Users/foo/bar ; file://localhost/Users/... handled. */
function fileUriToFsPath(uri: string): string {
  let u = uri;
  try {
    u = decodeURIComponent(uri);
  } catch {
    /* keep raw */
  }
  if (u.startsWith("file://")) {
    let rest = u.slice("file://".length);
    // file:///Users/... → /Users/...
    // file://localhost/Users/... → /Users/...
    if (rest.startsWith("localhost")) rest = rest.slice("localhost".length);
    if (!rest.startsWith("/")) rest = `/${rest}`;
    // Windows file:///C:/... → C:/...
    if (/^\/[A-Za-z]:\//.test(rest)) rest = rest.slice(1);
    return rest;
  }
  return u;
}

/** Absolute FS path for a workspace-relative path, or null if no local LSP ctx. */
export function lspAbsPath(relPath: string): string | null {
  if (!ctx || ctx.remote) return null;
  const root = normPath(ctx.rootAbs);
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root;
}

/** Absolute path string suitable for Monaco `path` prop (aligns model URI with LSP). */
export function monacoModelPath(relPath: string | undefined | null): string | undefined {
  if (!relPath) return undefined;
  return lspAbsPath(relPath) ?? relPath;
}

export async function lspListStatus(): Promise<LspServerStatus[]> {
  return invoke<LspServerStatus[]>("lsp_status");
}

/** Configure local workspace for LSP. Returns absolute root, or null if remote/unavailable. */
export async function setLspWorkspace(opts: {
  projectId: string;
  chatId?: string | null;
  remote: boolean;
}): Promise<string | null> {
  // Close tracked docs when switching workspace (best-effort).
  const prevUris = [...openDocs.keys()];
  for (const uri of prevUris) {
    const doc = openDocs.get(uri);
    if (!doc) continue;
    try {
      await invoke("lsp_notify", {
        serverId: doc.serverId,
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });
    } catch {
      /* ignore */
    }
  }
  openDocs.clear();
  uriByRelPath.clear();
  ctx = null;
  if (opts.remote) return null;
  try {
    const rootAbs = await invoke<string>("get_workspace_abs_root", {
      projectId: opts.projectId,
      chatId: opts.chatId ?? null,
    });
    ctx = {
      projectId: opts.projectId,
      chatId: opts.chatId ?? null,
      rootAbs: normPath(rootAbs),
      remote: false,
    };
    return ctx.rootAbs;
  } catch {
    ctx = null;
    return null;
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
    const existing = openDocs.get(uri);
    if (existing) {
      // Already open — re-sync full text via didChange so the server matches the editor.
      existing.version += 1;
      existing.languageId = languageId;
      existing.relPath = opts.path;
      await invoke("lsp_notify", {
        serverId: existing.serverId,
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text: opts.content }],
        },
      });
      uriByRelPath.set(opts.path, uri);
      return { serverId, status };
    }

    openDocs.set(uri, {
      serverId,
      version: 1,
      languageId,
      relPath: opts.path,
    });
    uriByRelPath.set(opts.path, uri);

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

const changeTimers = new Map<string, number>();

async function resolveUriFromPathOrUri(pathOrUri: string): Promise<string | null> {
  if (pathOrUri.startsWith("file:")) {
    if (openDocs.has(pathOrUri)) return pathOrUri;
    const decoded = (() => {
      try {
        return decodeURIComponent(pathOrUri);
      } catch {
        return pathOrUri;
      }
    })();
    if (openDocs.has(decoded)) return decoded;
  }
  // Workspace-relative path
  const byRel = uriByRelPath.get(pathOrUri);
  if (byRel) return byRel;
  if (!ctx) return null;
  try {
    const uri = await invoke<string>("lsp_file_uri", {
      projectId: ctx.projectId,
      path: pathOrUri,
      chatId: ctx.chatId,
    });
    return uri;
  } catch {
    return null;
  }
}

async function flushDidChange(path: string, text: string): Promise<void> {
  if (!ctx) return;
  try {
    const uri = await resolveUriFromPathOrUri(path);
    if (!uri) return;
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
    const uri = await resolveUriFromPathOrUri(path);
    if (!uri) return;
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
    const uri = await resolveUriFromPathOrUri(path);
    if (!uri) return;
    const doc = openDocs.get(uri);
    if (!doc) return;
    openDocs.delete(uri);
    uriByRelPath.delete(doc.relPath);
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

function findModelForLspUri(
  monaco: typeof Monaco,
  lspUri: string,
): Monaco.editor.ITextModel | null {
  const models = monaco.editor.getModels();
  const targetFs = normPath(fileUriToFsPath(lspUri));
  const targetUriStr = lspUri;

  for (const m of models) {
    const mu = m.uri.toString();
    if (mu === targetUriStr) return m;
    try {
      if (decodeURIComponent(mu) === targetUriStr) return m;
    } catch {
      /* ignore */
    }
    const mFs = normPath(m.uri.scheme === "file" ? m.uri.path : fileUriToFsPath(mu));
    if (mFs === targetFs) return m;
    // Suffix match: relative model path vs absolute LSP uri
    if (targetFs.endsWith(mFs) || mFs.endsWith(targetFs)) return m;
  }

  // Match via openDocs relPath
  const doc = openDocs.get(lspUri);
  if (doc) {
    for (const m of models) {
      const p = m.uri.path.replace(/\\/g, "/");
      if (p.endsWith("/" + doc.relPath) || p === "/" + doc.relPath || p === doc.relPath) {
        return m;
      }
    }
  }
  return null;
}

function applyDiagnostics(params: DiagnosticsParams): void {
  if (!monacoApi) return;
  const model2 = findModelForLspUri(monacoApi, params.uri);
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
      const uri = resolveModelLspUri(model);
      if (!uri) return { suggestions: [] };
      const result = await lspRequestForUri(uri, "textDocument/completion", {
        textDocument: { uri },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });
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
      const uri = resolveModelLspUri(model);
      if (!uri) return null;
      const result = await lspRequestForUri(uri, "textDocument/hover", {
        textDocument: { uri },
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
      const uri = resolveModelLspUri(model);
      if (!uri) return null;
      const result = await lspRequestForUri(uri, "textDocument/definition", {
        textDocument: { uri },
        position: {
          line: position.lineNumber - 1,
          character: position.column - 1,
        },
      });
      if (!result) return null;
      const locs = Array.isArray(result) ? result : [result];
      return (locs as Array<Record<string, unknown>>)
        .map((loc) => {
          const target = loc as {
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
            targetSelectionRange?: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
          };
          const targetUri = target.targetUri ?? target.uri;
          const range =
            target.targetSelectionRange ?? target.targetRange ?? target.range;
          if (!targetUri || !range) return null;

          // Prefer an already-loaded Monaco model so go-to-def actually navigates.
          const existing = findModelForLspUri(monaco, targetUri);
          const monacoUri = existing?.uri ?? monaco.Uri.parse(targetUri);

          return {
            uri: monacoUri,
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

/**
 * Map a Monaco model to the LSP file:// URI we used in didOpen.
 * Never trust model.uri alone when it is a relative-looking file URI.
 */
function resolveModelLspUri(model: Monaco.editor.ITextModel): string | null {
  const u = model.uri.toString();
  if (openDocs.has(u)) return u;
  try {
    const decoded = decodeURIComponent(u);
    if (openDocs.has(decoded)) return decoded;
  } catch {
    /* ignore */
  }

  const modelFs = normPath(
    model.uri.scheme === "file" ? model.uri.path : fileUriToFsPath(u),
  );

  for (const [uri, doc] of openDocs) {
    const abs = normPath(fileUriToFsPath(uri));
    if (abs === modelFs) return uri;
    if (modelFs.endsWith("/" + doc.relPath) || modelFs.endsWith(doc.relPath)) {
      return uri;
    }
    // Relative model: path prop was "src/foo.rs" → uri path often "/src/foo.rs"
    const relNorm = doc.relPath.replace(/\\/g, "/");
    if (
      modelFs === "/" + relNorm ||
      modelFs === relNorm ||
      model.uri.path === relNorm ||
      model.uri.path === "/" + relNorm
    ) {
      return uri;
    }
  }

  // Last resort: if under workspace root, synthesize URI and require openDocs hit.
  if (ctx) {
    const root = normPath(ctx.rootAbs);
    if (modelFs.startsWith(root + "/") || modelFs === root) {
      const rel = modelFs === root ? "" : modelFs.slice(root.length + 1);
      const byRel = uriByRelPath.get(rel);
      if (byRel) return byRel;
    }
  }

  return null;
}

async function lspRequestForUri(
  uri: string,
  method: string,
  params: unknown,
): Promise<unknown | null> {
  const doc = openDocs.get(uri);
  if (!doc) return null;
  try {
    return await invoke("lsp_request", {
      serverId: doc.serverId,
      method,
      params,
    });
  } catch (e) {
    console.warn(`[lsp] ${method} failed:`, e);
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
