import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentStatus,
  AppData,
  ChatDocument,
  ChatMeta,
  PermissionRequest,
  Project,
} from "./types";
import { SCRATCH_PROJECT_ID } from "./types";

/** Serialize apply_session_update invokes so UI state never lands out of order. */
let applyQueue: Promise<void> = Promise.resolve();

type AppStore = {
  ready: boolean;
  dataDir: string;
  agent: AgentStatus;
  projects: Project[];
  chats: ChatMeta[];
  activeProjectId: string | null;
  activeChatId: string | null;
  activeChat: ChatDocument | null;
  permission: PermissionRequest | null;
  busy: boolean;
  error: string | null;
  logs: string[];

  bootstrap: () => Promise<void>;
  connectAgent: () => Promise<void>;
  addProject: (path: string) => Promise<void>;
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

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  dataDir: "",
  agent: { connected: false, message: "Not connected" },
  projects: [],
  chats: [],
  activeProjectId: null,
  activeChatId: null,
  activeChat: null,
  permission: null,
  busy: false,
  error: null,
  logs: [],

  bootstrap: async () => {
    try {
      const res = await invoke<{
        data: AppData;
        dataDir: string;
        agentConnected: boolean;
      }>("get_bootstrap");
      set({
        ready: true,
        dataDir: res.dataDir,
        projects: res.data.projects ?? [],
        chats: res.data.chats ?? [],
        activeProjectId: res.data.activeProjectId ?? null,
        activeChatId: res.data.activeChatId ?? null,
        agent: {
          connected: res.agentConnected,
          message: res.agentConnected ? "Connected" : "Not connected",
        },
      });
      if (res.data.activeChatId) {
        await get().refreshChat(res.data.activeChatId);
      }
    } catch (e) {
      set({ error: String(e), ready: true });
    }
  },

  connectAgent: async () => {
    set({ busy: true, error: null });
    try {
      await invoke("connect_agent");
      set({
        agent: { connected: true, message: "Connected to Grok agent" },
        busy: false,
      });
    } catch (e) {
      set({
        agent: { connected: false, message: String(e) },
        error: String(e),
        busy: false,
      });
      throw e;
    }
  },

  addProject: async (path: string) => {
    const project = await invoke<Project>("add_project", { path });
    const projects = [...get().projects.filter((p) => p.id !== project.id), project];
    set({ projects, activeProjectId: project.id });
    await invoke("set_active_project", { projectId: project.id });
  },

  removeProject: async (projectId: string) => {
    if (projectId === SCRATCH_PROJECT_ID) {
      throw new Error("Scratch workspace can't be removed");
    }
    await invoke("remove_project", { projectId });
    const projects = get().projects.filter((p) => p.id !== projectId);
    const chats = get().chats.filter((c) => c.projectId !== projectId);
    const activeProjectId =
      get().activeProjectId === projectId
        ? SCRATCH_PROJECT_ID
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
    await invoke("set_active_project", { projectId });
    set({ activeProjectId: projectId });
    const first = chatsForProject(get().chats, projectId)[0];
    if (first) {
      await get().selectChat(first.id);
    } else {
      set({ activeChatId: null, activeChat: null });
    }
  },

  createChat: async () => {
    // No project selected → Scratch (temp folder under the home directory)
    const projectId = get().activeProjectId ?? SCRATCH_PROJECT_ID;
    if (!get().agent.connected) {
      await get().connectAgent();
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
    // Restore ACP session so follow-up messages don't hit "unknown session id".
    if (get().agent.connected) {
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
          set({
            error: null,
          });
          get().pushLog(`[session] ${res.message}`);
        }
      } catch (e) {
        // Non-fatal for browsing; send will retry ensure.
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
    if (!get().agent.connected) {
      await get().connectAgent();
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
  pushLog: (msg) =>
    set({ logs: [...get().logs.slice(-200), msg] }),
  setAgentStatus: (s) => set({ agent: { ...get().agent, ...s } }),
}));

export { chatsForProject };
