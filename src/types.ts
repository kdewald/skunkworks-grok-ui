export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  /** Built-in temp workspace for chats without a real project. */
  isScratch?: boolean;
};

export const SCRATCH_PROJECT_ID = "scratch";

export type ChatMeta = {
  id: string;
  projectId: string;
  title: string;
  acpSessionId?: string | null;
  preview?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlanEntry = {
  content: string;
  priority?: string | null;
  status?: string | null;
};

export type IntermediateBlock =
  | {
      type: "thought";
      id: string;
      text: string;
      collapsed: boolean;
    }
  | {
      type: "tool";
      id: string;
      toolCallId: string;
      title: string;
      kind?: string | null;
      status: string;
      rawInput?: unknown;
      content?: unknown;
      rawOutput?: unknown;
      collapsed: boolean;
    }
  | {
      type: "plan";
      id: string;
      entries: PlanEntry[];
      collapsed: boolean;
    };

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | string;
  mimeType: string;
  path: string;
  dataUrl?: string | null;
  size?: number;
};

export type Turn = {
  id: string;
  userMessage: string;
  intermediate: IntermediateBlock[];
  assistantMessage: string;
  status: "streaming" | "complete" | "error" | "cancelled" | string;
  intermediateCollapsed: boolean;
  attachments?: FileAttachment[];
  createdAt: string;
};

export type ChatDocument = {
  id: string;
  projectId: string;
  title: string;
  acpSessionId?: string | null;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
};

export type AppData = {
  projects: Project[];
  chats: ChatMeta[];
  activeProjectId?: string | null;
  activeChatId?: string | null;
};

export type PermissionRequest = {
  requestId: number;
  sessionId: string;
  toolCall: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
  };
  options: Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
};

export type AgentStatus = {
  connected: boolean;
  message: string;
  agentInfo?: unknown;
};


