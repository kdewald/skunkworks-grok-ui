import { useCallback, useEffect, useRef, useState } from "react";
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

type LiveTerm = {
  term: Terminal;
  fit: FitAddon;
  ptyId: string | null;
  openGen: number;
};

function newClientId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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

  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [height, setHeight] = useState(260);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  /** clientId → live xterm + pty */
  const livesRef = useRef<Map<string, LiveTerm>>(new Map());
  /** clientId → host element */
  const hostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  /** ptyId → clientId for routing output */
  const ptyToClientRef = useRef<Map<string, string>>(new Map());
  /** Buffer PTY output until tab adopts the id */
  const pendingOutputRef = useRef<Map<string, string>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const updateTab = useCallback(
    (clientId: string, patch: Partial<TabMeta>) => {
      setTabs((prev) =>
        prev.map((t) => (t.clientId === clientId ? { ...t, ...patch } : t)),
      );
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

      // Kill previous PTY if restarting.
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

        const index = tabsRef.current.findIndex((t) => t.clientId === clientId);
        updateTab(clientId, {
          ptyId: info.id,
          cwd: info.cwd,
          remote: info.remote,
          title: tabTitle(index < 0 ? tabsRef.current.length : index, info.cwd, info.remote),
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
      const index = tabsRef.current.length;
      const meta: TabMeta = {
        clientId,
        ptyId: null,
        title: `Terminal ${index + 1}`,
        cwd: null,
        remote: false,
        exited: false,
        error: null,
        projectId: activeProjectId,
        chatId,
      };
      setTabs((prev) => [...prev, meta]);
      setActiveTabId(clientId);
      if (opts?.focus !== false) setTerminalOpen(true);

      // Wait for host ref to attach after render.
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
    ],
  );

  const closeTab = useCallback(
    async (clientId: string) => {
      await disposeTab(clientId);
      setTabs((prev) => {
        const next = prev.filter((t) => t.clientId !== clientId);
        // Renumber default titles that are still generic? keep cwd titles.
        if (next.length === 0) {
          setActiveTabId(null);
          setTerminalOpen(false);
        } else {
          setActiveTabId((cur) => {
            if (cur && cur !== clientId) return cur;
            // Prefer neighbor of closed tab.
            const idx = prev.findIndex((t) => t.clientId === clientId);
            const neighbor =
              next[Math.min(idx, next.length - 1)] ?? next[next.length - 1];
            return neighbor?.clientId ?? null;
          });
        }
        return next;
      });
    },
    [disposeTab, setTerminalOpen],
  );

  const closePanel = useCallback(() => {
    setTerminalOpen(false);
  }, [setTerminalOpen]);

  const closeAllAndHide = useCallback(async () => {
    const ids = tabsRef.current.map((t) => t.clientId);
    for (const id of ids) {
      await disposeTab(id);
    }
    setTabs([]);
    setActiveTabId(null);
    setTerminalOpen(false);
  }, [disposeTab, setTerminalOpen]);

  // Backend PTY → correct xterm tab.
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

  // Opening the panel with no tabs → create the first terminal.
  useEffect(() => {
    if (!terminalOpen || !activeProjectId) return;
    if (tabsRef.current.length > 0) {
      // Refit / focus active tab after show.
      const id = activeTabIdRef.current ?? tabsRef.current[0]?.clientId;
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

  // Cleanup all on unmount / no project.
  useEffect(() => {
    if (!activeProjectId) {
      void (async () => {
        const ids = [...livesRef.current.keys()];
        for (const id of ids) await disposeTab(id);
        setTabs([]);
        setActiveTabId(null);
      })();
    }
    return () => {
      const ids = [...livesRef.current.keys()];
      for (const id of ids) void disposeTab(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Fit active tab on height / open / tab switch.
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
  }, [terminalOpen, height, activeTabId, fitTab]);

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

  // No project → nothing. When closed, stay mounted (hidden) so tabs/PTYs survive.
  if (!activeProjectId) return null;
  if (!terminalOpen && tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.clientId === activeTabId) ?? tabs[0];

  return (
    <div
      className={`terminal-dock ${terminalOpen ? "is-open" : "is-hidden"}`}
      style={terminalOpen ? { height } : undefined}
      aria-hidden={!terminalOpen}
    >
      {terminalOpen && (
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
            title="Close all terminals"
            onClick={() => void closeAllAndHide()}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="terminal-hosts">
        {tabs.map((tab) => (
          <div
            key={tab.clientId}
            className={`terminal-host ${
              tab.clientId === (activeTab?.clientId ?? activeTabId)
                ? "is-active"
                : "is-hidden"
            }`}
            ref={(el) => {
              if (el) hostsRef.current.set(tab.clientId, el);
              else hostsRef.current.delete(tab.clientId);
            }}
            onClick={() => livesRef.current.get(tab.clientId)?.term.focus()}
          />
        ))}
      </div>
    </div>
  );
}
