/**
 * Pure chat-turn lifecycle reducers.
 * No Zustand, no Tauri — call sites feed ChatDocument / Turn snapshots in and out.
 */

import type { ChatDocument, IntermediateBlock, Turn } from "../types";

/** Cancel in-progress tools on a turn (Stop / cancel-started). */
export function cancelOpenTools(block: IntermediateBlock): IntermediateBlock {
  if (
    block.type === "tool" &&
    (block.status === "pending" ||
      block.status === "in_progress" ||
      block.status === "running")
  ) {
    return { ...block, status: "cancelled" };
  }
  return block;
}

/** Mark matching streaming/cancelling turns as cancelled (optimistic Stop paint). */
export function markTurnsCancelled(
  turns: Turn[],
  opts: { turnId?: string | null } = {},
): Turn[] {
  const turnId = opts.turnId;
  return turns.map((t) => {
    const match = turnId
      ? t.id === turnId
      : t.status === "streaming" || t.status === "cancelling";
    if (!match) return t;
    return {
      ...t,
      status: "cancelled" as const,
      intermediateCollapsed: true,
      intermediate: t.intermediate.map(cancelOpenTools),
    };
  });
}

/** Force a single turn id to cancelled (prompt-finished / post-refresh re-assert). */
export function markTurnCancelledById(turns: Turn[], turnId: string): Turn[] {
  return turns.map((t) =>
    t.id === turnId
      ? {
          ...t,
          status: "cancelled" as const,
          intermediateCollapsed: true,
        }
      : t,
  );
}

/**
 * After refresh, re-assert cancelled status for turns the UI already marked
 * cancelled but disk still says streaming/cancelling.
 */
export function reassertCancelledTurns(
  turns: Turn[],
  cancelledIds: Set<string>,
): { turns: Turn[]; changed: boolean } {
  let changed = false;
  const next = turns.map((t) => {
    if (
      cancelledIds.has(t.id) &&
      (t.status === "streaming" || t.status === "cancelling")
    ) {
      changed = true;
      return {
        ...t,
        status: "cancelled" as const,
        intermediateCollapsed: true,
      };
    }
    return t;
  });
  return { turns: next, changed };
}

/** Abort streaming turns when the agent process dies mid-turn. */
export function abortStreamingTurnsOnDisconnect(
  chat: ChatDocument,
  reason: string,
): ChatDocument {
  return {
    ...chat,
    turns: chat.turns.map((t) =>
      t.status === "streaming"
        ? {
            ...t,
            status: "error" as const,
            intermediateCollapsed: true,
            assistantMessage: t.assistantMessage
              ? `${t.assistantMessage}\n\n---\n**Turn aborted:** agent disconnected (${reason})`
              : `**Turn aborted:** agent disconnected (${reason})`,
          }
        : t,
    ),
  };
}

export function collectCancelledTurnIds(chat: ChatDocument | null): Set<string> {
  return new Set(
    chat?.turns.filter((t) => t.status === "cancelled").map((t) => t.id) ?? [],
  );
}
