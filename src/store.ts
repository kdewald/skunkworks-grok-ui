import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentStatus,
  AppData,
  ChatDocument,
  ChatMeta,
  Environment,
  PermissionRequest,
  Project,
} from "./types";
import { LOCAL_ENV_ID, SCRATCH_PROJECT_ID, scratchProjectIdForEnv } from "./types";

/**
 * Stream apply path:
 * - Buffer every session-update in memory (no per-token IPC).
 * - Drain with one `apply_session_updates` invoke per batch.
 * - Paint React only on rAF / after drain so UI doesn't drip after the agent is done.
 */
type PendingBatch = { sessionId: string; updates: unknown[] };
const pendingBatches: PendingBatch[] = [];
let applyDrainRunning = false;
let applyDrainPromise: Promise<void> = Promise.resolve();
/** Latest chat doc waiting to paint. */
let pendingUiChat: ChatDocument | null = null;
let uiRaf: number | null = null;

function flushPendingUiChat(
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
) {
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

/** Coalesce paints to one frame while streaming; force-paint when drain ends. */
function scheduleUiChat(
  chat: ChatDocument,
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
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

function resolveChatIdForSession(
  get: () => AppStore,
  sessionId: string,
): string | null {
  const bySession = get().chats.find((c) => c.acpSessionId === sessionId);
  if (bySession) return bySession.id;
  const active = get().activeChat;
  if (active?.acpSessionId === sessionId) return active.id;
  if (active) return active.id;
  return null;
}

function updateKind(update: unknown): string {
  if (update && typeof update === "object" && "sessionUpdate" in update) {
    return String((update as { sessionUpdate?: string }).sessionUpdate ?? "");
  }
  return "";
}

const URGENT_KINDS = new Set([
  "tool_call",
  "subagent_spawned",
  "subagent_finished",
  "task_backgrounded",
  "task_completed",
  "turn_completed",
  "plan",
]);

function enqueueSessionUpdate(sessionId: string, update: unknown) {
  const last = pendingBatches[pendingBatches.length - 1];
  if (last && last.sessionId === sessionId) {
    last.updates.push(update);
    return;
  }
  pendingBatches.push({ sessionId, updates: [update] });
}

function drainSessionApplies(
  set: (partial: Partial<AppStore> | ((s: AppStore) => Partial<AppStore>)) => void,
  get: () => AppStore,
): Promise<void> {
  // Coalesce concurrent kicks onto the in-flight promise so waiters see the full drain.
  if (applyDrainRunning) return applyDrainPromise;
  applyDrainRunning = true;
  applyDrainPromise = (async () => {
    try {
      while (pendingBatches.length > 0) {
        // Take the front batch; fold any same-session batches that piled up mid-IPC.
        const batch = pendingBatches.shift()!;
        while (
          pendingBatches.length > 0 &&
          pendingBatches[0].sessionId === batch.sessionId
        ) {
          batch.updates.push(...pendingBatches.shift()!.updates);
        }
        if (batch.updates.length === 0) continue;

        const targetId = resolveChatIdForSession(get, batch.sessionId);
        if (!targetId) continue;

        try {
          const updated = await invoke<ChatDocument>("apply_session_updates", {
            chatId: targetId,
            updates: batch.updates,
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
    // Batches may have been enqueued after we cleared the running flag.
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

export type QueuedAttachment = {
  kind: string;
  data: string;
  mimeType: string;
  name?: string;
  dataUrl?: string;
};

export type QueuedMessage = {
  id: string;
  chatId: string;
  text: string;
  attachments: QueuedAttachment[];
};

type AppStore = {
  ready: boolean;
  dataDir: string;
  agent: AgentStatus;
  environments: Environment[];
  activeEnvironmentId: string;
  connectedEnvironments: string[];
  sshHosts: string[];
  projects: Project[];
  chats: ChatMeta[];
  activeProjectId: string | null;
  activeChatId: string | null;
  activeChat: ChatDocument | null;
  permission: PermissionRequest | null;
  busy: boolean;
  error: string | null;
  logs: string[];
  connectionsOpen: boolean;
  /** Follow-ups typed while a turn is still running (FIFO per chat). */
  messageQueue: QueuedMessage[];

  bootstrap: () => Promise<void>;
  connectAgent: (environmentId?: string) => Promise<void>;
  disconnectAgent: (environmentId?: string) => Promise<void>;
  setActiveEnvironment: (environmentId: string) => Promise<void>;
  addSshEnvironment: (
    host: string,
    name?: string,
    remoteGrokPath?: string,
  ) => Promise<void>;
  removeEnvironment: (environmentId: string) => Promise<void>;
  refreshSshHosts: () => Promise<void>;
  setConnectionsOpen: (open: boolean) => void;
  addProject: (path: string, environmentId?: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  selectProject: (projectId: string) => Promise<void>;
  createChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  sendMessage: (
    text: string,
    attachments?: QueuedAttachment[],
  ) => Promise<void>;
  /** Drain next queued follow-up for a chat after a turn ends. */
  flushMessageQueue: (chatId?: string) => Promise<void>;
  removeQueuedMessage: (id: string) => void;
  clearMessageQueue: (chatId?: string) => void;
  cancelPrompt: () => Promise<void>;
  refreshChat: (chatId?: string) => Promise<void>;
  applySessionUpdate: (sessionId: string, update: unknown) => Promise<void>;
  setTurnCollapsed: (turnId: string, collapsed: boolean) => Promise<void>;
  setBlockCollapsed: (
    turnId: string,
    blockId: string,
    collapsed: boolean,
  ) => Promise<void>;
  respondPermission: (optionId: string | null, cancelled?: boolean) => Promise<void>;
  setPermission: (p: PermissionRequest | null) => void;
  pushLog: (msg: string) => void;
  setAgentStatus: (s: Partial<AgentStatus>) => void;
  isEnvConnected: (environmentId: string) => boolean;
};

function queueId() {
  return `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type Get = () => AppStore;
type Set = (
  partial:
    | Partial<AppStore>
    | ((state: AppStore) => Partial<AppStore>),
) => void;

async function dispatchSend(
  get: Get,
  set: Set,
  chatId: string,
  text: string,
  attachments: QueuedAttachment[] = [],
) {
  const project = get().projects.find(
    (p) => p.id === (get().activeChat?.projectId || get().activeProjectId),
  );
  const envId = project?.environmentId || get().activeEnvironmentId;
  if (!get().connectedEnvironments.includes(envId)) {
    await get().connectAgent(envId);
  }
  set({ busy: true, error: null });
  try {
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
    set({
      activeChat: chat,
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
    set({ error: String(e), busy: false });
    throw e;
  }
}

function chatsForProject(chats: ChatMeta[], projectId: string | null) {
  if (!projectId) return [];
  return chats
    .filter((c) => c.projectId === projectId)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

function projectsForEnv(projects: Project[], environmentId: string) {
  return projects.filter(
    (p) => (p.environmentId || LOCAL_ENV_ID) === environmentId,
  );
}

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  dataDir: "",
  agent: { connected: false, message: "Not connected" },
  environments: [],
  activeEnvironmentId: LOCAL_ENV_ID,
  connectedEnvironments: [],
  sshHosts: [],
  projects: [],
  chats: [],
  activeProjectId: null,
  activeChatId: null,
  activeChat: null,
  permission: null,
  busy: false,
  error: null,
  logs: [],
  connectionsOpen: false,
  messageQueue: [],

  isEnvConnected: (environmentId: string) =>
    get().connectedEnvironments.includes(environmentId),

  bootstrap: async () => {
    try {
      const res = await invoke<{
        data: AppData;
        dataDir: string;
        agentConnected: boolean;
        connectedEnvironments: string[];
        activeEnvironmentId: string;
        sshHosts: string[];
      }>("get_bootstrap");
      const activeEnv =
        res.activeEnvironmentId ||
        res.data.activeEnvironmentId ||
        LOCAL_ENV_ID;
      const connected = res.connectedEnvironments ?? [];
      set({
        ready: true,
        dataDir: res.dataDir,
        environments: res.data.environments ?? [],
        activeEnvironmentId: activeEnv,
        connectedEnvironments: connected,
        sshHosts: res.sshHosts ?? [],
        projects: res.data.projects ?? [],
        chats: res.data.chats ?? [],
        activeProjectId: res.data.activeProjectId ?? null,
        activeChatId: res.data.activeChatId ?? null,
        agent: {
          connected: connected.includes(activeEnv),
          message: connected.includes(activeEnv)
            ? "Connected"
            : "Not connected",
          environmentId: activeEnv,
        },
      });
      if (res.data.activeChatId) {
        await get().refreshChat(res.data.activeChatId);
      }
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  connectAgent: async (environmentId?: string) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    set({ busy: true, error: null });
    try {
      const res = await invoke<{
        environmentId: string;
        message: string;
      }>("connect_agent", { environmentId: envId });
      const connectedEnv = res.environmentId || envId;
      const connected = Array.from(
        new Set([...get().connectedEnvironments, connectedEnv]),
      );
      set({
        connectedEnvironments: connected,
        activeEnvironmentId: connectedEnv,
        agent: {
          connected: true,
          message: res.message || "Connected to Grok agent",
          environmentId: connectedEnv,
        },
        busy: false,
      });
    } catch (e) {
      set({
        agent: {
          connected: false,
          message: String(e),
          environmentId: envId,
        },
        error: String(e),
        busy: false,
        connectedEnvironments: get().connectedEnvironments.filter(
          (id) => id !== envId,
        ),
      });
      throw e;
    }
  },

  disconnectAgent: async (environmentId?: string) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    await invoke("disconnect_agent", { environmentId: envId });
    const connected = get().connectedEnvironments.filter((id) => id !== envId);
    set({
      connectedEnvironments: connected,
      agent: {
        connected: connected.includes(get().activeEnvironmentId),
        message: `Disconnected (${envId})`,
        environmentId: envId,
      },
    });
  },

  setActiveEnvironment: async (environmentId: string) => {
    const data = await invoke<AppData>("set_active_environment", {
      environmentId,
    });
    const envId = data.activeEnvironmentId || environmentId;
    set({
      environments: data.environments ?? get().environments,
      projects: data.projects ?? get().projects,
      chats: data.chats ?? get().chats,
      activeEnvironmentId: envId,
      activeProjectId: data.activeProjectId ?? null,
      activeChatId: data.activeChatId ?? null,
      agent: {
        ...get().agent,
        connected: get().connectedEnvironments.includes(envId),
        environmentId: envId,
        message: get().connectedEnvironments.includes(envId)
          ? get().agent.message
          : "Not connected",
      },
    });
    if (data.activeChatId) {
      await get().refreshChat(data.activeChatId);
    } else {
      set({ activeChat: null });
    }
  },

  addSshEnvironment: async (host, name, remoteGrokPath) => {
    set({ busy: true, error: null });
    try {
      const env = await invoke<Environment>("add_ssh_environment", {
        host,
        name: name ?? null,
        remoteGrokPath: remoteGrokPath ?? null,
      });
      const environments = [
        ...get().environments.filter((e) => e.id !== env.id),
        env,
      ];
      // Re-bootstrap projects (scratch for new env)
      const boot = await invoke<{
        data: AppData;
        connectedEnvironments: string[];
        activeEnvironmentId: string;
        sshHosts: string[];
      }>("get_bootstrap");
      set({
        environments: boot.data.environments ?? environments,
        projects: boot.data.projects ?? get().projects,
        sshHosts: boot.sshHosts ?? get().sshHosts,
        busy: false,
      });
      await get().setActiveEnvironment(env.id);
      await get().connectAgent(env.id);
    } catch (e) {
      set({ error: String(e), busy: false });
      throw e;
    }
  },

  removeEnvironment: async (environmentId: string) => {
    if (environmentId === LOCAL_ENV_ID) {
      throw new Error("Cannot remove the local environment");
    }
    await invoke("remove_environment", { environmentId });
    const environments = get().environments.filter((e) => e.id !== environmentId);
    const projects = get().projects.filter(
      (p) => (p.environmentId || LOCAL_ENV_ID) !== environmentId,
    );
    const projectIds = new Set(
      get()
        .projects.filter(
          (p) => (p.environmentId || LOCAL_ENV_ID) === environmentId,
        )
        .map((p) => p.id),
    );
    const chats = get().chats.filter((c) => !projectIds.has(c.projectId));
    const connectedEnvironments = get().connectedEnvironments.filter(
      (id) => id !== environmentId,
    );
    const activeEnvironmentId =
      get().activeEnvironmentId === environmentId
        ? LOCAL_ENV_ID
        : get().activeEnvironmentId;
    set({
      environments,
      projects,
      chats,
      connectedEnvironments,
      activeEnvironmentId,
      activeProjectId:
        get().activeProjectId && projectIds.has(get().activeProjectId!)
          ? SCRATCH_PROJECT_ID
          : get().activeProjectId,
      activeChatId:
        get().activeChat && projectIds.has(get().activeChat!.projectId)
          ? null
          : get().activeChatId,
      activeChat:
        get().activeChat && projectIds.has(get().activeChat!.projectId)
          ? null
          : get().activeChat,
      agent: {
        connected: connectedEnvironments.includes(activeEnvironmentId),
        message: connectedEnvironments.includes(activeEnvironmentId)
          ? "Connected"
          : "Not connected",
        environmentId: activeEnvironmentId,
      },
    });
  },

  refreshSshHosts: async () => {
    const hosts = await invoke<string[]>("list_ssh_hosts");
    set({ sshHosts: hosts });
  },

  setConnectionsOpen: (open) => set({ connectionsOpen: open }),

  addProject: async (path: string, environmentId?: string) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    const project = await invoke<Project>("add_project", {
      path,
      environmentId: envId,
    });
    const projects = [
      ...get().projects.filter((p) => p.id !== project.id),
      project,
    ];
    set({
      projects,
      activeProjectId: project.id,
      activeEnvironmentId: project.environmentId || envId,
    });
    await invoke("set_active_project", { projectId: project.id });
  },

  removeProject: async (projectId: string) => {
    if (
      projectId === SCRATCH_PROJECT_ID ||
      projectId.startsWith("scratch:")
    ) {
      throw new Error("Scratch workspace can't be removed");
    }
    await invoke("remove_project", { projectId });
    const projects = get().projects.filter((p) => p.id !== projectId);
    const chats = get().chats.filter((c) => c.projectId !== projectId);
    const envId = get().activeEnvironmentId;
    const activeProjectId =
      get().activeProjectId === projectId
        ? scratchProjectIdForEnv(envId)
        : get().activeProjectId;
    set({
      projects,
      chats,
      activeProjectId,
      activeChatId:
        get().activeChat?.projectId === projectId ? null : get().activeChatId,
      activeChat:
        get().activeChat?.projectId === projectId ? null : get().activeChat,
    });
  },

  selectProject: async (projectId: string) => {
    const project = get().projects.find((p) => p.id === projectId);
    const envId = project?.environmentId || get().activeEnvironmentId;
    if (envId !== get().activeEnvironmentId) {
      await get().setActiveEnvironment(envId);
    }
    await invoke("set_active_project", { projectId });
    set({ activeProjectId: projectId, activeEnvironmentId: envId });
    // Auto-connect if needed for this env
    if (!get().connectedEnvironments.includes(envId)) {
      try {
        await get().connectAgent(envId);
      } catch {
        // status shows error
      }
    }
    const first = chatsForProject(get().chats, projectId)[0];
    if (first) {
      await get().selectChat(first.id);
    } else {
      // Leaving an unused draft behind when switching projects.
      const prevId = get().activeChatId;
      const prevEmpty =
        get().activeChat?.id === prevId &&
        (get().activeChat?.turns.length ?? 0) === 0;
      try {
        const discarded = await invoke<string | null>("set_active_chat", {
          chatId: null,
        });
        const dropId = discarded ?? (prevEmpty ? prevId : null);
        set({
          chats: dropId
            ? get().chats.filter((c) => c.id !== dropId)
            : get().chats,
          activeChatId: null,
          activeChat: null,
        });
      } catch {
        set({ activeChatId: null, activeChat: null });
      }
    }
  },

  createChat: async () => {
    const projectId =
      get().activeProjectId ??
      scratchProjectIdForEnv(get().activeEnvironmentId);
    const project = get().projects.find((p) => p.id === projectId);
    const envId = project?.environmentId || get().activeEnvironmentId;
    if (!get().connectedEnvironments.includes(envId)) {
      await get().connectAgent(envId);
    }
    // Already on an unused draft for this project — keep it.
    const cur = get().activeChat;
    if (
      cur &&
      cur.projectId === projectId &&
      cur.turns.length === 0 &&
      get().activeChatId === cur.id
    ) {
      return;
    }
    const prevId = get().activeChatId;
    set({ busy: true, error: null });
    try {
      const chat = await invoke<ChatDocument>("create_chat", {
        projectId,
        title: null,
      });
      const meta: ChatMeta = {
        id: chat.id,
        projectId: chat.projectId,
        title: chat.title,
        acpSessionId: chat.acpSessionId,
        preview: null,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      };
      // Drop the previous empty draft from the sidebar if backend discarded it.
      let chats = get().chats.filter((c) => c.id !== meta.id);
      if (prevId && prevId !== chat.id) {
        const prev = get().activeChat;
        if (prev?.id === prevId && prev.turns.length === 0) {
          chats = chats.filter((c) => c.id !== prevId);
        } else if (
          get().chats.find((c) => c.id === prevId && !c.preview && c.title === "New chat")
        ) {
          // Backend may have purged an empty draft we only know via meta.
          chats = chats.filter((c) => c.id !== prevId);
        }
      }
      set({
        chats: [meta, ...chats],
        activeProjectId: chat.projectId,
        activeChatId: chat.id,
        activeChat: chat,
        busy: false,
      });
    } catch (e) {
      set({ error: String(e), busy: false });
      throw e;
    }
  },

  selectChat: async (chatId: string) => {
    // Optimistic: switch the UI immediately so a slow ensure/session/load
    // (or a late chat-updated for another chat) can't leave the old transcript up.
    const prevId = get().activeChatId;
    const prevWasEmpty =
      get().activeChat?.id === prevId &&
      (get().activeChat?.turns.length ?? 0) === 0;
    set({ activeChatId: chatId, error: null });
    try {
      const discarded = await invoke<string | null>("set_active_chat", {
        chatId,
      });
      const chat = await invoke<ChatDocument>("get_chat", { chatId });
      // User may have clicked another chat while we loaded.
      if (get().activeChatId !== chatId) return;
      let chats = get().chats;
      const dropId = discarded ?? (prevWasEmpty && prevId !== chatId ? prevId : null);
      if (dropId) {
        chats = chats.filter((c) => c.id !== dropId);
      }
      set({
        chats,
        activeChat: chat,
        activeChatId: chatId,
        activeProjectId: chat.projectId,
      });
    } catch (e) {
      if (get().activeChatId === chatId) {
        set({ error: String(e) });
      }
      return;
    }

    const chat = get().activeChat;
    if (!chat || get().activeChatId !== chatId) return;
    const project = get().projects.find((p) => p.id === chat.projectId);
    const envId = project?.environmentId || get().activeEnvironmentId;

    // Session restore is best-effort and can hang on SSH/session-load — never
    // block the open-chat path on it.
    void (async () => {
      if (get().activeChatId !== chatId) return;
      if (!get().connectedEnvironments.includes(envId)) {
        try {
          await get().connectAgent(envId);
        } catch (e) {
          get().pushLog(`[session] connect failed: ${e}`);
          return;
        }
      }
      if (get().activeChatId !== chatId) return;
      if (!get().connectedEnvironments.includes(envId)) return;
      try {
        const res = await invoke<{
          chat: ChatDocument;
          status: string;
          message: string;
        }>("ensure_chat_session", { chatId });
        if (get().activeChatId !== chatId) return;
        set({
          activeChat: res.chat,
          chats: get().chats.map((c) =>
            c.id === res.chat.id
              ? {
                  ...c,
                  acpSessionId: res.chat.acpSessionId,
                  updatedAt: res.chat.updatedAt,
                }
              : c,
          ),
        });
        if (res.status === "recreated") {
          get().pushLog(`[session] ${res.message}`);
        }
      } catch (e) {
        get().pushLog(`[session] ensure failed: ${e}`);
      }
    })();
  },

  deleteChat: async (chatId: string) => {
    await invoke("delete_chat", { chatId });
    const chats = get().chats.filter((c) => c.id !== chatId);
    const wasActive = get().activeChatId === chatId;
    set({ chats });
    if (wasActive) {
      const next = chatsForProject(chats, get().activeProjectId)[0];
      if (next) await get().selectChat(next.id);
      else set({ activeChatId: null, activeChat: null });
    }
  },

  renameChat: async (chatId: string, title: string) => {
    await invoke("rename_chat", { chatId, title });
    set({
      chats: get().chats.map((c) =>
        c.id === chatId ? { ...c, title, updatedAt: new Date().toISOString() } : c,
      ),
      activeChat:
        get().activeChat?.id === chatId
          ? { ...get().activeChat!, title }
          : get().activeChat,
    });
  },

  sendMessage: async (text: string, attachments = []) => {
    let chatId = get().activeChatId;
    if (!chatId) {
      await get().createChat();
      chatId = get().activeChatId;
    }
    if (!chatId) throw new Error("No active chat");

    const active = get().activeChat;
    const streaming = active?.turns.some((t) => t.status === "streaming");
    // CLI: when blocked on a running tool/command, Enter is cancel-and-send.
    const blockedOnTool = active?.turns.some(
      (t) =>
        t.status === "streaming" &&
        t.intermediate.some(
          (b) =>
            b.type === "tool" &&
            (b.status === "in_progress" ||
              b.status === "pending" ||
              b.status === "running"),
        ),
    );

    if (streaming || get().busy) {
      const item: QueuedMessage = {
        id: queueId(),
        chatId,
        text,
        attachments: attachments.map((a) => ({ ...a })),
      };
      set({ messageQueue: [...get().messageQueue, item], error: null });
      // If a command/tool is actively running, interrupt so the follow-up can run.
      if (blockedOnTool) {
        void get().cancelPrompt();
      }
      return;
    }

    await dispatchSend(get, set, chatId, text, attachments);
  },

  flushMessageQueue: async (chatId) => {
    const id = chatId ?? get().activeChatId;
    if (!id) return;
    if (get().busy) return;
    // Only drain when this chat is active and idle.
    if (get().activeChatId !== id) return;
    if (get().activeChat?.turns.some((t) => t.status === "streaming")) {
      return;
    }

    const next = get().messageQueue.find((m) => m.chatId === id);
    if (!next) return;

    set({
      messageQueue: get().messageQueue.filter((m) => m.id !== next.id),
    });
    try {
      await dispatchSend(get, set, next.chatId, next.text, next.attachments);
    } catch (e) {
      // Put it back at the front so the user can retry / edit.
      set({
        messageQueue: [next, ...get().messageQueue.filter((m) => m.id !== next.id)],
        error: String(e),
      });
    }
  },

  removeQueuedMessage: (id) => {
    set({ messageQueue: get().messageQueue.filter((m) => m.id !== id) });
  },

  clearMessageQueue: (chatId) => {
    if (!chatId) {
      set({ messageQueue: [] });
      return;
    }
    set({
      messageQueue: get().messageQueue.filter((m) => m.chatId !== chatId),
    });
  },

  cancelPrompt: async () => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    // Unlock the composer IMMEDIATELY. Waiting for the agent to ack cancel
    // (or for prompt-finished) left Stop stuck and blocked Send while a
    // shell tool was still winding down.
    const active = get().activeChat;
    if (active && active.id === chatId) {
      set({
        busy: false,
        permission: null,
        error: null,
        activeChat: {
          ...active,
          turns: active.turns.map((t) =>
            t.status === "streaming" || t.status === "cancelling"
              ? {
                  ...t,
                  status: "cancelled",
                  intermediateCollapsed: true,
                  intermediate: t.intermediate.map((b) =>
                    b.type === "tool" &&
                    (b.status === "pending" ||
                      b.status === "in_progress" ||
                      b.status === "running")
                      ? { ...b, status: "cancelled" }
                      : b,
                  ),
                }
              : t,
          ),
        },
      });
    } else {
      set({ busy: false, permission: null, error: null });
    }
    try {
      await invoke("cancel_prompt", { chatId });
    } catch (e) {
      set({ error: String(e) });
    }
    // Drain any follow-ups that were queued before/during stop.
    void get().flushMessageQueue(chatId);
  },

  refreshChat: async (chatId?: string) => {
    const id = chatId ?? get().activeChatId;
    if (!id) return;
    try {
      const chat = await invoke<ChatDocument>("get_chat", { chatId: id });
      // Critical: never let a background refresh (chat-updated / prompt-finished
      // for another chat) steal the user's current selection.
      if (get().activeChatId !== id) return;
      set({ activeChat: chat, activeChatId: id });
    } catch (e) {
      // Don't surface errors for stale refreshes after a switch.
      if (get().activeChatId === id) {
        console.error("refreshChat failed", e);
      }
    }
  },

  applySessionUpdate: async (sessionId: string, update: unknown) => {
    // Buffer only — never await per-token IPC. That was the "agent finished but
    // UI still drips" bug: hundreds of serial invokes behind a drained stream.
    enqueueSessionUpdate(sessionId, update);
    void drainSessionApplies(set, get);
  },

  setTurnCollapsed: async (turnId, collapsed) => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    const chat = await invoke<ChatDocument>("set_turn_collapsed", {
      chatId,
      turnId,
      collapsed,
    });
    set({ activeChat: chat });
  },

  setBlockCollapsed: async (turnId, blockId, collapsed) => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    const chat = await invoke<ChatDocument>("set_block_collapsed", {
      chatId,
      turnId,
      blockId,
      collapsed,
    });
    set({ activeChat: chat });
  },

  respondPermission: async (optionId, cancelled = false) => {
    const p = get().permission;
    if (!p) return;
    await invoke("respond_permission", {
      requestId: p.requestId,
      optionId,
      cancelled,
    });
    set({ permission: null });
  },

  setPermission: (p) => set({ permission: p }),
  pushLog: (msg) => set({ logs: [...get().logs.slice(-200), msg] }),
  setAgentStatus: (s) => {
    const envId = s.environmentId ?? get().agent.environmentId;
    let connectedEnvironments = get().connectedEnvironments;
    if (typeof s.connected === "boolean" && envId) {
      if (s.connected) {
        connectedEnvironments = Array.from(
          new Set([...connectedEnvironments, envId]),
        );
      } else {
        connectedEnvironments = connectedEnvironments.filter((id) => id !== envId);
      }
    }
    const activeConnected = connectedEnvironments.includes(
      get().activeEnvironmentId,
    );
    set({
      connectedEnvironments,
      agent: {
        ...get().agent,
        ...s,
        // Status pill reflects active environment connectivity
        connected:
          envId === get().activeEnvironmentId
            ? (s.connected ?? get().agent.connected)
            : activeConnected,
      },
    });
  },
}));

export { chatsForProject, projectsForEnv };
