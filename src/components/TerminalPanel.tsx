import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  ChevronDown,
  Plus,
  RefreshCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useAppStore } from "../store";
import { displayPath } from "../pathDisplay";
import { SCRATCH_PROJECT_ID } from "../types";
import "@xterm/xterm/css/xterm.css";

type TerminalInfo = {
  id: string;
  cwd: string;
  projectId: string;
  remote: boolean;
};

type TabMeta = {
  /** Frontend tab id (stable). */
  clientId: string;
  /** Backend PTY session id (set after open). */
  ptyId: string | null;
  title: string;
  cwd: string | null;
  remote: boolean;
  exited: boolean;
  error: string | null;
  projectId: string;
  chatId: string | null;
};

type ProjectSession = {
  tabs: TabMeta[];
  activeTabId: string | null;
};

type LiveTerm = {
  term: Terminal;
  fit: FitAddon;
  ptyId: string | null;
  openGen: number;
};

function newClientId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function emptySession(): ProjectSession {
  return { tabs: [], activeTabId: null };
}

function makeTerm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily:
      "IBM Plex Mono, SF Mono, ui-monospace, Menlo, Monaco, Consolas, monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    theme: {
      background: "#1d1f21",
      foreground: "#eaeaea",
      cursor: "#f0c674",
      cursorAccent: "#1d1f21",
      selectionBackground: "rgba(240, 198, 116, 0.28)",
      black: "#1d1f21",
      red: "#cc6666",
      green: "#b5bd68",
      yellow: "#f0c674",
      blue: "#81a2be",
      magenta: "#b294bb",
      cyan: "#8abeb7",
      white: "#c5c8c6",
      brightBlack: "#7a808a",
      brightRed: "#d07070",
      brightGreen: "#c5cd78",
      brightYellow: "#f5d084",
      brightBlue: "#91b2ce",
      brightMagenta: "#c2a4cb",
      brightCyan: "#9aced7",
      brightWhite: "#eaeaea",
    },
    allowProposedApi: true,
    scrollback: 5000,
    convertEol: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}

function tabTitle(index: number, cwd: string | null, remote: boolean) {
  if (!cwd) return `Terminal ${index + 1}`;
  const base = cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
  return remote ? `${base} (SSH)` : base;
}

export function TerminalPanel() {
  const {
    activeProjectId,
    activeChatId,
    projects,
    terminalOpen,
    setTerminalOpen,
  } = useAppStore();

  const project = projects.find((p) => p.id === activeProjectId);
  const isScratch =
    project?.isScratch ||
    project?.id === SCRATCH_PROJECT_ID ||
    (project?.id.startsWith("scratch:") ?? false);

  /** Terminals are stored per project and never shown across projects. */
  const [byProject, setByProject] = useState<Record<string, ProjectSession>>(
    {},
  );
  const [height, setHeight] = useState(260);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const byProjectRef = useRef(byProject);
  byProjectRef.current = byProject;

  const session = useMemo(
    () =>
      activeProjectId
        ? (byProject[activeProjectId] ?? emptySession())
        : emptySession(),
    [byProject, activeProjectId],
  );
  const tabs = session.tabs;
  const activeTabId = session.activeTabId;

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  /** Every tab across projects — hosts stay mounted so PTYs survive project switches. */
  const allTabs = useMemo(
    () => Object.values(byProject).flatMap((s) => s.tabs),
    [byProject],
  );

  /** clientId → live xterm + pty */
  const livesRef = useRef<Map<string, LiveTerm>>(new Map());
  /** clientId → host element */
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  /** ptyId → clientId for routing output */
  const ptyToClientRef = useRef<Map<string, string>>(new Map());
  /** Buffer PTY output until tab adopts the id */
  const pendingOutputRef = useRef<Map<string, string>>(new Map());

  const patchProject = useCallback(
    (
      projectId: string,
      patch: (prev: ProjectSession) => ProjectSession,
    ) => {
      setByProject((prev) => {
        const cur = prev[projectId] ?? emptySession();
        const next = patch(cur);
        return { ...prev, [projectId]: next };
      });
    },
    [],
  );

  const updateTab = useCallback(
    (clientId: string, patch: Partial<TabMeta>) => {
      setByProject((prev) => {
        let changed = false;
        const next: Record<string, ProjectSession> = { ...prev };
        for (const [pid, sess] of Object.entries(prev)) {
          const idx = sess.tabs.findIndex((t) => t.clientId === clientId);
          if (idx < 0) continue;
          const tabs = sess.tabs.slice();
          tabs[idx] = { ...tabs[idx], ...patch };
          next[pid] = { ...sess, tabs };
          changed = true;
          break;
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const fitTab = useCallback((clientId: string) => {
    const live = livesRef.current.get(clientId);
    const host = hostsRef.current.get(clientId);
    if (!live || !host) return;
    if (host.clientWidth < 2 || host.clientHeight < 2) return;
    try {
      live.fit.fit();
    } catch {
      // ignore
    }
    if (live.ptyId && live.term.cols > 0 && live.term.rows > 0) {
      void invoke("resize_terminal", {
        terminalId: live.ptyId,
        cols: live.term.cols,
        rows: live.term.rows,
      }).catch(() => {});
    }
  }, []);

  const closePty = useCallback(async (ptyId: string | null) => {
    if (!ptyId) return;
    ptyToClientRef.current.delete(ptyId);
    pendingOutputRef.current.delete(ptyId);
    try {
      await invoke("close_terminal", { terminalId: ptyId });
    } catch {
      // already gone
    }
  }, []);

  const disposeTab = useCallback(
    async (clientId: string) => {
      const live = livesRef.current.get(clientId);
      livesRef.current.delete(clientId);
      if (live) {
        await closePty(live.ptyId);
        try {
          live.term.dispose();
        } catch {
          // ignore
        }
      }
    },
    [closePty],
  );

  const disposeProject = useCallback(
    async (projectId: string) => {
      const sess = byProjectRef.current[projectId];
      if (!sess) return;
      for (const tab of sess.tabs) {
        await disposeTab(tab.clientId);
      }
      setByProject((prev) => {
        if (!(projectId in prev)) return prev;
        const next = { ...prev };
        delete next[projectId];
        return next;
      });
    },
    [disposeTab],
  );

  const spawnShell = useCallback(
    async (
      clientId: string,
      projectId: string,
      chatId: string | null,
      force = false,
    ) => {
      const host = hostsRef.current.get(clientId);
      if (!host) return;

      let live = livesRef.current.get(clientId);
      if (!live) {
        const { term, fit } = makeTerm();
        term.open(host);
        term.onData((data) => {
          const l = livesRef.current.get(clientId);
          if (!l?.ptyId) return;
          void invoke("write_terminal", {
            terminalId: l.ptyId,
            data,
          }).catch(() => {});
        });
        term.onBinary((data) => {
          const l = livesRef.current.get(clientId);
          if (!l?.ptyId) return;
          void invoke("write_terminal", {
            terminalId: l.ptyId,
            data,
          }).catch(() => {});
        });
        live = { term, fit, ptyId: null, openGen: 0 };
        livesRef.current.set(clientId, live);
      }

      if (live.ptyId && !force) {
        requestAnimationFrame(() => {
          fitTab(clientId);
          live!.term.focus();
        });
        return;
      }

      if (live.ptyId) {
        await closePty(live.ptyId);
        live.ptyId = null;
      }

      const gen = ++live.openGen;
      updateTab(clientId, { exited: false, error: null, ptyId: null });
      live.term.reset();
      live.term.writeln("\x1b[90mStarting shell…\x1b[0m");

      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          fitTab(clientId);
          r();
        }),
      );

      const cols = Math.max(live.term.cols || 80, 40);
      const rows = Math.max(live.term.rows || 24, 8);

      try {
        const info = await invoke<TerminalInfo>("open_terminal", {
          projectId,
          chatId,
          cols,
          rows,
        });
        const current = livesRef.current.get(clientId);
        if (!current || current.openGen !== gen) {
          pendingOutputRef.current.delete(info.id);
          void closePty(info.id);
          return;
        }
        current.ptyId = info.id;
        ptyToClientRef.current.set(info.id, clientId);

        const sess = byProjectRef.current[projectId] ?? emptySession();
        const index = sess.tabs.findIndex((t) => t.clientId === clientId);
        updateTab(clientId, {
          ptyId: info.id,
          cwd: info.cwd,
          remote: info.remote,
          title: tabTitle(
            index < 0 ? sess.tabs.length : index,
            info.cwd,
            info.remote,
          ),
          exited: false,
          error: null,
        });

        current.term.reset();
        const buffered = pendingOutputRef.current.get(info.id);
        pendingOutputRef.current.delete(info.id);
        if (buffered) current.term.write(buffered);

        requestAnimationFrame(() => {
          fitTab(clientId);
          if (activeTabIdRef.current === clientId) current.term.focus();
        });
      } catch (e) {
        const current = livesRef.current.get(clientId);
        if (!current || current.openGen !== gen) return;
        const msg = String(e);
        updateTab(clientId, { error: msg, exited: false });
        current.term.writeln(
          `\r\n\x1b[31mFailed to open terminal:\x1b[0m ${msg}`,
        );
      }
    },
    [closePty, fitTab, updateTab],
  );

  const addTerminal = useCallback(
    async (opts?: { focus?: boolean }) => {
      if (!activeProjectId) return;
      const clientId = newClientId();
      const chatId = isScratch ? activeChatId : null;
      const existing =
        byProjectRef.current[activeProjectId]?.tabs.length ?? 0;
      const meta: TabMeta = {
        clientId,
        ptyId: null,
        title: `Terminal ${existing + 1}`,
        cwd: null,
        remote: false,
        exited: false,
        error: null,
        projectId: activeProjectId,
        chatId,
      };
      patchProject(activeProjectId, (prev) => ({
        tabs: [...prev.tabs, meta],
        activeTabId: clientId,
      }));
      if (opts?.focus !== false) setTerminalOpen(true);

      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await spawnShell(clientId, activeProjectId, chatId, true);
    },
    [
      activeProjectId,
      activeChatId,
      isScratch,
      setTerminalOpen,
      spawnShell,
      patchProject,
    ],
  );

  const closeTab = useCallback(
    async (clientId: string) => {
      const projectId =
        Object.entries(byProjectRef.current).find(([, s]) =>
          s.tabs.some((t) => t.clientId === clientId),
        )?.[0] ?? activeProjectIdRef.current;
      if (!projectId) return;

      await disposeTab(clientId);
      patchProject(projectId, (prev) => {
        const nextTabs = prev.tabs.filter((t) => t.clientId !== clientId);
        if (nextTabs.length === 0) {
          if (projectId === activeProjectIdRef.current) {
            setTerminalOpen(false);
          }
          return { tabs: [], activeTabId: null };
        }
        let nextActive = prev.activeTabId;
        if (nextActive === clientId || !nextTabs.some((t) => t.clientId === nextActive)) {
          const idx = prev.tabs.findIndex((t) => t.clientId === clientId);
          nextActive =
            nextTabs[Math.min(Math.max(idx, 0), nextTabs.length - 1)]
              ?.clientId ?? nextTabs[0].clientId;
        }
        return { tabs: nextTabs, activeTabId: nextActive };
      });
    },
    [disposeTab, patchProject, setTerminalOpen],
  );

  const closePanel = useCallback(() => {
    setTerminalOpen(false);
  }, [setTerminalOpen]);

  const closeAllForActiveAndHide = useCallback(async () => {
    const pid = activeProjectIdRef.current;
    if (!pid) {
      setTerminalOpen(false);
      return;
    }
    await disposeProject(pid);
    setTerminalOpen(false);
  }, [disposeProject, setTerminalOpen]);

  const setActiveTabId = useCallback(
    (clientId: string) => {
      const pid = activeProjectIdRef.current;
      if (!pid) return;
      patchProject(pid, (prev) => ({ ...prev, activeTabId: clientId }));
    },
    [patchProject],
  );

  // Backend PTY → correct xterm tab (any project).
  useEffect(() => {
    let cancelled = false;
    const unsubs: UnlistenFn[] = [];
    void (async () => {
      try {
        const dataUn = await listen<{ id: string; data: string }>(
          "terminal-data",
          (event) => {
            const { id, data } = event.payload;
            const clientId = ptyToClientRef.current.get(id);
            if (clientId) {
              livesRef.current.get(clientId)?.term.write(data);
              return;
            }
            const prev = pendingOutputRef.current.get(id) ?? "";
            pendingOutputRef.current.set(id, (prev + data).slice(-256_000));
          },
        );
        if (cancelled) {
          dataUn();
          return;
        }
        unsubs.push(dataUn);

        const exitUn = await listen<{ id: string; code?: number | null }>(
          "terminal-exit",
          (event) => {
            const ptyId = event.payload.id;
            const clientId = ptyToClientRef.current.get(ptyId);
            if (!clientId) return;
            const live = livesRef.current.get(clientId);
            if (!live || live.ptyId !== ptyId) return;
            live.ptyId = null;
            ptyToClientRef.current.delete(ptyId);
            const code = event.payload.code;
            live.term.writeln(
              `\r\n\x1b[90m[process exited${
                code != null ? ` with code ${code}` : ""
              }]\x1b[0m`,
            );
            updateTab(clientId, { exited: true, ptyId: null });
          },
        );
        if (cancelled) {
          exitUn();
          return;
        }
        unsubs.push(exitUn);
      } catch (e) {
        console.error("terminal event listen failed", e);
      }
    })();
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [updateTab]);

  // Opening the panel for a project with no tabs → create first terminal.
  // Switching projects only shows that project's parked tabs (does not carry others).
  useEffect(() => {
    if (!terminalOpen || !activeProjectId) return;
    const sess = byProjectRef.current[activeProjectId] ?? emptySession();
    if (sess.tabs.length > 0) {
      const id = sess.activeTabId ?? sess.tabs[0]?.clientId;
      if (id) {
        const t = window.setTimeout(() => {
          fitTab(id);
          livesRef.current.get(id)?.term.focus();
        }, 40);
        return () => window.clearTimeout(t);
      }
      return;
    }
    void addTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen, activeProjectId]);

  // Drop sessions for projects that were removed from the sidebar.
  useEffect(() => {
    const alive = new Set(projects.map((p) => p.id));
    const orphaned = Object.keys(byProjectRef.current).filter(
      (id) => !alive.has(id),
    );
    for (const id of orphaned) {
      void disposeProject(id);
    }
  }, [projects, disposeProject]);

  // Full cleanup only on unmount (not on project switch).
  useEffect(() => {
    return () => {
      const ids = [...livesRef.current.keys()];
      for (const id of ids) void disposeTab(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fit active tab on height / open / tab / project switch.
  useEffect(() => {
    if (!terminalOpen || !activeTabId) return;
    const host = hostsRef.current.get(activeTabId);
    if (!host) return;
    const ro = new ResizeObserver(() => fitTab(activeTabId));
    ro.observe(host);
    const t = window.setTimeout(() => {
      fitTab(activeTabId);
      livesRef.current.get(activeTabId)?.term.focus();
    }, 40);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [terminalOpen, height, activeTabId, activeProjectId, fitTab]);

  // Drag resize.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setHeight(
        Math.min(
          Math.max(d.startH + (d.startY - e.clientY), 140),
          Math.floor(window.innerHeight * 0.7),
        ),
      );
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (activeTabIdRef.current) fitTab(activeTabIdRef.current);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fitTab]);

  if (!activeProjectId) return null;
  const hasAnyTabs = allTabs.length > 0;
  if (!terminalOpen && !hasAnyTabs) return null;

  const activeTab = tabs.find((t) => t.clientId === activeTabId) ?? tabs[0];
  // Only show the dock chrome when open, or keep hosts alive while hidden.
  const showChrome = terminalOpen;

  return (
    <div
      className={`terminal-dock ${terminalOpen ? "is-open" : "is-hidden"}`}
      style={terminalOpen ? { height } : undefined}
      aria-hidden={!terminalOpen}
    >
      {showChrome && (
        <div
          className="terminal-resize-handle"
          onMouseDown={(e) => {
            e.preventDefault();
            dragRef.current = { startY: e.clientY, startH: height };
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
          }}
          title="Drag to resize"
        />
      )}

      {showChrome && (
        <div className="terminal-toolbar">
          <div className="terminal-tabs" role="tablist" aria-label="Terminals">
            {tabs.map((tab) => {
              const active =
                tab.clientId === (activeTab?.clientId ?? activeTabId);
              return (
                <div
                  key={tab.clientId}
                  className={`terminal-tab ${active ? "active" : ""} ${tab.exited ? "exited" : ""}`}
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setActiveTabId(tab.clientId);
                    requestAnimationFrame(() => {
                      fitTab(tab.clientId);
                      livesRef.current.get(tab.clientId)?.term.focus();
                    });
                  }}
                >
                  <SquareTerminal size={12} strokeWidth={1.75} />
                  <span
                    className="terminal-tab-title"
                    title={tab.cwd ?? tab.title}
                  >
                    {tab.title}
                  </span>
                  {tab.error && <span className="terminal-tab-error">!</span>}
                  <button
                    type="button"
                    className="terminal-tab-close"
                    title="Close terminal"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeTab(tab.clientId);
                    }}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="terminal-tab-add"
              title="New terminal"
              onClick={() => void addTerminal()}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>

          <div className="terminal-toolbar-actions">
            {activeTab?.cwd && (
              <span className="terminal-cwd mono" title={activeTab.cwd}>
                {activeTab.remote
                  ? activeTab.cwd
                  : displayPath(activeTab.cwd)}
              </span>
            )}
            {activeTab?.remote && <span className="terminal-badge">SSH</span>}
            {activeTab?.exited && (
              <span className="terminal-badge muted">exited</span>
            )}
            <button
              type="button"
              className="icon-btn"
              title="Restart shell"
              disabled={!activeTab}
              onClick={() => {
                if (!activeTab) return;
                void spawnShell(
                  activeTab.clientId,
                  activeTab.projectId,
                  activeTab.chatId,
                  true,
                );
              }}
            >
              <RefreshCw size={13} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Hide terminal panel"
              onClick={closePanel}
            >
              <ChevronDown size={14} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Close all terminals for this project"
              onClick={() => void closeAllForActiveAndHide()}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      <div className="terminal-hosts">
        {/* Hosts for every project stay mounted so shells survive project switches. */}
        {allTabs.map((tab) => {
          const isCurrentProject = tab.projectId === activeProjectId;
          const isActiveTab =
            isCurrentProject &&
            tab.clientId === (activeTab?.clientId ?? activeTabId);
          return (
            <div
              key={tab.clientId}
              className={`terminal-host ${
                isActiveTab && terminalOpen ? "is-active" : "is-hidden"
              }`}
              data-project={tab.projectId}
              ref={(el) => {
                if (el) hostsRef.current.set(tab.clientId, el);
                else hostsRef.current.delete(tab.clientId);
              }}
              onClick={() => livesRef.current.get(tab.clientId)?.term.focus()}
            />
          );
        })}
      </div>
    </div>
  );
}
