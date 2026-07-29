/** Extract human-readable text from ACP / Grok tool payloads. */

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === "number" && n >= 0 && n <= 255)
  );
}

function bytesToString(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return bytes.map((b) => String.fromCharCode(b)).join("");
  }
}

/** Strip common ANSI color / style sequences from terminal output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function extractFromObject(obj: Record<string, unknown>): string | null {
  // Nested ACP content block: { type, content: { type, text } } or { content: { text } }
  if (obj.content && typeof obj.content === "object" && obj.content !== null) {
    const inner = obj.content as Record<string, unknown>;
    if (typeof inner.text === "string") return inner.text;
    if (typeof inner.content === "string") return inner.content;
  }
  if (typeof obj.text === "string") return obj.text;

  // Grok-shaped envelopes
  for (const key of [
    "Content",
    "FileContent",
    "output",
    "result",
    "stdout",
    "stderr",
  ]) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (typeof v === "string") return v;
    if (isByteArray(v)) return bytesToString(v);
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.content === "string") return rec.content;
      if (typeof rec.text === "string") return rec.text;
      if (isByteArray(rec.output)) return bytesToString(rec.output);
      if (typeof rec.output === "string") return rec.output;
    }
  }

  return null;
}

/** Flatten tool content / rawOutput into display text when possible. */
export function formatToolPayload(value: unknown): {
  kind: "text" | "json";
  text: string;
} {
  if (value == null) return { kind: "text", text: "" };
  if (typeof value === "string") {
    return { kind: "text", text: stripAnsi(value) };
  }
  if (isByteArray(value)) {
    return { kind: "text", text: stripAnsi(bytesToString(value)) };
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const extracted = extractFromObject(item as Record<string, unknown>);
        if (extracted != null) {
          parts.push(extracted);
          continue;
        }
        // diff blocks
        const rec = item as Record<string, unknown>;
        if (rec.type === "diff" || ("path" in rec && "newText" in rec)) {
          const path = String(rec.path ?? "file");
          const oldText = rec.oldText == null ? "" : String(rec.oldText);
          const newText = String(rec.newText ?? "");
          parts.push(`--- ${path}\n+++ ${path}\n- old (${oldText.length} chars)\n+ new (${newText.length} chars)\n\n${newText}`);
          continue;
        }
      }
      parts.push(JSON.stringify(item, null, 2));
    }
    const joined = parts.join("\n\n");
    // If we only produced JSON dumps, keep as json
    if (parts.length === 1 && parts[0].startsWith("{")) {
      return { kind: "json", text: parts[0] };
    }
    return { kind: "text", text: stripAnsi(joined) };
  }

  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const extracted = extractFromObject(rec);
    if (extracted != null) {
      return { kind: "text", text: stripAnsi(extracted) };
    }

    // Prefer decoding common Grok rawOutput shapes before dumping whole object
    if (rec.output != null) {
      return formatToolPayload(rec.output);
    }
    if (rec.Content != null) return formatToolPayload(rec.Content);
    if (rec.FileContent != null) return formatToolPayload(rec.FileContent);

    try {
      return { kind: "json", text: JSON.stringify(value, null, 2) };
    } catch {
      return { kind: "text", text: String(value) };
    }
  }

  return { kind: "text", text: String(value) };
}

export function formatToolInput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    // Prefer a single interesting field for the one-line tool hint.
    for (const key of [
      "command",
      "target_file",
      "target_directory",
      "path",
      "query",
      "pattern",
      "url",
      "file_path",
      "filePath",
    ]) {
      if (typeof rec[key] === "string" && rec[key].trim()) {
        return String(rec[key]).replace(/\s+/g, " ").trim();
      }
    }
    const keys = Object.keys(rec);
    if (keys.length > 0 && keys.length <= 3) {
      return keys
        .map((k) => {
          const v = rec[k];
          if (typeof v === "string") return `${k}=${v.replace(/\s+/g, " ").trim()}`;
          try {
            return `${k}=${JSON.stringify(v)}`;
          } catch {
            return `${k}=…`;
          }
        })
        .join(" ");
    }
  }
  try {
    // Compact JSON for rare shapes — never pretty multi-line in the row hint.
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
