/** What Grok UI can put into an ACP prompt today. */

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Image MIME types accepted as ACP `image` blocks. */
export const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
]);

/**
 * Text / code files we embed as ACP `resource` blocks (embeddedContext).
 * Binary formats (pdf, zip, docx, …) are rejected — Grok can't process them
 * as prompt attachments (it can still open project files via tools).
 */
export const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "csv",
  "tsv",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "vue",
  "svelte",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "cs",
  "php",
  "sql",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "env",
  "ini",
  "cfg",
  "conf",
  "log",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "cmake",
  "gradle",
  "properties",
  "r",
  "lua",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "scala",
  "dart",
  "zig",
  "nim",
  "ml",
  "mli",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "npmrc",
  "prettierrc",
  "eslintrc",
]);

/** `<input accept>` value limited to processable types. */
export const FILE_ACCEPT = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ...[...TEXT_EXTENSIONS].map((e) => `.${e}`),
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/css",
  "text/javascript",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/toml",
].join(",");

export type AttachmentKind = "image" | "text";

export type PendingAttachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  /** Base64 without data: prefix */
  data: string;
  /** Preview for images */
  dataUrl?: string;
  size: number;
};

export function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() || name;
  // Dockerfile / Makefile style
  if (!base.includes(".")) {
    return base.toLowerCase();
  }
  const parts = base.toLowerCase().split(".");
  return parts[parts.length - 1] || "";
}

export function classifyFile(
  name: string,
  mime: string,
): AttachmentKind | null {
  const ext = extensionOf(name);
  if (IMAGE_MIME.has(mime) || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "application/x-yaml" ||
    mime === "application/toml" ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return "text";
  }
  // No mime but known text ext
  if (!mime && TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function fileToPending(
  file: File,
): Promise<{ ok: true; attachment: PendingAttachment } | { ok: false; reason: string }> {
  const kind = classifyFile(file.name, file.type);
  if (!kind) {
    return {
      ok: false,
      reason: `${file.name}: unsupported type (images or text/code only)`,
    };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: `${file.name}: too large (max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`,
    };
  }
  if (file.size === 0) {
    return { ok: false, reason: `${file.name}: empty file` };
  }

  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  if (kind === "image" && bytes.length < 64) {
    return { ok: false, reason: `${file.name}: image too small` };
  }
  if (kind === "text") {
    // Ensure UTF-8
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        ok: false,
        reason: `${file.name}: not valid UTF-8 text`,
      };
    }
  }

  const mimeType =
    file.type ||
    (kind === "image"
      ? "image/png"
      : file.name.endsWith(".json")
        ? "application/json"
        : "text/plain");
  const data = bytesToBase64(bytes);
  const dataUrl =
    kind === "image" ? `data:${mimeType};base64,${data}` : undefined;

  return {
    ok: true,
    attachment: {
      id: uid(),
      kind,
      name: file.name || (kind === "image" ? "image.png" : "file.txt"),
      mimeType,
      data,
      dataUrl,
      size: bytes.length,
    },
  };
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
