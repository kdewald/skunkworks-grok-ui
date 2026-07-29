import { describe, expect, it } from "vitest";
import type { AgentBackend, ChatDocument, ChatMeta } from "../types";
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

  it("routes a child ACP session to its active parent chat", () => {
    const activeChat: ChatDocument = {
      id: "codex-chat",
      projectId: "project",
      backend: "codex",
      title: "Codex",
      acpSessionId: "parent-session",
      agentConfig: {
        availableModels: [],
        availableAccessModes: [],
      },
      turns: [
        {
          id: "turn",
          userMessage: "delegate",
          assistantMessage: "",
          status: "streaming",
          intermediateCollapsed: false,
          createdAt: "",
          intermediate: [
            {
              type: "subagent",
              id: "block",
              subagentId: "child-session",
              description: "reviewer",
              status: "running",
              output: "",
              collapsed: false,
            },
          ],
        },
      ],
      createdAt: "",
      updatedAt: "",
    };
    const activeState = {
      ...state,
      activeChatId: activeChat.id,
      activeChat,
    };

    expect(
      resolveChatIdForSession(
        () => activeState,
        "child-session",
        "local",
        "codex",
      ),
    ).toBe("codex-chat");
  });
});
