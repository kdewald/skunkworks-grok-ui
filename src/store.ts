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

/** Serialize apply_session_update invokes so UI state never lands out of order. */
let applyQueue: Promise<void> = Promise.resolve();

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
    attachments?: Array<{
      kind: string;
      data: string;
      mimeType: string;
      name?: string;
      dataUrl?: string;
    }>,
  ) => Promise<void>;
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
      set({ activeChatId: null, activeChat: null });
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
      set({
        chats: [meta, ...get().chats.filter((c) => c.id !== meta.id)],
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
    await invoke("set_active_chat", { chatId });
    set({ activeChatId: chatId });
    await get().refreshChat(chatId);

    const chat = get().activeChat;
    const project = get().projects.find((p) => p.id === chat?.projectId);
    const envId = project?.environmentId || get().activeEnvironmentId;

    if (!get().connectedEnvironments.includes(envId)) {
      try {
        await get().connectAgent(envId);
      } catch (e) {
        get().pushLog(`[session] connect failed: ${e}`);
        return;
      }
    }

    if (get().connectedEnvironments.includes(envId)) {
      try {
        const res = await invoke<{
          chat: ChatDocument;
          status: string;
          message: string;
        }>("ensure_chat_session", { chatId });
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
    }
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
  },

  cancelPrompt: async () => {
    const chatId = get().activeChatId;
    if (!chatId) return;
    await invoke("cancel_prompt", { chatId });
  },

  refreshChat: async (chatId?: string) => {
    const id = chatId ?? get().activeChatId;
    if (!id) return;
    const chat = await invoke<ChatDocument>("get_chat", { chatId: id });
    set({ activeChat: chat, activeChatId: id });
  },

  applySessionUpdate: async (sessionId: string, update: unknown) => {
    applyQueue = applyQueue
      .then(async () => {
        const bySession = get().chats.find((c) => c.acpSessionId === sessionId);
        const active = get().activeChat;
        let targetId: string | null = null;
        if (bySession) targetId = bySession.id;
        else if (active?.acpSessionId === sessionId) targetId = active.id;
        else if (active) targetId = active.id;
        if (!targetId) return;

        const updated = await invoke<ChatDocument>("apply_session_update", {
          chatId: targetId,
          update,
        });
        if (get().activeChatId === updated.id) {
          set({ activeChat: updated });
        }
      })
      .catch((err) => {
        console.error("applySessionUpdate failed", err);
      });
    await applyQueue;
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
