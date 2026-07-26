/**
 * Send-slot ownership, stuck-busy heal, and dispatchSend.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ChatDocument, ChatMeta, Project } from "../types";

export type QueuedAttachment = {
  kind: string;
  data: string;
  mimeType: string;
  name?: string;
  dataUrl?: string;
};

export type SendStoreSlice = {
  busy: boolean;
  activeChat: ChatDocument | null;
  activeChatId: string | null;
  inflightChatId: string | null;
  inflightTurnId: string | null;
  inflightGeneration: number | null;
  chats: ChatMeta[];
  projects: Project[];
  activeProjectId: string | null;
  activeEnvironmentId: string;
  connectedEnvironments: string[];
  error: string | null;
  connectAgent: (environmentId?: string) => Promise<void>;
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

export function isActivelyStreaming(
  get: () => Pick<SendStoreSlice, "activeChat">,
): boolean {
  return !!get().activeChat?.turns.some((t) => t.status === "streaming");
}

/**
 * Clear a stuck composer lock: busy without streaming and without inflight.
 * Only with force from explicit user send / delayed watchdog.
 */
export function healStuckBusy(
  set: (partial: Partial<SendStoreSlice>) => void,
  get: () => Pick<
    SendStoreSlice,
    "busy" | "activeChat" | "activeChatId" | "inflightChatId" | "inflightTurnId"
  >,
  opts: { force?: boolean } = {},
): boolean {
  if (!opts.force) return false;
  if (!get().busy) return false;
  if (get().inflightChatId != null) return false;
  if (isActivelyStreaming(get)) return false;
  set({
    busy: false,
    inflightChatId: null,
    inflightTurnId: null,
    inflightGeneration: null,
  });
  return true;
}

/** True when a queue head error looks transient (re-queue + retry). */
export function isRetriableQueueError(err: string): boolean {
  return /settling after cancel|in-flight prompt|try again/i.test(err);
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
    busy: true,
    inflightChatId: chatId,
    inflightTurnId: null,
    inflightGeneration: generation,
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
  try {
    if (!get().connectedEnvironments.includes(envId)) {
      await get().connectAgent(envId);
    }
    const chat = await invoke<ChatDocument>("send_message", {
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
    const streamingTurn = [...chat.turns]
      .reverse()
      .find((t) => t.status === "streaming");
    const stillStreaming = !!streamingTurn;
    const stillViewing = get().activeChatId === chatId;
    if (get().inflightGeneration !== generation) {
      return;
    }
    set({
      activeChat: stillViewing ? chat : get().activeChat,
      busy: stillStreaming,
      inflightChatId: stillStreaming ? chatId : null,
      inflightTurnId: stillStreaming ? streamingTurn?.id ?? null : null,
      inflightGeneration: stillStreaming ? generation : null,
      chats: get().chats.map((c) =>
        c.id === chat.id
          ? {
              ...c,
              title: chat.title,
              updatedAt: chat.updatedAt,
              preview: (text || "Attachment").slice(0, 120),
              acpSessionId: chat.acpSessionId,
            }
          : c,
      ),
    });
  } catch (e) {
    if (get().inflightGeneration === generation) {
      set({
        error: String(e),
        busy: false,
        inflightChatId: null,
        inflightTurnId: null,
        inflightGeneration: null,
      });
    }
    throw e;
  }
}
