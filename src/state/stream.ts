/**
 * Session-update stream apply pipeline (buffer → batch IPC → rAF paint).
 * Owns module-level queue state; store wires set/get.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  LOCAL_ENV_ID,
  normalizeAgentBackend,
  type AgentBackend,
  type ChatDocument,
  type ChatMeta,
  type Project,
} from "../types";

type PendingBatch = {
  sessionId: string;
  environmentId?: string;
  backend: AgentBackend;
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
let deferredDrainTimer: number | null = null;

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

function chatBackend(get: GetFn, chatId: string): AgentBackend {
  const meta = get().chats.find((c) => c.id === chatId);
  const document =
    get().activeChat?.id === chatId ? get().activeChat : null;
  return normalizeAgentBackend(meta?.backend ?? document?.backend);
}

export function resolveChatIdForSession(
  get: GetFn,
  sessionId: string,
  environmentId?: string | null,
  backend?: AgentBackend | null,
): string | null {
  const targetBackend = normalizeAgentBackend(backend);
  const envMatches = (chatId: string) => {
    if (!environmentId) return true;
    const chatEnv = chatEnvId(get, chatId);
    return !chatEnv || chatEnv === environmentId;
  };
  const runtimeMatches = (chatId: string) =>
    envMatches(chatId) && chatBackend(get, chatId) === targetBackend;

  const bySession = get().chats.find(
    (c) => c.acpSessionId === sessionId && runtimeMatches(c.id),
  );
  if (bySession) return bySession.id;
  const active = get().activeChat;
  if (active?.acpSessionId === sessionId && runtimeMatches(active.id)) {
    return active.id;
  }
  if (
    active &&
    runtimeMatches(active.id) &&
    active.turns.some((turn) =>
      turn.intermediate.some(
        (block) =>
          block.type === "subagent" && block.subagentId === sessionId,
      ),
    )
  ) {
    return active.id;
  }
  const inflight = get().inflightChatId;
  if (inflight && runtimeMatches(inflight)) {
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

function isChildSession(get: GetFn, chatId: string, sessionId: string) {
  const active = get().activeChat;
  return (
    active?.id === chatId &&
    active.turns.some((turn) =>
      turn.intermediate.some(
        (block) =>
          block.type === "subagent" && block.subagentId === sessionId,
      ),
    )
  );
}

export function enqueueSessionUpdate(
  sessionId: string,
  update: unknown,
  environmentId?: string,
  backend?: AgentBackend,
) {
  const normalizedBackend = normalizeAgentBackend(backend);
  const last = pendingBatches[pendingBatches.length - 1];
  if (
    last &&
    last.sessionId === sessionId &&
    (last.environmentId ?? "") === (environmentId ?? "") &&
    last.backend === normalizedBackend
  ) {
    last.updates.push(update);
    return;
  }
  pendingBatches.push({
    sessionId,
    environmentId,
    backend: normalizedBackend,
    updates: [update],
  });
}

/** Child history replays can contain thousands of inherited parent updates. */
export function scheduleSessionApplies(
  set: SetFn,
  get: GetFn,
  sessionId: string,
) {
  const active = get().activeChat;
  const childSession =
    active != null && isChildSession(get, active.id, sessionId);
  if (!childSession) {
    void drainSessionApplies(set, get);
    return;
  }
  if (deferredDrainTimer != null) {
    window.clearTimeout(deferredDrainTimer);
  }
  deferredDrainTimer = window.setTimeout(() => {
    deferredDrainTimer = null;
    void drainSessionApplies(set, get);
  }, 500);
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
          (pendingBatches[0].environmentId ?? "") ===
            (batch.environmentId ?? "") &&
          pendingBatches[0].backend === batch.backend
        ) {
          batch.updates.push(...pendingBatches.shift()!.updates);
        }
        if (batch.updates.length === 0) continue;

        const targetId = resolveChatIdForSession(
          get,
          batch.sessionId,
          batch.environmentId,
          batch.backend,
        );
        if (!targetId) continue;

        if (isChildSession(get, targetId, batch.sessionId)) {
          // A Codex child fork replays the inherited parent turns first. Keep
          // only the latest turn in this buffered history batch.
          let lastUserTurn = -1;
          batch.updates.forEach((update, index) => {
            if (updateKind(update) === "user_message_chunk") {
              lastUserTurn = index;
            }
          });
          if (lastUserTurn > 0) {
            batch.updates = batch.updates.slice(lastUserTurn);
          }
        }

        try {
          const rawUpdated = await invoke<ChatDocument>("apply_session_updates", {
            chatId: targetId,
            updates: batch.updates,
            sessionId: batch.sessionId,
          });
          const updated = {
            ...rawUpdated,
            backend: normalizeAgentBackend(
              rawUpdated.backend ?? batch.backend,
            ),
          };
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
    if (
      !applyDrainRunning &&
      pendingBatches.length === 0 &&
      deferredDrainTimer == null
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}
