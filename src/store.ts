import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentStatus,
  AppData,
  ChatDocument,
  ChatMeta,
  ContextChip,
  Environment,
  PermissionRequest,
  Project,
  WorkspaceMode,
} from "./types";
import { LOCAL_ENV_ID, SCRATCH_PROJECT_ID, scratchProjectIdForEnv } from "./types";
import { formatContextChips } from "./contextChips";
import {
  drainSessionApplies,
  enqueueSessionUpdate,
} from "./state/stream";
import {
  dispatchSend,
  healStuckBusy,
  isRetriableQueueError,
  queueId,
  type QueuedAttachment,
} from "./state/send";
import { markTurnsCancelled } from "./state/turns";

export { waitForApplyDrain } from "./state/stream";
export { healStuckBusy } from "./state/send";
export type { QueuedAttachment } from "./state/send";

/** Single-flight connect promises keyed by environment id. */
const connectPromises = new Map<string, Promise<void>>();

export type QueuedMessage = {
  id: string;
  chatId: string;
  text: string;
  attachments: QueuedAttachment[];
  contextChips?: ContextChip[];
};

/** Draft loaded into the bottom composer for edit & resend. */
export type ComposerEdit = {
  turnId: string;
  chatId: string;
  /** Seed text for the textarea. */
  text: string;
  hasAttachments: boolean;
  /** How many turns after this one will be removed on resend. */
  laterCount: number;
  /** Bumps so Composer re-seeds when editing the same turn again. */
  seed: number;
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
  /** Chat currently running a send/stream (for queue + cross-chat safety). */
  inflightChatId: string | null;
  /** Turn id for the current inflight prompt (turn-scoped cancel/finish). */
  inflightTurnId: string | null;
  /** Client-side generation for the current send slot (stale finish guard). */
  inflightGeneration: number | null;
  error: string | null;
  logs: string[];
  connectionsOpen: boolean;
  /** Bottom project terminal panel open. */
  terminalOpen: boolean;
  /** Right-hand subagent rail open (header toggle; only when subagents exist). */
  subagentsOpen: boolean;
  /** Exclusive main pane: chat transcript vs project files. */
  workspaceMode: WorkspaceMode;
  /** Context chips from Files view (paths / ranges) for the next send. */
  contextChips: ContextChip[];
  /** Follow-ups typed while a turn is still running (FIFO per chat). */
  messageQueue: QueuedMessage[];
  /** When set, the composer is editing/resubmitting this turn. */
  composerEdit: ComposerEdit | null;

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
  setTerminalOpen: (open: boolean) => void;
  setSubagentsOpen: (open: boolean) => void;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  addContextChip: (chip: ContextChip) => void;
  removeContextChip: (id: string) => void;
  updateContextChipNote: (id: string, note: string) => void;
  clearContextChips: () => void;
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
  /**
   * Roll back to a prior user turn (drop it and everything after), then send
   * the edited text as a new turn. Invalidates the ACP session so history
   * matches the truncated transcript.
   */
  resubmitFromTurn: (
    turnId: string,
    text: string,
    options?: {
      keepOriginalAttachments?: boolean;
      extraAttachments?: QueuedAttachment[];
    },
  ) => Promise<void>;
  /** Load a prior user turn into the bottom composer for edit & resend. */
  startEditTurn: (turnId: string) => void;
  clearComposerEdit: () => void;
  /**
   * Drain the global message queue when the send slot is free.
   * Optional preferredChatId is a hint only — any chat's head may run (FIFO).
   */
  flushMessageQueue: (preferredChatId?: string) => Promise<void>;
  removeQueuedMessage: (id: string) => void;
  clearMessageQueue: (chatId?: string) => void;
  cancelPrompt: () => Promise<void>;
  refreshChat: (chatId?: string) => Promise<void>;
  applySessionUpdate: (
    sessionId: string,
    update: unknown,
    environmentId?: string,
  ) => Promise<void>;
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
  inflightChatId: null,
  inflightTurnId: null,
  inflightGeneration: null,
  error: null,
  logs: [],
  connectionsOpen: false,
  terminalOpen: false,
  subagentsOpen: false,
  workspaceMode: "chat",
  contextChips: [],
  messageQueue: [],
  composerEdit: null,

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
      const projects = res.data.projects ?? [];
      const chats = res.data.chats ?? [];
      const savedChatId = res.data.activeChatId ?? null;
      const savedProjectId = res.data.activeProjectId ?? null;

      // If we have a saved chat, derive project/env from it so sidebar + files
      // match the transcript (index can be stale if only chat id was saved).
      const savedChatMeta = savedChatId
        ? chats.find((c) => c.id === savedChatId)
        : undefined;
      const projectId =
        savedChatMeta?.projectId ??
        savedProjectId ??
        null;
      const project = projectId
        ? projects.find((p) => p.id === projectId)
        : undefined;
      const envFromProject = project?.environmentId || activeEnv;

      set({
        ready: true,
        dataDir: res.dataDir,
        environments: res.data.environments ?? [],
        activeEnvironmentId: envFromProject,
        connectedEnvironments: connected,
        sshHosts: res.sshHosts ?? [],
        projects,
        chats,
        activeProjectId: projectId,
        activeChatId: savedChatId,
        agent: {
          connected: connected.includes(envFromProject),
          message: connected.includes(envFromProject)
            ? "Connected"
            : "Not connected",
          environmentId: envFromProject,
        },
      });

      // Full selectChat path: load document, sync project/env, ensure session.
      // refreshChat alone left sidebar/files on a stale project.
      if (savedChatId) {
        await get().selectChat(savedChatId);
      }
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  connectAgent: async (environmentId?: string) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    // Single-flight: bootstrap + selectChat must not spawn two agent processes.
    const existing = connectPromises.get(envId);
    if (existing) {
      await existing;
      return;
    }
    const work = (async () => {
      // Don't stomp an in-flight send's busy claim (dispatchSend sets inflight first).
      const keepBusy = get().inflightChatId != null;
      if (!keepBusy) set({ busy: true, error: null });
      else set({ error: null });
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
          // Preserve busy if a send is in flight for some chat.
          busy: get().inflightChatId != null ? true : false,
        });
      } catch (e) {
        set({
          agent: {
            connected: false,
            message: String(e),
            environmentId: envId,
          },
          error: String(e),
          busy: get().inflightChatId != null ? true : false,
          connectedEnvironments: get().connectedEnvironments.filter(
            (id) => id !== envId,
          ),
        });
        throw e;
      }
    })();
    connectPromises.set(envId, work);
    try {
      await work;
    } finally {
      connectPromises.delete(envId);
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
    const projectIds = new Set(
      get()
        .projects.filter(
          (p) => (p.environmentId || LOCAL_ENV_ID) === environmentId,
        )
        .map((p) => p.id),
    );
    const removedChatIds = new Set(
      get()
        .chats.filter((c) => projectIds.has(c.projectId))
        .map((c) => c.id),
    );
    await invoke("remove_environment", { environmentId });
    const environments = get().environments.filter((e) => e.id !== environmentId);
    const projects = get().projects.filter(
      (p) => (p.environmentId || LOCAL_ENV_ID) !== environmentId,
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
      messageQueue: get().messageQueue.filter(
        (m) => !removedChatIds.has(m.chatId),
      ),
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

  setTerminalOpen: (open) => set({ terminalOpen: open }),

  setSubagentsOpen: (open) => set({ subagentsOpen: open }),

  setWorkspaceMode: (mode) => set({ workspaceMode: mode }),

  addContextChip: (chip) => {
    const existing = get().contextChips;
    // Dedupe identical path/range targets.
    const key = `${chip.kind}:${chip.path}:${chip.startLine ?? ""}:${chip.endLine ?? ""}`;
    if (
      existing.some(
        (c) =>
          `${c.kind}:${c.path}:${c.startLine ?? ""}:${c.endLine ?? ""}` === key,
      )
    ) {
      return;
    }
    set({ contextChips: [...existing, chip] });
  },

  removeContextChip: (id) =>
    set({ contextChips: get().contextChips.filter((c) => c.id !== id) }),

  updateContextChipNote: (id, note) =>
    set({
      contextChips: get().contextChips.map((c) =>
        c.id === id ? { ...c, note } : c,
      ),
    }),

  clearContextChips: () => set({ contextChips: [] }),

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
    // Update the project list first, then go through selectProject so the
    // previous project's chat is cleared (or replaced by this project's first chat).
    set({ projects });
    await get().selectProject(project.id);
  },

  removeProject: async (projectId: string) => {
    if (
      projectId === SCRATCH_PROJECT_ID ||
      projectId.startsWith("scratch:")
    ) {
      throw new Error("Scratch workspace can't be removed");
    }
    const removedChatIds = new Set(
      get().chats.filter((c) => c.projectId === projectId).map((c) => c.id),
    );
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
      // Drop queue items targeting deleted chats so they cannot poison FIFO.
      messageQueue: get().messageQueue.filter(
        (m) => !removedChatIds.has(m.chatId),
      ),
    });
  },

  selectProject: async (projectId: string) => {
    const project = get().projects.find((p) => p.id === projectId);
    const envId = project?.environmentId || get().activeEnvironmentId;
    if (envId !== get().activeEnvironmentId) {
      await get().setActiveEnvironment(envId);
    }
    await invoke("set_active_project", { projectId });
    // Drop the previous project's transcript immediately so it never sticks
    // around while we load this project's first chat (or empty state).
    const prevChat = get().activeChat;
    const staysOnProject = prevChat?.projectId === projectId;
    set({
      activeProjectId: projectId,
      activeEnvironmentId: envId,
      ...(staysOnProject
        ? {}
        : { activeChatId: null, activeChat: null, busy: false, permission: null }),
    });
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
      const prevId = prevChat?.id ?? get().activeChatId;
      const prevEmpty =
        prevChat?.id === prevId && (prevChat?.turns.length ?? 0) === 0;
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
    // Clear the document when switching chats so the previous transcript
    // never remains on screen during load.
    set({
      activeChatId: chatId,
      activeChat: prevId === chatId ? get().activeChat : null,
      error: null,
      composerEdit: prevId === chatId ? get().composerEdit : null,
    });
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
      const project = get().projects.find((p) => p.id === chat.projectId);
      const envId = project?.environmentId || get().activeEnvironmentId;
      set({
        chats,
        activeChat: chat,
        activeChatId: chatId,
        activeProjectId: chat.projectId,
        activeEnvironmentId: envId,
      });
      // Drain follow-ups queued for this chat while another was inflight.
      const idle =
        !chat.turns.some((t) => t.status === "streaming") &&
        get().inflightChatId !== chatId;
      if (idle) {
        void get().flushMessageQueue(chatId);
      }
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
        // Patch session meta only — never replace the full transcript with an
        // ensure response (it can be a pre-send clone and vanish user messages).
        const sid = res.chat.acpSessionId ?? null;
        set({
          chats: get().chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  acpSessionId: sid,
                  updatedAt: res.chat.updatedAt ?? c.updatedAt,
                }
              : c,
          ),
          activeChat:
            get().activeChat?.id === chatId
              ? {
                  ...get().activeChat!,
                  acpSessionId: sid,
                }
              : get().activeChat,
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
    // Refuse while a prompt is settling — purge would race and queues must not
    // be cleared until deletion succeeds.
    if (get().inflightChatId === chatId) {
      throw new Error(
        "Cancel the running turn and wait for it to settle before deleting this chat",
      );
    }
    await invoke("delete_chat", { chatId });
    const chats = get().chats.filter((c) => c.id !== chatId);
    const wasActive = get().activeChatId === chatId;
    set({
      chats,
      messageQueue: get().messageQueue.filter((m) => m.chatId !== chatId),
    });
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

  startEditTurn: (turnId) => {
    const chat = get().activeChat;
    const chatId = get().activeChatId;
    if (!chat || !chatId) return;
    const idx = chat.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const turn = chat.turns[idx];
    set({
      composerEdit: {
        turnId,
        chatId,
        text: turn.userMessage,
        hasAttachments: (turn.attachments?.length ?? 0) > 0,
        laterCount: Math.max(0, chat.turns.length - idx - 1),
        seed: Date.now(),
      },
      // Context chips apply to a new message, not a resubmit of an old turn.
      contextChips: [],
    });
  },

  clearComposerEdit: () => set({ composerEdit: null }),

  resubmitFromTurn: async (turnId, text, options = {}) => {
    const chatId = get().activeChatId;
    if (!chatId) throw new Error("No active chat");
    const keepAttachments = options.keepOriginalAttachments !== false;

    // Drop queued follow-ups for this chat only. Do not clear another chat's
    // send slot (viewing X edit while Y streams would strand Y's queue).
    const ownsSlot = get().inflightChatId === chatId;
    set({
      messageQueue: get().messageQueue.filter((m) => m.chatId !== chatId),
      ...(ownsSlot
        ? {
            busy: false,
            inflightChatId: null as string | null,
            inflightTurnId: null as string | null,
            inflightGeneration: null as number | null,
          }
        : {}),
      permission: null,
      error: null,
      contextChips: [],
      composerEdit: null,
    });

    // Another chat owns the global slot — queue the resubmit instead of racing.
    if (get().inflightChatId != null && get().inflightChatId !== chatId) {
      const item: QueuedMessage = {
        id: queueId(),
        chatId,
        text: text.trim(),
        attachments: (options.extraAttachments ?? []).map((a) => ({ ...a })),
      };
      // Still roll back the transcript; send will follow when the slot frees.
      const result = await invoke<{
        chat: ChatDocument;
        draftText: string;
        attachments: Array<{
          kind: string;
          data: string;
          mimeType: string;
          name?: string | null;
          dataUrl?: string | null;
        }>;
        removedCount: number;
      }>("rollback_to_turn", { chatId, turnId });
      const original: QueuedAttachment[] = keepAttachments
        ? result.attachments.map((a) => ({
            kind: a.kind,
            data: a.data,
            mimeType: a.mimeType,
            name: a.name ?? undefined,
            dataUrl: a.dataUrl ?? undefined,
          }))
        : [];
      item.attachments = [
        ...original,
        ...(options.extraAttachments ?? []).map((a) => ({ ...a })),
      ];
      set({
        activeChat: result.chat,
        activeChatId: chatId,
        chats: get().chats.map((c) =>
          c.id === result.chat.id
            ? {
                ...c,
                title: result.chat.title,
                updatedAt: result.chat.updatedAt,
                acpSessionId: result.chat.acpSessionId,
                preview:
                  result.chat.turns.length > 0
                    ? result.chat.turns[
                        result.chat.turns.length - 1
                      ].userMessage.slice(0, 120)
                    : c.preview,
              }
            : c,
        ),
        messageQueue: [...get().messageQueue, item],
      });
      return;
    }

    const result = await invoke<{
      chat: ChatDocument;
      draftText: string;
      attachments: Array<{
        kind: string;
        data: string;
        mimeType: string;
        name?: string | null;
        dataUrl?: string | null;
      }>;
      removedCount: number;
    }>("rollback_to_turn", { chatId, turnId });

    set({
      activeChat: result.chat,
      activeChatId: chatId,
      chats: get().chats.map((c) =>
        c.id === result.chat.id
          ? {
              ...c,
              title: result.chat.title,
              updatedAt: result.chat.updatedAt,
              acpSessionId: result.chat.acpSessionId,
              preview:
                result.chat.turns.length > 0
                  ? result.chat.turns[
                      result.chat.turns.length - 1
                    ].userMessage.slice(0, 120)
                  : c.preview,
            }
          : c,
      ),
      busy: false,
      inflightChatId:
        get().inflightChatId === chatId ? null : get().inflightChatId,
      inflightTurnId:
        get().inflightChatId === chatId ? null : get().inflightTurnId,
      inflightGeneration:
        get().inflightChatId === chatId ? null : get().inflightGeneration,
    });

    const original: QueuedAttachment[] = keepAttachments
      ? result.attachments.map((a) => ({
          kind: a.kind,
          data: a.data,
          mimeType: a.mimeType,
          name: a.name ?? undefined,
          dataUrl: a.dataUrl ?? undefined,
        }))
      : [];
    const attachments = [
      ...original,
      ...(options.extraAttachments ?? []).map((a) => ({ ...a })),
    ];

    // Backend rollback waits for inflight release; only heal this chat's slot.
    if (get().inflightChatId == null || get().inflightChatId === chatId) {
      healStuckBusy(set, get, { force: true });
    }
    await dispatchSend(get, set, chatId, text.trim(), attachments);
  },

  sendMessage: async (text: string, attachments = []) => {
    let chatId = get().activeChatId;
    if (!chatId) {
      await get().createChat();
      chatId = get().activeChatId;
    }
    if (!chatId) throw new Error("No active chat");

    // Only heal a stuck lock for *this* chat (never clear another chat's inflight).
    healStuckBusy(set, get, { force: true });

    const chips = get().contextChips;
    const ctxBlock = formatContextChips(chips);
    const body = text.trim();
    const fullText =
      ctxBlock && body
        ? `${ctxBlock}\n\n### Message\n${body}`
        : ctxBlock || body;

    const active = get().activeChat;
    const streaming = active?.turns.some((t) => t.status === "streaming");
    // Codex-style: while the agent is working, or anything is already queued
    // for this chat, enqueue behind it (preserve FIFO). Never cancel on send.
    // Global FIFO: any non-empty queue means enqueue (do not leapfrog).
    const shouldQueue =
      streaming ||
      get().busy ||
      get().inflightChatId != null ||
      get().messageQueue.length > 0;

    if (shouldQueue) {
      const item: QueuedMessage = {
        id: queueId(),
        chatId,
        text: fullText,
        attachments: attachments.map((a) => ({ ...a })),
        contextChips: chips.map((c) => ({ ...c })),
      };
      set({
        messageQueue: [...get().messageQueue, item],
        contextChips: [],
        error: null,
      });
      // If the slot is free (e.g. a prior queue head failed and parked), kick
      // the flusher so one transient error cannot brick the composer forever.
      if (!get().busy && get().inflightChatId == null) {
        void get().flushMessageQueue();
      }
      return;
    }

    set({ contextChips: [] });
    await dispatchSend(get, set, chatId, fullText, attachments);
  },

  flushMessageQueue: async (_preferredChatId) => {
    // Global FIFO: always take queue[0]. Preferred-chat hint would starve
    // other chats that enqueued earlier.
    const inflight = get().inflightChatId;
    if (inflight) return;
    if (get().busy) {
      healStuckBusy(set, get, { force: true });
      if (get().busy || get().inflightChatId) return;
    }

    const next = get().messageQueue[0];
    if (!next) return;

    set({
      messageQueue: get().messageQueue.filter((m) => m.id !== next.id),
    });
    try {
      await dispatchSend(get, set, next.chatId, next.text, next.attachments);
    } catch (e) {
      const err = String(e);
      // Transient settle errors: requeue and schedule a short retry so a
      // cancel-window reject does not permanently poison the FIFO head.
      const retriable = isRetriableQueueError(err);
      set({
        messageQueue: [
          next,
          ...get().messageQueue.filter((m) => m.id !== next.id),
        ],
        error: err,
      });
      if (retriable) {
        window.setTimeout(() => {
          const s = get();
          if (
            !s.busy &&
            s.inflightChatId == null &&
            s.messageQueue[0]?.id === next.id
          ) {
            void s.flushMessageQueue();
          }
        }, 750);
      }
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
    // Keep the send slot until prompt-finished for this turn so a queued
    // follow-up cannot start while the session is still in cancelling_sessions
    // (which would drop its early stream chunks). Optimistically paint cancelled
    // UI so Stop feels instant; do NOT flush the queue here.
    const active = get().activeChat;
    const cancelledTurnId =
      get().inflightTurnId ??
      active?.turns
        .slice()
        .reverse()
        .find((t) => t.status === "streaming" || t.status === "cancelling")
        ?.id ??
      null;

    if (active && active.id === chatId) {
      set({
        // Stay busy while the cancelled prompt settles.
        busy: get().inflightChatId === chatId ? true : get().busy,
        inflightChatId:
          get().inflightChatId === chatId ? chatId : get().inflightChatId,
        inflightTurnId:
          get().inflightChatId === chatId
            ? cancelledTurnId
            : get().inflightTurnId,
        permission: null,
        error: null,
        activeChat: {
          ...active,
          turns: markTurnsCancelled(active.turns),
        },
      });
    } else {
      set({
        busy: get().inflightChatId === chatId ? true : get().busy,
        permission: null,
        error: null,
      });
    }
    try {
      await invoke("cancel_prompt", { chatId });
    } catch (e) {
      set({ error: String(e) });
      // If cancel IPC failed, unlock so the user is not stuck.
      if (get().inflightChatId === chatId) {
        set({
          busy: false,
          inflightChatId: null,
          inflightTurnId: null,
          inflightGeneration: null,
        });
        void get().flushMessageQueue(chatId);
      }
    }
    // Queue flush happens on prompt-finished once the turn has settled.
  },

  refreshChat: async (chatId?: string) => {
    const id = chatId ?? get().activeChatId;
    if (!id) return;
    try {
      const chat = await invoke<ChatDocument>("get_chat", { chatId: id });
      // Always keep sidebar meta session ids in sync (even if not viewing).
      set({
        chats: get().chats.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                title: chat.title,
                updatedAt: chat.updatedAt,
                acpSessionId: chat.acpSessionId,
              }
            : c,
        ),
      });
      // Critical: never let a background refresh (chat-updated / prompt-finished
      // for another chat) steal the user's current selection.
      if (get().activeChatId !== id) return;
      const project = get().projects.find((p) => p.id === chat.projectId);
      const envId = project?.environmentId || get().activeEnvironmentId;
      set({
        activeChat: chat,
        activeChatId: id,
        // Keep project / env aligned with the document (sidebar + files).
        activeProjectId: chat.projectId,
        activeEnvironmentId: envId,
      });
    } catch (e) {
      // Don't surface errors for stale refreshes after a switch.
      if (get().activeChatId === id) {
        console.error("refreshChat failed", e);
      }
    }
  },

  applySessionUpdate: async (
    sessionId: string,
    update: unknown,
    environmentId?: string,
  ) => {
    // Buffer only — never await per-token IPC. That was the "agent finished but
    // UI still drips" bug: hundreds of serial invokes behind a drained stream.
    enqueueSessionUpdate(sessionId, update, environmentId);
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
    // Guard: user may have switched chats while IPC was in flight.
    if (get().activeChatId !== chatId) return;
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
    if (get().activeChatId !== chatId) return;
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
