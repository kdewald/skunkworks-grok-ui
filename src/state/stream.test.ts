import { describe, expect, it } from "vitest";
import type { AgentBackend, ChatMeta } from "../types";
import { resolveChatIdForSession } from "./stream";

function chat(id: string, backend: AgentBackend): ChatMeta {
  return {
    id,
    projectId: "project",
    backend,
    title: id,
    acpSessionId: "shared-session",
    createdAt: "",
    updatedAt: "",
  };
}

describe("resolveChatIdForSession", () => {
  const state = {
    activeChatId: null,
    activeChat: null,
    chats: [chat("grok-chat", "grok"), chat("codex-chat", "codex")],
    projects: [
      {
        id: "project",
        name: "Project",
        path: "/tmp/project",
        environmentId: "local",
        createdAt: "",
        updatedAt: "",
      },
    ],
    inflightChatId: null,
  };

  it("scopes identical session ids to the selected backend", () => {
    expect(
      resolveChatIdForSession(
        () => state,
        "shared-session",
        "local",
        "codex",
      ),
    ).toBe("codex-chat");
  });

  it("defaults legacy events without a backend to Grok", () => {
    expect(
      resolveChatIdForSession(() => state, "shared-session", "local"),
    ).toBe("grok-chat");
  });
});
