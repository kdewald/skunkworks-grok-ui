/**
 * Per-chat send-slot ownership, stuck-slot heal, and dispatchSend.
 *
 * Backend enforces one in-flight prompt per chat; the frontend mirrors that
 * so independent chats can stream concurrently (no global send mutex).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  normalizeAgentBackend,
  type AgentBackend,
  type AgentRuntime,
  type ChatDocument,
  type ChatMeta,
  type Project,
} from "../types";

export type QueuedAttachment = {
  kind: string;
  data: string;
  mimeType: string;
  name?: string;
  dataUrl?: string;
};

/** In-flight prompt claim for a single chat. */
export type InflightPrompt = {
  turnId: string | null;
  generation: number;
};

export type InflightPrompts = Record<string, InflightPrompt>;

export type SendStoreSlice = {
  /** UI op lock (connect, create chat, etc.) — not the send/stream mutex. */
  busy: boolean;
  activeChat: ChatDocument | null;
  activeChatId: string | null;
  /** Per-chat send slots. Multiple chats may stream at once. */
  inflightPrompts: InflightPrompts;
  chats: ChatMeta[];
  projects: Project[];
  activeProjectId: string | null;
  activeEnvironmentId: string;
  connectedEnvironments: string[];
  connectedRuntimes: AgentRuntime[];
  error: string | null;
  connectAgent: (
    environmentId?: string,
    backend?: AgentBackend,
  ) => Promise<void>;
  isRuntimeConnected: (
    environmentId: string,
    backend: AgentBackend,
  ) => boolean;
};

type Get = () => SendStoreSlice;
type Set = (
  partial:
    | Partial<SendStoreSlice>
    | ((s: SendStoreSlice) => Partial<SendStoreSlice>),
) => void;

/** Monotonic client generation for send slot ownership. */
let sendGeneration = 0;

export function queueId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type InflightSource =
  | Pick<SendStoreSlice, "inflightPrompts">
  | (() => Pick<SendStoreSlice, "inflightPrompts">);

type ActiveChatSource =
  | Pick<SendStoreSlice, "activeChat">
  | (() => Pick<SendStoreSlice, "activeChat">);

type SendBusySource =
  | Pick<SendStoreSlice, "inflightPrompts" | "activeChat">
  | (() => Pick<SendStoreSlice, "inflightPrompts" | "activeChat">);

function resolveInflightPrompts(source: InflightSource | SendBusySource): InflightPrompts {
  return typeof source === "function"
    ? source().inflightPrompts
    : source.inflightPrompts;
}

function resolveActiveChat(
  source: ActiveChatSource | SendBusySource,
): ChatDocument | null {
  return typeof source === "function" ? source().activeChat : source.activeChat;
}

export function isChatInflight(
  source: InflightSource | SendBusySource,
  chatId: string | null | undefined,
): boolean {
  return !!chatId && chatId in resolveInflightPrompts(source);
}

export function getInflight(
  source: InflightSource | SendBusySource,
  chatId: string | null | undefined,
): InflightPrompt | null {
  if (!chatId) return null;
  return resolveInflightPrompts(source)[chatId] ?? null;
}

/** True when the active chat has a streaming turn painted in the UI. */
export function isActivelyStreaming(
  source: ActiveChatSource,
  chatId?: string | null,
): boolean {
  const active = resolveActiveChat(source);
  if (!active) return false;
  if (chatId != null && active.id !== chatId) return false;
  return active.turns.some((t) => t.status === "streaming");
}

/**
 * Send/composer busy for a chat: owns a slot, or (when viewing it) is streaming.
 */
export function isChatSendBusy(
  source: SendBusySource,
  chatId: string | null | undefined,
): boolean {
  if (!chatId) return false;
  if (chatId in resolveInflightPrompts(source)) return true;
  return isActivelyStreaming(source, chatId);
}

export function withoutInflight(
  prompts: InflightPrompts,
  chatId: string,
): InflightPrompts {
  if (!(chatId in prompts)) return prompts;
  const next = { ...prompts };
  delete next[chatId];
  return next;
}

export function withInflight(
  prompts: InflightPrompts,
  chatId: string,
  slot: InflightPrompt,
): InflightPrompts {
  return { ...prompts, [chatId]: slot };
}

/**
 * Clear a stuck send slot for one chat: has inflight claim but no live stream.
 * Only with force from explicit user send / delayed watchdog.
 */
export function healStuckBusy(
  set: (partial: Partial<SendStoreSlice>) => void,
  get: () => Pick<
    SendStoreSlice,
    "activeChat" | "activeChatId" | "inflightPrompts"
  >,
  opts: { force?: boolean; chatId?: string | null } = {},
): boolean {
  if (!opts.force) return false;
  const chatId = opts.chatId ?? get().activeChatId;
  if (!chatId) return false;
  if (!(chatId in get().inflightPrompts)) return false;
  if (isActivelyStreaming(get, chatId)) return false;
  set({
    inflightPrompts: withoutInflight(get().inflightPrompts, chatId),
  });
  return true;
}

/** True when a queue head error looks transient (re-queue + retry). */
export function isRetriableQueueError(err: string): boolean {
  return /settling after cancel|in-flight prompt|try again/i.test(err);
}

/**
 * Whether a prompt-finished event should release this chat's send slot.
 * Backend is one-prompt-per-chat; turnId guards against a late finish for an
 * older turn after a newer send claimed the slot.
 */
export function isMatchingInflightFinish(
  slot: InflightPrompt | null | undefined,
  finishedTurnId: string | null | undefined,
): boolean {
  if (!slot) return false;
  if (slot.turnId != null) {
    // Prefer exact match; also accept null finishedTurnId as a soft release
    // when the backend omitted it (should be rare).
    return finishedTurnId == null || finishedTurnId === slot.turnId;
  }
  // Slot claimed but turn id not yet adopted from send_message / chat-updated.
  // Accept finishes with or without turnId so a fast prompt cannot brick the slot.
  return true;
}

export async function dispatchSend(
  get: Get,
  set: Set,
  chatId: string,
  text: string,
  attachments: QueuedAttachment[] = [],
) {
  const generation = ++sendGeneration;
  set({
    inflightPrompts: withInflight(get().inflightPrompts, chatId, {
      turnId: null,
      generation,
    }),
    error: null,
  });

  const targetMeta = get().chats.find((c) => c.id === chatId);
  const project = get().projects.find(
    (p) =>
      p.id ===
      (targetMeta?.projectId ||
        get().activeChat?.projectId ||
        get().activeProjectId),
  );
  const envId = project?.environmentId || get().activeEnvironmentId;
  const backend = normalizeAgentBackend(
    targetMeta?.backend ??
      (get().activeChat?.id === chatId ? get().activeChat?.backend : null),
  );
  try {
    if (!get().isRuntimeConnected(envId, backend)) {
      await get().connectAgent(envId, backend);
    }
    const rawChat = await invoke<ChatDocument>("send_message", {
      args: {
        chatId,
        text,
        attachments: attachments.map((a) => ({
          kind: a.kind,
          data: a.data,
          mimeType: a.mimeType,
          name: a.name ?? null,
          dataUrl: a.dataUrl ?? null,
        })),
        images: [],
      },
    });
    const chat = {
      ...rawChat,
      backend: normalizeAgentBackend(rawChat.backend ?? backend),
    };
    const streamingTurn = [...chat.turns]
      .reverse()
      .find((t) => t.status === "streaming");
    const stillStreaming = !!streamingTurn;
    const stillViewing = get().activeChatId === chatId;
    const current = get().inflightPrompts[chatId];
    if (!current || current.generation !== generation) {
      return;
    }
    if (stillStreaming) {
      set({
        activeChat: stillViewing ? chat : get().activeChat,
        inflightPrompts: withInflight(get().inflightPrompts, chatId, {
          turnId: streamingTurn?.id ?? null,
          generation,
        }),
        chats: get().chats.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                title: chat.title,
                updatedAt: chat.updatedAt,
                preview: (text || "Attachment").slice(0, 120),
                acpSessionId: chat.acpSessionId,
                backend: chat.backend,
              }
            : c,
        ),
      });
    } else {
      set({
        activeChat: stillViewing ? chat : get().activeChat,
        inflightPrompts: withoutInflight(get().inflightPrompts, chatId),
        chats: get().chats.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                title: chat.title,
                updatedAt: chat.updatedAt,
                preview: (text || "Attachment").slice(0, 120),
                acpSessionId: chat.acpSessionId,
                backend: chat.backend,
              }
            : c,
        ),
      });
    }
  } catch (e) {
    const current = get().inflightPrompts[chatId];
    if (current?.generation === generation) {
      set({
        error: String(e),
        inflightPrompts: withoutInflight(get().inflightPrompts, chatId),
      });
    }
    throw e;
  }
}
