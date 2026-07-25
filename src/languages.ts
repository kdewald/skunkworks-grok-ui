/**
 * Language identity for the Files editor (Monaco + LSP).
 * Extension / backend language id → registry key.
 */

export type LanguageKey =
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "json"
  | "markdown"
  | "rust"
  | "python"
  | "html"
  | "css"
  | "xml"
  | "yaml"
  | "c"
  | "cpp"
  | "java"
  | "php"
  | "sql"
  | "text";

/** Backend `language` field or file extension → registry key. */
const ALIASES: Record<string, LanguageKey> = {
  rust: "rust",
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  markdown: "markdown",
  python: "python",
  java: "java",
  kotlin: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cpp",
  html: "html",
  css: "css",
  xml: "xml",
  yaml: "yaml",
  sql: "sql",
  php: "php",
  text: "text",
  shell: "text",
  ruby: "text",
  md: "markdown",
  mdx: "markdown",
  mkd: "markdown",
  py: "python",
  pyi: "python",
  pyw: "python",
  pyx: "python",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  cppm: "cpp",
  ixx: "cpp",
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  kt: "java",
  htm: "html",
  scss: "css",
  svg: "xml",
  yml: "yaml",
  toml: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  fish: "text",
  txt: "text",
  log: "text",
};

const KNOWN_KEYS = new Set<string>([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "markdown",
  "rust",
  "python",
  "html",
  "css",
  "xml",
  "yaml",
  "c",
  "cpp",
  "java",
  "php",
  "sql",
  "text",
]);

export function resolveLanguageKey(
  languageOrExt: string | undefined | null,
  path?: string | null,
): LanguageKey {
  const tryKey = (raw: string | undefined | null): LanguageKey | null => {
    if (!raw) return null;
    const k = raw.trim().toLowerCase();
    if (!k) return null;
    if (k in ALIASES) return ALIASES[k];
    if (KNOWN_KEYS.has(k)) return k as LanguageKey;
    return null;
  };

  const fromLang = tryKey(languageOrExt);
  if (fromLang) return fromLang;

  if (path) {
    const base = path.split(/[/\\]/).pop() ?? "";
    const ext = base.includes(".") ? base.split(".").pop() : "";
    const fromExt = tryKey(ext);
    if (fromExt) return fromExt;
  }

  return "text";
}

/**
 * Map file language → LSP server id we manage (null = no LSP).
 * Go is intentionally unsupported.
 */
export type LspServerId = "typescript" | "python" | "rust" | "cpp";

export function lspServerForLanguage(
  languageOrExt: string | undefined | null,
  path?: string | null,
): LspServerId | null {
  const key = resolveLanguageKey(languageOrExt, path);
  switch (key) {
    case "typescript":
    case "javascript":
    case "tsx":
    case "jsx":
      return "typescript";
    case "python":
      return "python";
    case "rust":
      return "rust";
    case "c":
    case "cpp":
      return "cpp";
    default:
      return null;
  }
}
