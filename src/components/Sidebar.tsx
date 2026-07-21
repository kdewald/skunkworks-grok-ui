import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Globe,
  MessageSquarePlus,
  MoreVertical,
  Server,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { chatsForProject, projectsForEnv, useAppStore } from "../store";
import { LOCAL_ENV_ID, SCRATCH_PROJECT_ID, type Project } from "../types";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";

/** Chats shown under each project before “Show more”. */
const CHATS_VISIBLE_DEFAULT = 8;
const COLLAPSED_STORAGE_KEY = "skunkworks-grok-ui:project-collapsed";

function isScratchProject(p: Project | undefined | null) {
  if (!p) return false;
  return (
    p.isScratch ||
    p.id === SCRATCH_PROJECT_ID ||
    p.id.startsWith("scratch:")
  );
}

function loadCollapsedIds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function persistCollapsedIds(map: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

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
  /** projectId → show all chats (within an expanded project) */
  const [expandedChatIds, setExpandedChatIds] = useState<
    Record<string, boolean>
  >({});
  /** projectId → collapsed (chats hidden). Missing key = expanded. */
  const [collapsedIds, setCollapsedIds] = useState<Record<string, boolean>>(
    loadCollapsedIds,
  );
  const menuRef = useRef<HTMLDivElement>(null);

  function setProjectCollapsed(projectId: string, collapsed: boolean) {
    setCollapsedIds((prev) => {
      const next = { ...prev };
      if (collapsed) next[projectId] = true;
      else delete next[projectId];
      persistCollapsedIds(next);
      return next;
    });
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedIds((prev) => {
      const next = { ...prev };
      if (next[projectId]) delete next[projectId];
      else next[projectId] = true;
      persistCollapsedIds(next);
      return next;
    });
  }

  // Keep the active project expanded so its chats stay reachable.
  useEffect(() => {
    if (!activeProjectId) return;
    setCollapsedIds((prev) => {
      if (!prev[activeProjectId]) return prev;
      const next = { ...prev };
      delete next[activeProjectId];
      persistCollapsedIds(next);
      return next;
    });
  }, [activeProjectId]);

  const envProjects = projectsForEnv(projects, activeEnvironmentId);
  const activeEnv = environments.find((e) => e.id === activeEnvironmentId);
  const isRemote = activeEnvironmentId !== LOCAL_ENV_ID;
  const envConnected = connectedEnvironments.includes(activeEnvironmentId);

  // Scratch first, then the rest in existing order.
  const orderedProjects = useMemo(() => {
    const scratch = envProjects.filter(isScratchProject);
    const rest = envProjects.filter((p) => !isScratchProject(p));
    return [...scratch, ...rest];
  }, [envProjects]);

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

  async function onNewChat(projectId: string) {
    setMenuProjectId(null);
    if (activeProjectId !== projectId) {
      await selectProject(projectId);
    }
    await createChat();
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

      <div className="sidebar-section projects-tree-section grow">
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
          className={`project-tree ${menuProjectId ? "has-open-menu" : ""}`}
        >
          {orderedProjects.length === 0 && (
            <div className="empty-hint">
              Open a project folder to get started, or use Scratch.
            </div>
          )}

          {orderedProjects.map((p) => {
            const scratch = isScratchProject(p);
            const menuOpen = menuProjectId === p.id;
            const isActiveProject = p.id === activeProjectId;
            const displayName = scratch ? "Scratch" : p.name || "Untitled";
            const projectChats = chatsForProject(chats, p.id);
            const isCollapsed = !!collapsedIds[p.id];
            const showAll = !!expandedChatIds[p.id];
            const visibleChats = showAll
              ? projectChats
              : projectChats.slice(0, CHATS_VISIBLE_DEFAULT);
            const hiddenCount = projectChats.length - visibleChats.length;
            const remoteHost =
              isRemote && !scratch
                ? activeEnv?.sshHost || activeEnv?.name
                : null;
            const canExpand = projectChats.length > 0;

            return (
              <div
                key={p.id}
                className={[
                  "project-group",
                  isActiveProject ? "is-active-project" : "",
                  isCollapsed ? "is-collapsed" : "is-expanded",
                  scratch ? "is-scratch" : "",
                  menuOpen ? "menu-open" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div
                  className={[
                    "project-row",
                    isActiveProject ? "active" : "",
                    menuOpen ? "menu-open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <button
                    type="button"
                    className={`project-collapse-btn ${canExpand ? "" : "is-empty"}`}
                    title={
                      !canExpand
                        ? "No chats yet"
                        : isCollapsed
                          ? "Expand chats"
                          : "Collapse chats"
                    }
                    aria-label={
                      isCollapsed
                        ? `Expand ${displayName}`
                        : `Collapse ${displayName}`
                    }
                    aria-expanded={!isCollapsed && canExpand}
                    disabled={!canExpand}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canExpand) return;
                      toggleProjectCollapsed(p.id);
                    }}
                  >
                    {isCollapsed || !canExpand ? (
                      <ChevronRight size={14} strokeWidth={2} />
                    ) : (
                      <ChevronDown size={14} strokeWidth={2} />
                    )}
                  </button>

                  <button
                    type="button"
                    className="project-row-main"
                    title={scratch ? "Scratch workspace" : p.path}
                    onClick={() => {
                      setMenuProjectId(null);
                      // Second click on the already-active, expanded project collapses it.
                      if (isActiveProject && !isCollapsed && canExpand) {
                        setProjectCollapsed(p.id, true);
                        return;
                      }
                      setProjectCollapsed(p.id, false);
                      void selectProject(p.id);
                    }}
                  >
                    <span className="project-row-icon" aria-hidden>
                      {scratch ? (
                        <Sparkles size={14} strokeWidth={1.75} />
                      ) : isRemote ? (
                        <Globe size={14} strokeWidth={1.75} />
                      ) : (
                        <Folder size={14} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="project-row-name">{displayName}</span>
                    {isCollapsed && projectChats.length > 0 && (
                      <span
                        className="project-chat-count"
                        title={`${projectChats.length} chats`}
                      >
                        {projectChats.length}
                      </span>
                    )}
                    {remoteHost && (
                      <span className="project-remote-host" title={remoteHost}>
                        {remoteHost}
                      </span>
                    )}
                    {isRemote && envConnected && !scratch && (
                      <span
                        className="project-remote-dot"
                        title="Connected"
                        aria-hidden
                      />
                    )}
                  </button>

                  <div
                    className="project-row-actions"
                    ref={menuOpen ? menuRef : undefined}
                  >
                    <button
                      type="button"
                      className="project-action-btn"
                      title={scratch ? "New scratch chat" : "New chat"}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectCollapsed(p.id, false);
                        void onNewChat(p.id);
                      }}
                    >
                      <MessageSquarePlus size={14} strokeWidth={1.75} />
                    </button>
                    {!scratch && (
                      <>
                        <button
                          type="button"
                          className="project-action-btn"
                          title="Project options"
                          aria-label={`Options for ${displayName}`}
                          aria-expanded={menuOpen}
                          aria-haspopup="menu"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuProjectId(menuOpen ? null : p.id);
                          }}
                        >
                          <MoreVertical size={14} strokeWidth={1.75} />
                        </button>
                        {menuOpen && (
                          <div className="project-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="project-menu-item"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuProjectId(null);
                                if (canExpand) {
                                  toggleProjectCollapsed(p.id);
                                }
                              }}
                            >
                              {isCollapsed ? (
                                <>
                                  <ChevronDown size={13} strokeWidth={1.75} />
                                  Expand chats
                                </>
                              ) : (
                                <>
                                  <ChevronRight size={13} strokeWidth={1.75} />
                                  Collapse chats
                                </>
                              )}
                            </button>
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

                {!isCollapsed && visibleChats.length > 0 && (
                  <div className="project-chats">
                    {visibleChats.map((c) => (
                      <div
                        key={c.id}
                        className={`nested-chat ${c.id === activeChatId ? "active" : ""}`}
                        onClick={() => void selectChat(c.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void selectChat(c.id);
                          }
                        }}
                      >
                        <div className="nested-chat-title">
                          {c.title || "Untitled"}
                        </div>
                        <button
                          type="button"
                          className="chat-delete"
                          title="Delete chat"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm("Delete this chat?")) deleteChat(c.id);
                          }}
                        >
                          <X size={13} strokeWidth={1.75} />
                        </button>
                      </div>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        className="show-more-chats"
                        onClick={() =>
                          setExpandedChatIds((prev) => ({
                            ...prev,
                            [p.id]: true,
                          }))
                        }
                      >
                        Show more ({hiddenCount})
                      </button>
                    )}
                    {showAll && projectChats.length > CHATS_VISIBLE_DEFAULT && (
                      <button
                        type="button"
                        className="show-more-chats"
                        onClick={() =>
                          setExpandedChatIds((prev) => ({
                            ...prev,
                            [p.id]: false,
                          }))
                        }
                      >
                        Show less
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
