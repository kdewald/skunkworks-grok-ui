/**
 * Session-update stream apply pipeline (buffer → batch IPC → rAF paint).
 * Owns module-level queue state; store wires set/get.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ChatDocument, ChatMeta, Project } from "../types";
import { LOCAL_ENV_ID } from "../types";

type PendingBatch = {
  sessionId: string;
  environmentId?: string;
  updates: unknown[];
};

export type StreamStoreSlice = {
  activeChatId: string | null;
  activeChat: ChatDocument | null;
  chats: ChatMeta[];
  projects: Project[];
  inflightChatId: string | null;
};

type SetFn = (
  partial:
    | Partial<{ activeChat: ChatDocument | null }>
    | ((s: StreamStoreSlice) => Partial<{ activeChat: ChatDocument | null }>),
) => void;
type GetFn = () => StreamStoreSlice;

const pendingBatches: PendingBatch[] = [];
let applyDrainRunning = false;
let applyDrainPromise: Promise<void> = Promise.resolve();
let pendingUiChat: ChatDocument | null = null;
let uiRaf: number | null = null;

const URGENT_KINDS = new Set([
  "tool_call",
  "subagent_spawned",
  "subagent_finished",
  "task_backgrounded",
  "task_completed",
  "turn_completed",
  "plan",
]);

function flushPendingUiChat(set: SetFn, get: GetFn) {
  if (uiRaf != null) {
    cancelAnimationFrame(uiRaf);
    uiRaf = null;
  }
  const chat = pendingUiChat;
  pendingUiChat = null;
  if (!chat) return;
  if (get().activeChatId === chat.id) {
    set({ activeChat: chat });
  }
}

function scheduleUiChat(
  chat: ChatDocument,
  set: SetFn,
  get: GetFn,
  immediate = false,
) {
  pendingUiChat = chat;
  if (immediate) {
    flushPendingUiChat(set, get);
    return;
  }
  if (uiRaf != null) return;
  uiRaf = requestAnimationFrame(() => {
    uiRaf = null;
    flushPendingUiChat(set, get);
  });
}

function chatEnvId(get: GetFn, chatId: string): string | null {
  const meta = get().chats.find((c) => c.id === chatId);
  const projectId =
    meta?.projectId ??
    (get().activeChat?.id === chatId ? get().activeChat?.projectId : null);
  if (!projectId) return null;
  const project = get().projects.find((p) => p.id === projectId);
  return project?.environmentId || LOCAL_ENV_ID;
}

export function resolveChatIdForSession(
  get: GetFn,
  sessionId: string,
  environmentId?: string | null,
): string | null {
  const envMatches = (chatId: string) => {
    if (!environmentId) return true;
    const chatEnv = chatEnvId(get, chatId);
    return !chatEnv || chatEnv === environmentId;
  };

  const bySession = get().chats.find(
    (c) => c.acpSessionId === sessionId && envMatches(c.id),
  );
  if (bySession) return bySession.id;
  const active = get().activeChat;
  if (active?.acpSessionId === sessionId && envMatches(active.id)) {
    return active.id;
  }
  const inflight = get().inflightChatId;
  if (inflight && envMatches(inflight)) {
    const meta = get().chats.find((c) => c.id === inflight);
    const live = get().activeChat?.id === inflight ? get().activeChat : null;
    const known = live?.acpSessionId ?? meta?.acpSessionId ?? null;
    if (!known || known === sessionId) return inflight;
  }
  return null;
}

function updateKind(update: unknown): string {
  if (update && typeof update === "object" && "sessionUpdate" in update) {
    return String((update as { sessionUpdate?: string }).sessionUpdate ?? "");
  }
  return "";
}

export function enqueueSessionUpdate(
  sessionId: string,
  update: unknown,
  environmentId?: string,
) {
  const last = pendingBatches[pendingBatches.length - 1];
  if (
    last &&
    last.sessionId === sessionId &&
    (last.environmentId ?? "") === (environmentId ?? "")
  ) {
    last.updates.push(update);
    return;
  }
  pendingBatches.push({ sessionId, environmentId, updates: [update] });
}

export function drainSessionApplies(set: SetFn, get: GetFn): Promise<void> {
  if (applyDrainRunning) return applyDrainPromise;
  applyDrainRunning = true;
  applyDrainPromise = (async () => {
    try {
      while (pendingBatches.length > 0) {
        const batch = pendingBatches.shift()!;
        while (
          pendingBatches.length > 0 &&
          pendingBatches[0].sessionId === batch.sessionId &&
          (pendingBatches[0].environmentId ?? "") === (batch.environmentId ?? "")
        ) {
          batch.updates.push(...pendingBatches.shift()!.updates);
        }
        if (batch.updates.length === 0) continue;

        const targetId = resolveChatIdForSession(
          get,
          batch.sessionId,
          batch.environmentId,
        );
        if (!targetId) continue;

        try {
          const updated = await invoke<ChatDocument>("apply_session_updates", {
            chatId: targetId,
            updates: batch.updates,
            sessionId: batch.sessionId,
          });
          if (get().activeChatId !== updated.id) continue;

          const urgent = batch.updates.some((u) =>
            URGENT_KINDS.has(updateKind(u)),
          );
          const morePending = pendingBatches.length > 0;
          scheduleUiChat(updated, set, get, urgent || !morePending);
        } catch (err) {
          console.error("apply_session_updates failed", err);
        }
      }
    } finally {
      applyDrainRunning = false;
      if (pendingBatches.length === 0 && pendingUiChat) {
        flushPendingUiChat(set, get);
      }
    }
    if (pendingBatches.length > 0) {
      await drainSessionApplies(set, get);
    }
  })();
  return applyDrainPromise;
}

/** Wait until all buffered stream applies have hit Rust + painted. */
export async function waitForApplyDrain(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    await applyDrainPromise;
    if (!applyDrainRunning && pendingBatches.length === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}
