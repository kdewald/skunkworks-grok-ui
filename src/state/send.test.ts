import { describe, expect, it } from "vitest";
import { healStuckBusy, isActivelyStreaming, isRetriableQueueError } from "./send";

describe("isRetriableQueueError", () => {
  it("matches known transient phrases", () => {
    expect(isRetriableQueueError("settling after cancel")).toBe(true);
    expect(isRetriableQueueError("in-flight prompt")).toBe(true);
    expect(isRetriableQueueError("Please try again")).toBe(true);
    expect(isRetriableQueueError("hard failure")).toBe(false);
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
        busy: true,
        activeChat: null,
        activeChatId: null,
        inflightChatId: null,
        inflightTurnId: null,
      }),
      {},
    );
    expect(healed).toBe(false);
    expect(setCount).toBe(0);
  });

  it("refuses while inflightChatId is set", () => {
    const healed = healStuckBusy(
      () => {},
      () => ({
        busy: true,
        activeChat: null,
        activeChatId: "c",
        inflightChatId: "c",
        inflightTurnId: null,
      }),
      { force: true },
    );
    expect(healed).toBe(false);
  });

  it("clears stuck busy with force when idle", () => {
    let partial: Record<string, unknown> | null = null;
    const healed = healStuckBusy(
      (p) => {
        partial = p as Record<string, unknown>;
      },
      () => ({
        busy: true,
        activeChat: null,
        activeChatId: null,
        inflightChatId: null,
        inflightTurnId: null,
      }),
      { force: true },
    );
    expect(healed).toBe(true);
    expect(partial).toMatchObject({
      busy: false,
      inflightChatId: null,
    });
  });
});

describe("isActivelyStreaming", () => {
  it("detects streaming turns", () => {
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
