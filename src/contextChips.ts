import type { ContextChip } from "./types";

export function chipId() {
  return `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Format context chips into a prompt block the agent can use. */
export function formatContextChips(chips: ContextChip[]): string {
  if (!chips.length) return "";

  const workspace = chips.filter((c) => c.kind !== "annotation");
  const annotations = chips.filter((c) => c.kind === "annotation");
  const parts: string[] = [];

  if (workspace.length) {
    parts.push(
      "### Workspace context",
      "The user selected the following project paths / ranges for this message:",
    );

    for (const c of workspace) {
      if (c.kind === "dir") {
        parts.push(`\n#### Directory \`${c.path || "."}/\``);
        if (c.note?.trim()) parts.push(`Note: ${c.note.trim()}`);
        parts.push(
          "Please inspect this directory (list / read relevant files) as needed.",
        );
        continue;
      }

      if (c.kind === "range" && c.startLine != null && c.endLine != null) {
        parts.push(
          `\n#### \`${c.path}\` (lines ${c.startLine}–${c.endLine})`,
        );
        if (c.note?.trim()) parts.push(`Note: ${c.note.trim()}`);
        if (c.content?.trim()) {
          parts.push("```");
          parts.push(c.content.replace(/\n$/, ""));
          parts.push("```");
        } else {
          parts.push(
            `Please read \`${c.path}\` lines ${c.startLine}–${c.endLine}.`,
          );
        }
        continue;
      }

      // file
      parts.push(`\n#### File \`${c.path}\``);
      if (c.note?.trim()) parts.push(`Note: ${c.note.trim()}`);
      if (c.content?.trim()) {
        parts.push("```");
        parts.push(c.content.replace(/\n$/, ""));
        parts.push("```");
      } else {
        parts.push(`Please read \`${c.path}\` as needed.`);
      }
    }
  }

  if (annotations.length) {
    if (parts.length) parts.push("");
    parts.push(
      "### Annotations",
      "The user highlighted the following excerpts from earlier assistant replies.",
      "Treat each as a reference they want you to use, quote, revise, or address.",
      "Do not ignore them — they are intentional selections, not incidental context.",
    );

    annotations.forEach((c, i) => {
      const label =
        c.note?.trim() ||
        (c.path && c.path !== "assistant" ? c.path : `Annotation ${i + 1}`);
      parts.push(`\n#### ${label}`);
      const body = (c.content ?? "").replace(/\n$/, "");
      if (body) {
        parts.push("```");
        parts.push(body);
        parts.push("```");
      } else {
        parts.push("(empty selection)");
      }
    });
  }

  return parts.join("\n");
}

export function chipLabel(c: ContextChip): string {
  if (c.kind === "annotation") {
    const body = (c.content ?? "").replace(/\s+/g, " ").trim();
    if (!body) return "Annotation";
    return body.length > 48 ? `${body.slice(0, 48)}…` : body;
  }
  if (c.kind === "dir") return c.path ? `${c.path}/` : "./";
  if (c.kind === "range" && c.startLine != null && c.endLine != null) {
    return `${c.path}:${c.startLine}–${c.endLine}`;
  }
  return c.path;
}

/** Stable key for chip dedupe. */
export function chipDedupeKey(c: ContextChip): string {
  if (c.kind === "annotation") {
    return `annotation:${(c.content ?? "").trim()}`;
  }
  return `${c.kind}:${c.path}:${c.startLine ?? ""}:${c.endLine ?? ""}`;
}
