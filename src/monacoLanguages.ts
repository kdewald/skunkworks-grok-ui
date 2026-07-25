/**
 * Map our LanguageKey / path hints to Monaco language ids.
 * @see https://microsoft.github.io/monaco-editor/docs.html#functions/languages.getLanguages.html
 */
import { resolveLanguageKey, type LanguageKey } from "./languages";

const MONACO_BY_KEY: Record<LanguageKey, string> = {
  javascript: "javascript",
  typescript: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  json: "json",
  markdown: "markdown",
  rust: "rust",
  python: "python",
  html: "html",
  css: "css",
  xml: "xml",
  yaml: "yaml",
  c: "c",
  cpp: "cpp",
  go: "go",
  java: "java",
  php: "php",
  sql: "sql",
  text: "plaintext",
};

export function resolveMonacoLanguage(
  language?: string | null,
  path?: string | null,
): string {
  const key = resolveLanguageKey(language, path);
  return MONACO_BY_KEY[key] ?? "plaintext";
}
