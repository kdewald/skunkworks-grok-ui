import { describe, expect, it } from "vitest";
import {
  healStuckBusy,
  isActivelyStreaming,
  isChatInflight,
  isChatSendBusy,
  isMatchingInflightFinish,
  isRetriableQueueError,
  withoutInflight,
  withInflight,
} from "./send";

describe("isRetriableQueueError", () => {
  it("matches known transient phrases", () => {
    expect(isRetriableQueueError("settling after cancel")).toBe(true);
    expect(isRetriableQueueError("in-flight prompt")).toBe(true);
    expect(isRetriableQueueError("Please try again")).toBe(true);
    expect(isRetriableQueueError("hard failure")).toBe(false);
  });
});

describe("inflight map helpers", () => {
  it("withInflight / withoutInflight are immutable", () => {
    const base = { a: { turnId: "t1", generation: 1 } };
    const added = withInflight(base, "b", { turnId: null, generation: 2 });
    expect(added).toEqual({
      a: { turnId: "t1", generation: 1 },
      b: { turnId: null, generation: 2 },
    });
    expect(base).toEqual({ a: { turnId: "t1", generation: 1 } });
    expect(withoutInflight(added, "a")).toEqual({
      b: { turnId: null, generation: 2 },
    });
  });
});

describe("isMatchingInflightFinish", () => {
  it("rejects missing slot", () => {
    expect(isMatchingInflightFinish(null, "t1")).toBe(false);
  });

  it("accepts any finish while turn id not yet adopted", () => {
    expect(
      isMatchingInflightFinish({ turnId: null, generation: 1 }, "t1"),
    ).toBe(true);
    expect(
      isMatchingInflightFinish({ turnId: null, generation: 1 }, null),
    ).toBe(true);
  });

  it("matches exact turn id once adopted", () => {
    const slot = { turnId: "t1", generation: 1 };
    expect(isMatchingInflightFinish(slot, "t1")).toBe(true);
    expect(isMatchingInflightFinish(slot, "t2")).toBe(false);
    expect(isMatchingInflightFinish(slot, null)).toBe(true);
  });
});

describe("healStuckBusy", () => {
  it("does nothing without force", () => {
    let setCount = 0;
    const healed = healStuckBusy(
      () => {
        setCount++;
      },
      () => ({
        activeChat: null,
        activeChatId: "c",
        inflightPrompts: { c: { turnId: null, generation: 1 } },
      }),
      {},
    );
    expect(healed).toBe(false);
    expect(setCount).toBe(0);
  });

  it("refuses while this chat is actively streaming", () => {
    const healed = healStuckBusy(
      () => {},
      () => ({
        activeChatId: "c",
        inflightPrompts: { c: { turnId: "t1", generation: 1 } },
        activeChat: {
          id: "c",
          projectId: "p",
          backend: "grok",
          title: "t",
          agentConfig: {
            availableModels: [],
            availableAccessModes: [],
          },
          turns: [
            {
              id: "t1",
              userMessage: "",
              intermediate: [],
              assistantMessage: "",
              status: "streaming",
              intermediateCollapsed: false,
              attachments: [],
              createdAt: "",
            },
          ],
          createdAt: "",
          updatedAt: "",
        },
      }),
      { force: true, chatId: "c" },
    );
    expect(healed).toBe(false);
  });

  it("clears a stuck slot for one chat without touching others", () => {
    let partial: Record<string, unknown> | null = null;
    const healed = healStuckBusy(
      (p) => {
        partial = p as Record<string, unknown>;
      },
      () => ({
        activeChat: null,
        activeChatId: "c",
        inflightPrompts: {
          c: { turnId: "t1", generation: 1 },
          other: { turnId: "t2", generation: 2 },
        },
      }),
      { force: true, chatId: "c" },
    );
    expect(healed).toBe(true);
    expect(partial).toMatchObject({
      inflightPrompts: { other: { turnId: "t2", generation: 2 } },
    });
  });
});

describe("isChatInflight / isChatSendBusy", () => {
  it("detects map membership from getter or state", () => {
    const state = {
      inflightPrompts: { c: { turnId: null as string | null, generation: 1 } },
      activeChat: null as null,
    };
    expect(isChatInflight(state, "c")).toBe(true);
    expect(isChatInflight(() => state, "x")).toBe(false);
    expect(isChatSendBusy(state, "c")).toBe(true);
  });
});

describe("isActivelyStreaming", () => {
  it("detects streaming turns on the active chat", () => {
    expect(
      isActivelyStreaming(() => ({
        activeChat: {
          id: "c",
          projectId: "p",
          backend: "grok",
          title: "t",
          agentConfig: {
            availableModels: [],
            availableAccessModes: [],
          },
          turns: [
            {
              id: "t1",
              userMessage: "",
              intermediate: [],
              assistantMessage: "",
              status: "streaming",
              intermediateCollapsed: false,
              attachments: [],
              createdAt: "",
            },
          ],
          createdAt: "",
          updatedAt: "",
        },
      })),
    ).toBe(true);
    expect(isActivelyStreaming(() => ({ activeChat: null }))).toBe(false);
  });
});
