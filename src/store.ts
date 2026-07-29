import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentBackend,
  AgentRuntime,
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
import {
  LOCAL_ENV_ID,
  SCRATCH_PROJECT_ID,
  normalizeAgentBackend,
  scratchProjectIdForEnv,
} from "./types";
import { formatContextChips } from "./contextChips";
import {
  enqueueSessionUpdate,
  scheduleSessionApplies,
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

/** Single-flight connect promises keyed by environment + backend. */
const connectPromises = new Map<string, Promise<void>>();

function runtimeKey(environmentId: string, backend: AgentBackend) {
  return `${environmentId}:${backend}`;
}

function hasRuntime(
  runtimes: AgentRuntime[],
  environmentId: string,
  backend: AgentBackend,
) {
  return runtimes.some(
    (runtime) =>
      runtime.environmentId === environmentId && runtime.backend === backend,
  );
}

function connectedEnvironmentIds(runtimes: AgentRuntime[]) {
  return Array.from(new Set(runtimes.map((runtime) => runtime.environmentId)));
}

function normalizeRuntimes(
  runtimes: AgentRuntime[] | undefined,
  legacyEnvironments: string[] = [],
): AgentRuntime[] {
  const source =
    runtimes !== undefined
      ? runtimes
      : legacyEnvironments.map((environmentId) => ({
          environmentId,
          backend: "grok" as const,
        }));
  const seen = new Set<string>();
  return source.flatMap((runtime) => {
    const normalized = {
      environmentId: runtime.environmentId,
      backend: normalizeAgentBackend(runtime.backend),
    };
    const key = runtimeKey(normalized.environmentId, normalized.backend);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function normalizeChatMeta(chat: ChatMeta): ChatMeta {
  return { ...chat, backend: normalizeAgentBackend(chat.backend) };
}

function normalizeChatDocument(chat: ChatDocument): ChatDocument {
  return {
    ...chat,
    backend: normalizeAgentBackend(chat.backend),
    agentConfig: {
      modelConfigId: chat.agentConfig?.modelConfigId ?? null,
      modelId: chat.agentConfig?.modelId ?? null,
      modelName: chat.agentConfig?.modelName ?? null,
      availableModels: chat.agentConfig?.availableModels ?? [],
      accessModeId: chat.agentConfig?.accessModeId ?? null,
      accessModeName: chat.agentConfig?.accessModeName ?? null,
      availableAccessModes: chat.agentConfig?.availableAccessModes ?? [],
      accessModeExplicit: chat.agentConfig?.accessModeExplicit ?? false,
    },
  };
}

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
  activeBackend: AgentBackend;
  connectedEnvironments: string[];
  connectedRuntimes: AgentRuntime[];
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
  connectAgent: (
    environmentId?: string,
    backend?: AgentBackend,
  ) => Promise<void>;
  disconnectAgent: (
    environmentId?: string,
    backend?: AgentBackend,
  ) => Promise<void>;
  setActiveEnvironment: (environmentId: string) => Promise<void>;
  setActiveBackend: (backend: AgentBackend) => Promise<void>;
  setChatModel: (modelId: string) => Promise<void>;
  setChatAccessMode: (modeId: string) => Promise<void>;
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
  reloadConversation: () => Promise<void>;
  applySessionUpdate: (
    sessionId: string,
    update: unknown,
    environmentId?: string,
    backend?: AgentBackend,
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
  isRuntimeConnected: (
    environmentId: string,
    backend: AgentBackend,
  ) => boolean;
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
  activeBackend: "grok",
  connectedEnvironments: [],
  connectedRuntimes: [],
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
    get().connectedRuntimes.some(
      (runtime) => runtime.environmentId === environmentId,
    ),

  isRuntimeConnected: (environmentId, backend) =>
    hasRuntime(
      get().connectedRuntimes,
      environmentId,
      normalizeAgentBackend(backend),
    ),

  bootstrap: async () => {
    try {
      const res = await invoke<{
        data: AppData;
        dataDir: string;
        agentConnected: boolean;
        connectedEnvironments: string[];
        connectedRuntimes?: AgentRuntime[];
        activeEnvironmentId: string;
        activeBackend?: AgentBackend;
        sshHosts: string[];
      }>("get_bootstrap");
      const activeEnv =
        res.activeEnvironmentId ||
        res.data.activeEnvironmentId ||
        LOCAL_ENV_ID;
      const runtimes = normalizeRuntimes(
        res.connectedRuntimes,
        res.connectedEnvironments,
      );
      const connected = connectedEnvironmentIds(runtimes);
      const projects = res.data.projects ?? [];
      const chats = (res.data.chats ?? []).map(normalizeChatMeta);
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
      const backend = normalizeAgentBackend(
        savedChatMeta?.backend ??
          res.activeBackend ??
          res.data.activeBackend,
      );
      const runtimeConnected = hasRuntime(runtimes, envFromProject, backend);

      set({
        ready: true,
        dataDir: res.dataDir,
        environments: res.data.environments ?? [],
        activeEnvironmentId: envFromProject,
        activeBackend: backend,
        connectedEnvironments: connected,
        connectedRuntimes: runtimes,
        sshHosts: res.sshHosts ?? [],
        projects,
        chats,
        activeProjectId: projectId,
        activeChatId: savedChatId,
        agent: {
          connected: runtimeConnected,
          message: runtimeConnected ? "Connected" : "Not connected",
          environmentId: envFromProject,
          backend,
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

  connectAgent: async (
    environmentId?: string,
    requestedBackend?: AgentBackend,
  ) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    const backend = normalizeAgentBackend(
      requestedBackend ?? get().activeBackend,
    );
    const key = runtimeKey(envId, backend);
    // Single-flight: bootstrap + selectChat must not spawn two agent processes.
    const existing = connectPromises.get(key);
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
          backend?: AgentBackend;
          message: string;
        }>("connect_agent", { environmentId: envId, backend });
        const connectedEnv = res.environmentId || envId;
        const connectedBackend = normalizeAgentBackend(res.backend ?? backend);
        const connectedRuntimes = normalizeRuntimes([
          ...get().connectedRuntimes,
          { environmentId: connectedEnv, backend: connectedBackend },
        ]);
        const activeConnected = hasRuntime(
          connectedRuntimes,
          get().activeEnvironmentId,
          get().activeBackend,
        );
        set({
          connectedEnvironments: connectedEnvironmentIds(connectedRuntimes),
          connectedRuntimes,
          agent: {
            connected: activeConnected,
            message:
              connectedEnv === get().activeEnvironmentId &&
              connectedBackend === get().activeBackend
                ? res.message || "Connected"
                : get().agent.message,
            environmentId: get().activeEnvironmentId,
            backend: get().activeBackend,
          },
          // Preserve busy if a send is in flight for some chat.
          busy: get().inflightChatId != null ? true : false,
        });
      } catch (e) {
        const connectedRuntimes = get().connectedRuntimes.filter(
          (runtime) =>
            runtime.environmentId !== envId || runtime.backend !== backend,
        );
        const activeConnected = hasRuntime(
          connectedRuntimes,
          get().activeEnvironmentId,
          get().activeBackend,
        );
        set({
          agent: {
            connected: activeConnected,
            message:
              envId === get().activeEnvironmentId &&
              backend === get().activeBackend
                ? String(e)
                : get().agent.message,
            environmentId: get().activeEnvironmentId,
            backend: get().activeBackend,
          },
          error: String(e),
          busy: get().inflightChatId != null ? true : false,
          connectedRuntimes,
          connectedEnvironments: connectedEnvironmentIds(connectedRuntimes),
        });
        throw e;
      }
    })();
    connectPromises.set(key, work);
    try {
      await work;
    } finally {
      connectPromises.delete(key);
    }
  },

  disconnectAgent: async (
    environmentId?: string,
    requestedBackend?: AgentBackend,
  ) => {
    const envId = environmentId ?? get().activeEnvironmentId;
    const backend = normalizeAgentBackend(
      requestedBackend ?? get().activeBackend,
    );
    await invoke("disconnect_agent", { environmentId: envId, backend });
    const connectedRuntimes = get().connectedRuntimes.filter(
      (runtime) =>
        runtime.environmentId !== envId || runtime.backend !== backend,
    );
    const connected = connectedEnvironmentIds(connectedRuntimes);
    const activeConnected = hasRuntime(
      connectedRuntimes,
      get().activeEnvironmentId,
      get().activeBackend,
    );
    set({
      connectedEnvironments: connected,
      connectedRuntimes,
      agent: {
        connected: activeConnected,
        message:
          envId === get().activeEnvironmentId &&
          backend === get().activeBackend
            ? "Not connected"
            : get().agent.message,
        environmentId: get().activeEnvironmentId,
        backend: get().activeBackend,
      },
    });
  },

  setActiveBackend: async (backend) => {
    const normalized = normalizeAgentBackend(backend);
    const replaceEmptyDraft =
      get().activeChat != null &&
      get().activeChat!.turns.length === 0 &&
      normalizeAgentBackend(get().activeChat!.backend) !== normalized;
    const connected = hasRuntime(
      get().connectedRuntimes,
      get().activeEnvironmentId,
      normalized,
    );
    set({
      activeBackend: normalized,
      agent: {
        ...get().agent,
        connected,
        message: connected ? "Connected" : "Not connected",
        environmentId: get().activeEnvironmentId,
        backend: normalized,
      },
    });
    try {
      await invoke("set_active_backend", { backend: normalized });
    } catch (e) {
      const message = String(e);
      set({
        error: message,
        logs: [...get().logs.slice(-200), `[backend] ${message}`],
      });
    }

    try {
      await get().connectAgent(get().activeEnvironmentId, normalized);
      // A newly-created empty draft can safely follow the provider selector.
      // Chats with messages remain pinned to the backend that owns their session.
      if (
        replaceEmptyDraft &&
        get().activeBackend === normalized &&
        get().activeChat?.turns.length === 0 &&
        normalizeAgentBackend(get().activeChat?.backend) !== normalized
      ) {
        await get().createChat();
      }
    } catch {
      // connectAgent/createChat already surface the actionable error.
    }
  },

  setChatModel: async (modelId) => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    set({ busy: true, error: null });
    try {
      const chat = normalizeChatDocument(
        await invoke<ChatDocument>("set_chat_model", { chatId, modelId }),
      );
      if (get().activeChatId !== chatId) {
        set({ busy: false });
        return;
      }
      set({
        activeChat: chat,
        chats: get().chats.map((meta) =>
          meta.id === chatId ? { ...meta, updatedAt: chat.updatedAt } : meta,
        ),
        busy: false,
      });
    } catch (error) {
      set({ busy: false, error: String(error) });
      throw error;
    }
  },

  setChatAccessMode: async (modeId) => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    set({ busy: true, error: null });
    try {
      const chat = normalizeChatDocument(
        await invoke<ChatDocument>("set_chat_access_mode", { chatId, modeId }),
      );
      if (get().activeChatId !== chatId) {
        set({ busy: false });
        return;
      }
      set({
        activeChat: chat,
        chats: get().chats.map((meta) =>
          meta.id === chatId ? { ...meta, updatedAt: chat.updatedAt } : meta,
        ),
        busy: false,
      });
    } catch (error) {
      set({ busy: false, error: String(error) });
      throw error;
    }
  },

  setActiveEnvironment: async (environmentId: string) => {
    const data = await invoke<AppData>("set_active_environment", {
      environmentId,
    });
    const envId = data.activeEnvironmentId || environmentId;
    const chats = (data.chats ?? get().chats).map(normalizeChatMeta);
    const selected = data.activeChatId
      ? chats.find((chat) => chat.id === data.activeChatId)
      : undefined;
    const backend = selected
      ? normalizeAgentBackend(selected.backend)
      : get().activeBackend;
    const connected = hasRuntime(get().connectedRuntimes, envId, backend);
    set({
      environments: data.environments ?? get().environments,
      projects: data.projects ?? get().projects,
      chats,
      activeEnvironmentId: envId,
      activeBackend: backend,
      activeProjectId: data.activeProjectId ?? null,
      activeChatId: data.activeChatId ?? null,
      agent: {
        ...get().agent,
        connected,
        environmentId: envId,
        backend,
        message: connected ? "Connected" : "Not connected",
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
        backend: get().activeBackend,
      });
      const environments = [
        ...get().environments.filter((e) => e.id !== env.id),
        env,
      ];
      // Re-bootstrap projects (scratch for new env)
      const boot = await invoke<{
        data: AppData;
        connectedEnvironments: string[];
        connectedRuntimes?: AgentRuntime[];
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
      await get().connectAgent(env.id, get().activeBackend);
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
    const connectedRuntimes = get().connectedRuntimes.filter(
      (runtime) => runtime.environmentId !== environmentId,
    );
    const connectedEnvironments = connectedEnvironmentIds(connectedRuntimes);
    const activeEnvironmentId =
      get().activeEnvironmentId === environmentId
        ? LOCAL_ENV_ID
        : get().activeEnvironmentId;
    set({
      environments,
      projects,
      chats,
      connectedEnvironments,
      connectedRuntimes,
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
        connected: hasRuntime(
          connectedRuntimes,
          activeEnvironmentId,
          get().activeBackend,
        ),
        message: hasRuntime(
          connectedRuntimes,
          activeEnvironmentId,
          get().activeBackend,
        )
          ? "Connected"
          : "Not connected",
        environmentId: activeEnvironmentId,
        backend: get().activeBackend,
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
    const first = chatsForProject(get().chats, projectId)[0];
    // Existing chats choose their own backend in selectChat. Empty projects
    // use the backend currently selected for the next new chat.
    if (
      !first &&
      !get().isRuntimeConnected(envId, get().activeBackend)
    ) {
      try {
        await get().connectAgent(envId, get().activeBackend);
      } catch {
        // status shows error
      }
    }
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
    const backend = get().activeBackend;
    if (!get().isRuntimeConnected(envId, backend)) {
      await get().connectAgent(envId, backend);
    }
    // Already on an unused draft for this project — keep it.
    const cur = get().activeChat;
    if (
      cur &&
      cur.projectId === projectId &&
      normalizeAgentBackend(cur.backend) === backend &&
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
        backend,
      });
      const normalizedChat = normalizeChatDocument(chat);
      const meta: ChatMeta = {
        id: normalizedChat.id,
        projectId: normalizedChat.projectId,
        backend: normalizedChat.backend,
        title: normalizedChat.title,
        acpSessionId: normalizedChat.acpSessionId,
        preview: null,
        createdAt: normalizedChat.createdAt,
        updatedAt: normalizedChat.updatedAt,
      };
      // Drop the previous empty draft from the sidebar if backend discarded it.
      let chats = get().chats.filter((c) => c.id !== meta.id);
      if (prevId && prevId !== normalizedChat.id) {
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
        activeProjectId: normalizedChat.projectId,
        activeBackend: normalizedChat.backend,
        activeChatId: normalizedChat.id,
        activeChat: normalizedChat,
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
    const knownMeta = get().chats.find((chat) => chat.id === chatId);
    const knownBackend = knownMeta
      ? normalizeAgentBackend(knownMeta.backend)
      : get().activeBackend;
    const knownRuntimeConnected = hasRuntime(
      get().connectedRuntimes,
      get().activeEnvironmentId,
      knownBackend,
    );
    // Clear the document when switching chats so the previous transcript
    // never remains on screen during load.
    set({
      activeChatId: chatId,
      activeChat: prevId === chatId ? get().activeChat : null,
      activeBackend: knownBackend,
      agent: {
        ...get().agent,
        connected: knownRuntimeConnected,
        message: knownRuntimeConnected ? "Connected" : "Not connected",
        environmentId: get().activeEnvironmentId,
        backend: knownBackend,
      },
      error: null,
      composerEdit: prevId === chatId ? get().composerEdit : null,
    });
    try {
      const discarded = await invoke<string | null>("set_active_chat", {
        chatId,
      });
      const rawChat = await invoke<ChatDocument>("get_chat", { chatId });
      const chat = normalizeChatDocument(rawChat);
      // User may have clicked another chat while we loaded.
      if (get().activeChatId !== chatId) return;
      let chats = get().chats;
      const dropId = discarded ?? (prevWasEmpty && prevId !== chatId ? prevId : null);
      if (dropId) {
        chats = chats.filter((c) => c.id !== dropId);
      }
      const project = get().projects.find((p) => p.id === chat.projectId);
      const envId = project?.environmentId || get().activeEnvironmentId;
      const runtimeConnected = hasRuntime(
        get().connectedRuntimes,
        envId,
        chat.backend,
      );
      set({
        chats,
        activeChat: chat,
        activeChatId: chatId,
        activeProjectId: chat.projectId,
        activeEnvironmentId: envId,
        activeBackend: chat.backend,
        agent: {
          ...get().agent,
          connected: runtimeConnected,
          message: runtimeConnected ? "Connected" : "Not connected",
          environmentId: envId,
          backend: chat.backend,
        },
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
    const backend = normalizeAgentBackend(chat.backend);

    // Session restore is best-effort and can hang on SSH/session-load — never
    // block the open-chat path on it.
    void (async () => {
      if (get().activeChatId !== chatId) return;
      if (!get().isRuntimeConnected(envId, backend)) {
        try {
          await get().connectAgent(envId, backend);
        } catch (e) {
          get().pushLog(`[session] connect failed: ${e}`);
          return;
        }
      }
      if (get().activeChatId !== chatId) return;
      if (!get().isRuntimeConnected(envId, backend)) return;
      try {
        const res = await invoke<{
          chat: ChatDocument;
          status: string;
          message: string;
        }>("ensure_chat_session", { chatId });
        if (get().activeChatId !== chatId) return;
        const ensuredChat = normalizeChatDocument(res.chat);
        // Patch session meta only — never replace the full transcript with an
        // ensure response (it can be a pre-send clone and vanish user messages).
        const sid = ensuredChat.acpSessionId ?? null;
        set({
          chats: get().chats.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  acpSessionId: sid,
                  backend: normalizeAgentBackend(
                    ensuredChat.backend ?? backend,
                  ),
                  updatedAt: ensuredChat.updatedAt ?? c.updatedAt,
                }
              : c,
          ),
          activeChat:
            get().activeChat?.id === chatId
              ? {
                  ...get().activeChat!,
                  acpSessionId: sid,
                  agentConfig: ensuredChat.agentConfig,
                  backend: normalizeAgentBackend(
                    ensuredChat.backend ?? backend,
                  ),
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
      const rolledBackChat = normalizeChatDocument(result.chat);
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
        activeChat: rolledBackChat,
        activeChatId: chatId,
        chats: get().chats.map((c) =>
          c.id === rolledBackChat.id
            ? {
                ...c,
                title: rolledBackChat.title,
                updatedAt: rolledBackChat.updatedAt,
                acpSessionId: rolledBackChat.acpSessionId,
                backend: rolledBackChat.backend,
                preview:
                  rolledBackChat.turns.length > 0
                    ? rolledBackChat.turns[
                        rolledBackChat.turns.length - 1
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
    const rolledBackChat = normalizeChatDocument(result.chat);

    set({
      activeChat: rolledBackChat,
      activeChatId: chatId,
      chats: get().chats.map((c) =>
        c.id === rolledBackChat.id
          ? {
              ...c,
              title: rolledBackChat.title,
              updatedAt: rolledBackChat.updatedAt,
              acpSessionId: rolledBackChat.acpSessionId,
              backend: rolledBackChat.backend,
              preview:
                rolledBackChat.turns.length > 0
                  ? rolledBackChat.turns[
                      rolledBackChat.turns.length - 1
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
      const rawChat = await invoke<ChatDocument>("get_chat", { chatId: id });
      const chat = normalizeChatDocument(rawChat);
      // Always keep sidebar meta session ids in sync (even if not viewing).
      set({
        chats: get().chats.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                title: chat.title,
                updatedAt: chat.updatedAt,
                acpSessionId: chat.acpSessionId,
                backend: chat.backend,
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

  reloadConversation: async () => {
    const chat = get().activeChat;
    if (!chat) return;
    if (
      get().inflightChatId === chat.id ||
      chat.turns.some(
        (turn) =>
          turn.status === "streaming" || turn.status === "cancelling",
      )
    ) {
      throw new Error("Cannot reload a conversation while a response is running");
    }

    set({ error: null });
    try {
      const project = get().projects.find(
        (candidate) => candidate.id === chat.projectId,
      );
      const environmentId =
        project?.environmentId || get().activeEnvironmentId;
      if (!get().isRuntimeConnected(environmentId, chat.backend)) {
        await get().connectAgent(environmentId, chat.backend);
      }
      const result = await invoke<{
        chat: ChatDocument;
        status: string;
        message: string;
      }>("reload_chat_session", { chatId: chat.id });
      const replayed = normalizeChatDocument(result.chat);

      if (replayed.backend === "codex") {
        const childIds = [
          ...new Set(
            replayed.turns.flatMap((turn) =>
              turn.intermediate
                .filter((block) => block.type === "subagent")
                .map((block) => block.subagentId),
            ),
          ),
        ];
        await Promise.allSettled(
          childIds.map((subagentId) =>
            invoke("watch_subagent_session", {
              chatId: replayed.id,
              subagentId,
            }),
          ),
        );
      }

      await get().refreshChat(chat.id);
      get().pushLog(`[session] Reloaded ${chat.title}`);
    } catch (error) {
      if (get().activeChatId === chat.id) {
        set({ error: String(error) });
      }
      throw error;
    }
  },

  applySessionUpdate: async (
    sessionId: string,
    update: unknown,
    environmentId?: string,
    backend?: AgentBackend,
  ) => {
    // Buffer only — never await per-token IPC. That was the "agent finished but
    // UI still drips" bug: hundreds of serial invokes behind a drained stream.
    enqueueSessionUpdate(sessionId, update, environmentId, backend);
    scheduleSessionApplies(set, get, sessionId);
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
    set({ activeChat: normalizeChatDocument(chat) });
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
    set({ activeChat: normalizeChatDocument(chat) });
  },

  respondPermission: async (optionId, cancelled = false) => {
    const p = get().permission;
    if (!p) return;
    await invoke("respond_permission", {
      requestId: p.requestId,
      optionId,
      cancelled,
      environmentId: p.environmentId ?? null,
      backend: normalizeAgentBackend(p.backend),
    });
    set({ permission: null });
  },

  setPermission: (p) =>
    set({
      permission: p
        ? { ...p, backend: normalizeAgentBackend(p.backend) }
        : null,
    }),
  pushLog: (msg) => set({ logs: [...get().logs.slice(-200), msg] }),
  setAgentStatus: (s) => {
    const envId =
      s.environmentId ??
      get().agent.environmentId ??
      get().activeEnvironmentId;
    const backend = normalizeAgentBackend(s.backend);
    let connectedRuntimes = get().connectedRuntimes;
    if (typeof s.connected === "boolean" && envId) {
      if (s.connected) {
        connectedRuntimes = normalizeRuntimes([
          ...connectedRuntimes,
          { environmentId: envId, backend },
        ]);
      } else {
        connectedRuntimes = connectedRuntimes.filter(
          (runtime) =>
            runtime.environmentId !== envId || runtime.backend !== backend,
        );
      }
    }
    const connectedEnvironments = connectedEnvironmentIds(connectedRuntimes);
    const targetIsActive =
      envId === get().activeEnvironmentId &&
      backend === get().activeBackend;
    const activeConnected = hasRuntime(
      connectedRuntimes,
      get().activeEnvironmentId,
      get().activeBackend,
    );
    set({
      connectedEnvironments,
      connectedRuntimes,
      agent: {
        ...get().agent,
        ...(targetIsActive ? s : {}),
        connected: activeConnected,
        environmentId: get().activeEnvironmentId,
        backend: get().activeBackend,
      },
    });
  },
}));

export { chatsForProject, projectsForEnv };
