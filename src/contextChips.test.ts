import { describe, expect, it } from "vitest";
import {
  chipDedupeKey,
  chipLabel,
  formatContextChips,
} from "./contextChips";

describe("formatContextChips", () => {
  it("formats annotations for the model", () => {
    const out = formatContextChips([
      {
        id: "a1",
        kind: "annotation",
        path: "assistant",
        content: "Use the dark theme tokens",
        note: "Keep this",
      },
    ]);
    expect(out).toContain("### Annotations");
    expect(out).toContain("highlighted the following excerpts");
    expect(out).toContain("Keep this");
    expect(out).toContain("Use the dark theme tokens");
  });

  it("keeps workspace context and annotations separate", () => {
    const out = formatContextChips([
      {
        id: "f1",
        kind: "file",
        path: "src/App.tsx",
        content: "export function App() {}",
      },
      {
        id: "a1",
        kind: "annotation",
        path: "turn:abc",
        content: "prefer flex over grid",
      },
    ]);
    expect(out).toContain("### Workspace context");
    expect(out).toContain("`src/App.tsx`");
    expect(out).toContain("### Annotations");
    expect(out).toContain("prefer flex over grid");
  });
});

describe("chipLabel / chipDedupeKey", () => {
  it("labels and dedupes annotations by content", () => {
    const chip = {
      id: "a",
      kind: "annotation" as const,
      path: "assistant",
      content: "hello world this is a longer annotation body",
    };
    expect(chipLabel(chip)).toMatch(/hello world/);
    expect(chipDedupeKey(chip)).toBe(
      "annotation:hello world this is a longer annotation body",
    );
  });
});
