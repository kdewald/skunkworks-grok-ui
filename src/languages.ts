/**
 * Extensible language support for the Files viewer (CodeMirror 6).
 *
 * Core languages (markdown, python, c/c++, js/ts, json, rust) are static
 * imports so Vite always bundles them — dynamic import can fail silently
 * in the Tauri webview and leave monochrome plain text.
 *
 * To add a language:
 * 1. Prefer static import for anything used often
 * 2. Or dynamic import for rarer langs
 * 3. Map file extensions / backend language ids in ALIASES
 */
import type { Extension } from "@codemirror/state";
import type { LanguageSupport } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";

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
  | "go"
  | "java"
  | "php"
  | "sql"
  | "text";

type LangLoader = () => Promise<LanguageSupport | Extension> | LanguageSupport | Extension;

const loaders: Record<Exclude<LanguageKey, "text">, LangLoader> = {
  // --- static (always bundled) ---
  markdown: () => markdown(),
  python: () => python(),
  c: () => cpp(),
  cpp: () => cpp(),
  javascript: () => javascript(),
  typescript: () => javascript({ typescript: true }),
  jsx: () => javascript({ jsx: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  rust: () => rust(),
  // --- dynamic (lazy) ---
  html: async () => {
    const { html } = await import("@codemirror/lang-html");
    return html();
  },
  css: async () => {
    const { css } = await import("@codemirror/lang-css");
    return css();
  },
  xml: async () => {
    const { xml } = await import("@codemirror/lang-xml");
    return xml();
  },
  yaml: async () => {
    const { yaml } = await import("@codemirror/lang-yaml");
    return yaml();
  },
  go: async () => {
    const { go } = await import("@codemirror/lang-go");
    return go();
  },
  java: async () => {
    const { java } = await import("@codemirror/lang-java");
    return java();
  },
  php: async () => {
    const { php } = await import("@codemirror/lang-php");
    return php();
  },
  sql: async () => {
    const { sql } = await import("@codemirror/lang-sql");
    return sql();
  },
};

/** Backend `language` field or file extension → registry key. */
const ALIASES: Record<string, LanguageKey> = {
  rust: "rust",
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  markdown: "markdown",
  python: "python",
  go: "go",
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

export function resolveLanguageKey(
  languageOrExt: string | undefined | null,
  path?: string | null,
): LanguageKey {
  const tryKey = (raw: string | undefined | null): LanguageKey | null => {
    if (!raw) return null;
    const k = raw.trim().toLowerCase();
    if (!k) return null;
    if (k in ALIASES) return ALIASES[k];
    if (k in loaders) return k as LanguageKey;
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

/** Load CodeMirror language support (empty for plain text). */
export async function loadLanguageSupport(
  key: LanguageKey,
): Promise<Extension[]> {
  if (key === "text") return [];
  const loader = loaders[key];
  if (!loader) return [];
  try {
    const support = await Promise.resolve(loader());
    return [support];
  } catch (e) {
    console.warn(`Failed to load language ${key}`, e);
    return [];
  }
}
