import { describe, expect, it } from "vitest";
import type { ChatDocument, Turn } from "../types";
import {
  abortStreamingTurnsOnDisconnect,
  collectCancelledTurnIds,
  markTurnCancelledById,
  markTurnsCancelled,
  reassertCancelledTurns,
} from "./turns";

function turn(partial: Partial<Turn> & { id: string; status: Turn["status"] }): Turn {
  return {
    userMessage: "hi",
    intermediate: [],
    assistantMessage: "",
    intermediateCollapsed: false,
    attachments: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

function doc(turns: Turn[]): ChatDocument {
  return {
    id: "c1",
    projectId: "p1",
    backend: "grok",
    title: "t",
    acpSessionId: "s1",
    agentConfig: {
      availableModels: [],
      availableAccessModes: [],
    },
    turns,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("markTurnsCancelled", () => {
  it("cancels all streaming/cancelling turns when no turnId", () => {
    const turns = [
      turn({ id: "a", status: "complete" }),
      turn({
        id: "b",
        status: "streaming",
        intermediate: [
          {
            type: "tool",
            id: "t1",
            toolCallId: "tc1",
            title: "Read",
            status: "running",
            collapsed: true,
          },
        ],
      }),
    ];
    const next = markTurnsCancelled(turns);
    expect(next[0].status).toBe("complete");
    expect(next[1].status).toBe("cancelled");
    expect(next[1].intermediateCollapsed).toBe(true);
    expect(next[1].intermediate[0]).toMatchObject({
      type: "tool",
      status: "cancelled",
    });
  });

  it("cancels only the matching turnId", () => {
    const turns = [
      turn({ id: "a", status: "streaming" }),
      turn({ id: "b", status: "streaming" }),
    ];
    const next = markTurnsCancelled(turns, { turnId: "b" });
    expect(next[0].status).toBe("streaming");
    expect(next[1].status).toBe("cancelled");
  });
});

describe("reassertCancelledTurns", () => {
  it("re-marks streaming turns that were already cancelled in the UI", () => {
    const { turns, changed } = reassertCancelledTurns(
      [
        turn({ id: "a", status: "streaming" }),
        turn({ id: "b", status: "complete" }),
      ],
      new Set(["a"]),
    );
    expect(changed).toBe(true);
    expect(turns[0].status).toBe("cancelled");
    expect(turns[1].status).toBe("complete");
  });

  it("is a no-op when nothing needs reassert", () => {
    const { changed } = reassertCancelledTurns(
      [turn({ id: "a", status: "cancelled" })],
      new Set(["a"]),
    );
    expect(changed).toBe(false);
  });
});

describe("abortStreamingTurnsOnDisconnect", () => {
  it("marks streaming turns as error with reason", () => {
    const out = abortStreamingTurnsOnDisconnect(
      doc([
        turn({ id: "a", status: "streaming", assistantMessage: "partial" }),
        turn({ id: "b", status: "complete" }),
      ]),
      "EOF",
    );
    expect(out.turns[0].status).toBe("error");
    expect(out.turns[0].assistantMessage).toContain("agent disconnected");
    expect(out.turns[0].assistantMessage).toContain("EOF");
    expect(out.turns[1].status).toBe("complete");
  });
});

describe("collectCancelledTurnIds / markTurnCancelledById", () => {
  it("collects cancelled ids", () => {
    const ids = collectCancelledTurnIds(
      doc([
        turn({ id: "a", status: "cancelled" }),
        turn({ id: "b", status: "streaming" }),
      ]),
    );
    expect([...ids]).toEqual(["a"]);
  });

  it("marks one turn cancelled by id", () => {
    const next = markTurnCancelledById(
      [turn({ id: "a", status: "streaming" })],
      "a",
    );
    expect(next[0].status).toBe("cancelled");
  });
});
