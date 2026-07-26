import { describe, expect, it } from "vitest";
import {
  beginOpenFile,
  completeOpenFile,
  failOpenFile,
  initialFileSession,
  isCurrentSession,
} from "./fileSession";

describe("fileSession generation guards", () => {
  it("beginOpenFile bumps generation and clears prior file", () => {
    const prev = {
      ...initialFileSession<string>(),
      generation: 3,
      activePath: "a.rs",
      file: "old",
      draft: "old",
    };
    const next = beginOpenFile(prev, "b.rs");
    expect(next.generation).toBe(4);
    expect(next.activePath).toBe("b.rs");
    expect(next.loading).toBe(true);
    expect(next.file).toBeNull();
    expect(next.draft).toBe("");
  });

  it("completeOpenFile ignores stale generation", () => {
    const opened = beginOpenFile(initialFileSession<string>(), "a.rs");
    const stale = completeOpenFile(opened, opened.generation - 1, "a.rs", "nope", "nope");
    expect(stale.file).toBeNull();
    const ok = completeOpenFile(opened, opened.generation, "a.rs", "body", "body");
    expect(ok.file).toBe("body");
    expect(ok.loading).toBe(false);
  });

  it("failOpenFile ignores path mismatch", () => {
    const opened = beginOpenFile(initialFileSession<string>(), "a.rs");
    const ignored = failOpenFile(opened, opened.generation, "other.rs", "err");
    expect(ignored.error).toBeNull();
    const failed = failOpenFile(opened, opened.generation, "a.rs", "boom");
    expect(failed.error).toBe("boom");
    expect(failed.loading).toBe(false);
  });

  it("isCurrentSession checks gen+path", () => {
    const s = beginOpenFile(initialFileSession(), "x.ts");
    expect(isCurrentSession(s, s.generation, "x.ts")).toBe(true);
    expect(isCurrentSession(s, s.generation + 1, "x.ts")).toBe(false);
    expect(isCurrentSession(s, s.generation, "y.ts")).toBe(false);
  });
});
