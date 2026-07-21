import type { ContextChip } from "./types";

export function chipId() {
  return `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Format context chips into a prompt block the agent can use. */
export function formatContextChips(chips: ContextChip[]): string {
  if (!chips.length) return "";
  const parts: string[] = [
    "### Workspace context",
    "The user selected the following project paths / ranges for this message:",
  ];

  for (const c of chips) {
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

  return parts.join("\n");
}

export function chipLabel(c: ContextChip): string {
  if (c.kind === "dir") return c.path ? `${c.path}/` : "./";
  if (c.kind === "range" && c.startLine != null && c.endLine != null) {
    return `${c.path}:${c.startLine}–${c.endLine}`;
  }
  return c.path;
}
