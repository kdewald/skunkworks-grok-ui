import type { ReactNode } from "react";
import { FolderTree, MessageSquare, SquareTerminal } from "lucide-react";
import { useAppStore } from "../store";
import type { WorkspaceMode } from "../types";

type Props = {
  title: string;
  subtitle?: ReactNode;
};

export function WorkspaceHeader({ title, subtitle }: Props) {
  const workspaceMode = useAppStore((s) => s.workspaceMode);
  const setWorkspaceMode = useAppStore((s) => s.setWorkspaceMode);
  const terminalOpen = useAppStore((s) => s.terminalOpen);
  const setTerminalOpen = useAppStore((s) => s.setTerminalOpen);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

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
