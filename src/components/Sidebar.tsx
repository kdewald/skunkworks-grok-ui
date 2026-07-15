import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderPlus,
  MoreVertical,
  MessageSquarePlus,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { chatsForProject, projectsForEnv, useAppStore } from "../store";
import { displayPath } from "../pathDisplay";
import { LOCAL_ENV_ID, SCRATCH_PROJECT_ID } from "../types";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";

export function Sidebar() {
  const {
    projects,
    chats,
    activeProjectId,
    activeChatId,
    agent,
    busy,
    environments,
    activeEnvironmentId,
    connectedEnvironments,
    selectProject,
    createChat,
    selectChat,
    deleteChat,
    addProject,
    removeProject,
    connectAgent,
    setActiveEnvironment,
    setConnectionsOpen,
  } = useAppStore();

  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [remoteBrowserOpen, setRemoteBrowserOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const envProjects = projectsForEnv(projects, activeEnvironmentId);
  const projectChats = chatsForProject(chats, activeProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeEnv = environments.find((e) => e.id === activeEnvironmentId);
  const isScratch =
    activeProject?.isScratch ||
    activeProjectId === SCRATCH_PROJECT_ID ||
    (activeProjectId?.startsWith("scratch:") ?? false);
  const isRemote = activeEnvironmentId !== LOCAL_ENV_ID;
  const envConnected = connectedEnvironments.includes(activeEnvironmentId);

  useEffect(() => {
    if (!menuProjectId) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuProjectId(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuProjectId(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuProjectId]);

  async function onAddProject() {
    if (isRemote) {
      setRemoteBrowserOpen(true);
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open project folder",
    });
    if (typeof selected === "string") {
      await addProject(selected, activeEnvironmentId);
    }
  }

  async function onRemoteFolderSelect(path: string) {
    await addProject(path, activeEnvironmentId);
    setRemoteBrowserOpen(false);
  }

  function onRemoveProject(projectId: string, name: string) {
    setMenuProjectId(null);
    if (
      confirm(
        `Remove “${name}” from the sidebar? Chats for this project will be deleted.`,
      )
    ) {
      void removeProject(projectId);
    }
  }

  const statusLabel = envConnected
    ? isRemote
      ? activeEnv?.name ?? "Remote"
      : "Local"
    : "Connect";

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div>
            <div className="brand-title">Skunkworks</div>
            <div className="brand-sub">Grok UI · unofficial</div>
          </div>
        </div>
        <button
          className={`status-pill ${envConnected ? "ok" : "bad"}`}
          onClick={() => connectAgent(activeEnvironmentId)}
          title={agent.message}
          disabled={busy}
        >
          <span className="dot" />
          {statusLabel}
        </button>
      </div>

      <div className="sidebar-section env-section">
        <div className="section-label-row">
          <span className="section-label">Environment</span>
          <button
            className="icon-btn"
            onClick={() => setConnectionsOpen(true)}
            title="Connections"
          >
            <Server size={14} strokeWidth={1.75} />
          </button>
        </div>
        <select
          className="env-select"
          value={activeEnvironmentId}
          onChange={(e) => void setActiveEnvironment(e.target.value)}
          disabled={busy}
        >
          {environments.map((env) => {
            const on = connectedEnvironments.includes(env.id);
            return (
              <option key={env.id} value={env.id}>
                {on ? "● " : "○ "}
                {env.name}
                {env.kind === "ssh" ? " (SSH)" : ""}
              </option>
            );
          })}
        </select>
        {isRemote && (
          <div className="env-hint" title={activeEnv?.sshHost ?? undefined}>
            SSH · {activeEnv?.sshHost ?? activeEnvironmentId}
          </div>
        )}
      </div>

      <div className="sidebar-section projects-section">
        <div className="section-label-row">
          <span className="section-label">Projects</span>
          <button
            className="icon-btn"
            onClick={() => void onAddProject()}
            title={
              isRemote ? "Browse remote project folder" : "Open project folder"
            }
          >
            <FolderPlus size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div
          className={`project-list ${menuProjectId ? "has-open-menu" : ""}`}
        >
          {envProjects.map((p) => {
            const scratch =
              p.isScratch ||
              p.id === SCRATCH_PROJECT_ID ||
              p.id.startsWith("scratch:");
            const menuOpen = menuProjectId === p.id;
            const displayName = scratch
              ? isRemote
                ? "Scratch"
                : "Scratch"
              : p.name || "Untitled";
            return (
              <div
                key={p.id}
                className={[
                  "project-item",
                  p.id === activeProjectId ? "active" : "",
                  scratch ? "is-scratch" : "",
                  menuOpen ? "menu-open" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  className="project-item-main"
                  onClick={() => {
                    setMenuProjectId(null);
                    void selectProject(p.id);
                  }}
                >
                  <div className="project-name-row">
                    {scratch && (
                      <Sparkles
                        size={12}
                        strokeWidth={1.75}
                        className="scratch-icon"
                        aria-hidden
                      />
                    )}
                    <span className="project-name">{displayName}</span>
                  </div>
                  <div className="project-path" title={p.path}>
                    {scratch
                      ? isRemote
                        ? "Remote temp folders"
                        : "No project · private temp folders"
                      : displayPath(p.path)}
                  </div>
                </button>

                <div
                  className="project-menu-wrap"
                  ref={menuOpen ? menuRef : undefined}
                >
                  {scratch ? (
                    <span className="project-menu-spacer" aria-hidden />
                  ) : (
                    <>
                      <button
                        type="button"
                        className="project-menu-btn"
                        title="Project options"
                        aria-label={`Options for ${displayName}`}
                        aria-expanded={menuOpen}
                        aria-haspopup="menu"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuProjectId(menuOpen ? null : p.id);
                        }}
                      >
                        <MoreVertical size={15} strokeWidth={1.75} />
                      </button>
                      {menuOpen && (
                        <div className="project-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            className="project-menu-item danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveProject(p.id, displayName);
                            }}
                          >
                            <Trash2 size={13} strokeWidth={1.75} />
                            Remove project
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="sidebar-section grow">
        <div className="section-label-row">
          <span className="section-label">
            Chats
            {activeProject
              ? ` · ${isScratch ? "Scratch" : activeProject.name}`
              : ""}
          </span>
          <button
            className="icon-btn"
            onClick={() => createChat()}
            disabled={busy}
            title={
              isScratch || !activeProjectId ? "New scratch chat" : "New chat"
            }
          >
            <MessageSquarePlus size={14} strokeWidth={1.75} />
          </button>
        </div>
        <div className="chat-list">
          {projectChats.length === 0 && (
            <div className="empty-hint">
              {isScratch
                ? "No scratch chats yet. Each one gets its own hidden folder."
                : activeProjectId
                  ? "No chats yet. Create one and send a message."
                  : "Select Scratch or a project, then start a chat."}
            </div>
          )}
          {projectChats.map((c) => (
            <div
              key={c.id}
              className={`chat-item ${c.id === activeChatId ? "active" : ""}`}
              onClick={() => void selectChat(c.id)}
            >
              <div className="chat-item-main">
                <div className="chat-title">{c.title || "Untitled"}</div>
                {c.preview && <div className="chat-preview">{c.preview}</div>}
              </div>
              <button
                className="chat-delete"
                title="Delete chat"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Delete this chat?")) deleteChat(c.id);
                }}
              >
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <RemoteFolderBrowser
        open={remoteBrowserOpen}
        environmentId={activeEnvironmentId}
        environmentName={activeEnv?.name ?? activeEnvironmentId}
        busy={busy}
        onClose={() => setRemoteBrowserOpen(false)}
        onSelect={onRemoteFolderSelect}
      />

      <ConnectionsPanel />
    </aside>
  );
}
