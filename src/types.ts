export type Environment = {
  id: string;
  name: string;
  /** "local" | "ssh" */
  kind: string;
  sshHost?: string | null;
  remoteGrokPath?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  /** Built-in temp workspace for chats without a real project. */
  isScratch?: boolean;
  /** `local` or `ssh:<host>` */
  environmentId?: string;
};

export const SCRATCH_PROJECT_ID = "scratch";
export const LOCAL_ENV_ID = "local";

export function scratchProjectIdForEnv(environmentId: string): string {
  if (!environmentId || environmentId === LOCAL_ENV_ID) return SCRATCH_PROJECT_ID;
  return `scratch:${environmentId}`;
}

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
    }
  | {
      type: "message";
      id: string;
      messageId?: string | null;
      text: string;
    }
  | {
      type: "subagent";
      id: string;
      subagentId: string;
      toolCallId?: string | null;
      description: string;
      status: string;
      model?: string | null;
      subagentType?: string | null;
      output: string;
      collapsed: boolean;
    }
  | {
      type: "task";
      id: string;
      taskId: string;
      toolCallId?: string | null;
      description: string;
      command: string;
      status: string;
      output: string;
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
  status:
    | "streaming"
    | "cancelling"
    | "complete"
    | "error"
    | "cancelled"
    | string;
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
  environments?: Environment[];
  activeEnvironmentId?: string | null;
};

export type PermissionRequest = {
  /** JSON-RPC id from the agent (number or string). */
  requestId: number | string;
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
  environmentId?: string;
};

export type AgentStatus = {
  connected: boolean;
  message: string;
  agentInfo?: unknown;
  environmentId?: string;
};

/** Directory entry from SSH folder browser. */
export type RemoteDirEntry = {
  name: string;
  path: string;
};

/** Listing returned by `list_remote_dir`. */
export type RemoteDirListing = {
  path: string;
  parent?: string | null;
  home: string;
  entries: RemoteDirEntry[];
  searched?: boolean;
};

/** Exclusive main-pane mode. */
export type WorkspaceMode = "chat" | "files";

/** Entry from `list_workspace_dir`. */
export type WorkspaceEntry = {
  name: string;
  /** Path relative to project root (`/` separators). */
  path: string;
  isDir: boolean;
};

export type WorkspaceListing = {
  path: string;
  entries: WorkspaceEntry[];
  rootLabel: string;
  remote: boolean;
};

export type WorkspaceFileContent = {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
  language: string;
};

/** Git change kind for Files tree coloring. */
export type GitChangeKind =
  | "untracked"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "ignored";

export type GitFileStatus = {
  path: string;
  kind: GitChangeKind;
  staged: boolean;
};

export type WorkspaceGitStatus = {
  isRepo: boolean;
  files: GitFileStatus[];
};

/**
 * Structured context sent with a message (from Files view).
 * Expanded into markdown on send — not a separate attachment type.
 */
export type ContextChip = {
  id: string;
  kind: "file" | "dir" | "range";
  /** Project-relative path. */
  path: string;
  note?: string;
  startLine?: number;
  endLine?: number;
  /** Pinned snippet for range chips (captured at add time). */
  content?: string;
};
