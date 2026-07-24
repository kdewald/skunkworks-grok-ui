import { useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { Bot, FolderTree, MessageSquare, SquareTerminal } from "lucide-react";
import { useAppStore } from "../store";
import type { WorkspaceMode } from "../types";

type Props = {
  title: string;
  subtitle?: ReactNode;
};

function isRunningStatus(status: string) {
  return (
    status === "running" ||
    status === "in_progress" ||
    status === "pending"
  );
}

export function WorkspaceHeader({ title, subtitle }: Props) {
  const workspaceMode = useAppStore((s) => s.workspaceMode);
  const setWorkspaceMode = useAppStore((s) => s.setWorkspaceMode);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);
  const subagentsOpen = useAppStore((s) => s.subagentsOpen);
  const setSubagentsOpen = useAppStore((s) => s.setSubagentsOpen);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const activeChat = useAppStore((s) => s.activeChat);
  const prevCountRef = useRef(0);

  const subagentStats = useMemo(() => {
    let count = 0;
    let running = 0;
    for (const turn of activeChat?.turns ?? []) {
      for (const b of turn.intermediate) {
        if (b.type !== "subagent") continue;
        count += 1;
        if (isRunningStatus(b.status)) running += 1;
      }
    }
    return { count, running };
  }, [activeChat]);

  // Reset rail tracking when switching chats.
  useEffect(() => {
    prevCountRef.current = 0;
    setSubagentsOpen(false);
  }, [activeChat?.id, setSubagentsOpen]);

  // Auto-open once when the first subagent appears in this chat.
  // After that, only the header toggle controls visibility (like terminal).
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = subagentStats.count;
    if (subagentStats.count === 0) {
      if (subagentsOpen) setSubagentsOpen(false);
      return;
    }
    if (prev === 0 && subagentStats.count > 0) {
      setSubagentsOpen(true);
    }
  }, [subagentStats.count, subagentsOpen, setSubagentsOpen]);

  function setMode(mode: WorkspaceMode) {
    setWorkspaceMode(mode);
  }

  return (
    <header className="chat-header workspace-header">
      <div className="workspace-header-left">
        <div className="chat-header-title">{title}</div>
        {subtitle && <div className="chat-header-sub">{subtitle}</div>}
      </div>

      <div className="workspace-header-actions">
        {activeProjectId && (
          <div className="mode-toggle" role="tablist" aria-label="Workspace mode">
            <button
              type="button"
              role="tab"
              aria-selected={workspaceMode === "chat"}
              className={`mode-toggle-btn ${workspaceMode === "chat" ? "active" : ""}`}
              onClick={() => setMode("chat")}
              title="Chat"
            >
              <MessageSquare size={14} strokeWidth={1.75} />
              <span>Chat</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceMode === "files"}
              className={`mode-toggle-btn ${workspaceMode === "files" ? "active" : ""}`}
              onClick={() => setMode("files")}
              title="Files"
            >
              <FolderTree size={14} strokeWidth={1.75} />
              <span>Files</span>
            </button>
          </div>
        )}
        {subagentStats.count > 0 && (
          <button
            type="button"
            className={`icon-btn chat-header-subagents ${subagentsOpen ? "active" : ""} ${
              subagentStats.running > 0 ? "has-running" : ""
            }`}
            title={
              subagentsOpen
                ? "Hide subagents"
                : `Show subagents (${subagentStats.count})`
            }
            onClick={() => setSubagentsOpen(!subagentsOpen)}
          >
            <Bot size={16} strokeWidth={1.75} />
            <span className="header-badge" aria-hidden>
              {subagentStats.count}
            </span>
          </button>
        )}
        <button
          type="button"
          className={`icon-btn chat-header-term ${terminalOpen ? "active" : ""}`}
          title={terminalOpen ? "Hide terminal" : "Show terminal"}
          onClick={() => setTerminalOpen(!terminalOpen)}
        >
          <SquareTerminal size={16} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}
