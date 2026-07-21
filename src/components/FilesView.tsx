import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  RefreshCw,
} from "lucide-react";
import { useAppStore } from "../store";
import { chipId } from "../contextChips";
import type {
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceListing,
} from "../types";
import { SCRATCH_PROJECT_ID } from "../types";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { Composer } from "./Composer";
import { displayPath } from "../pathDisplay";

type TreeState = {
  expanded: Record<string, boolean>;
  children: Record<string, WorkspaceEntry[] | undefined>;
  loading: Record<string, boolean>;
  error: string | null;
};

type CtxMenu =
  | {
      kind: "tree-file";
      x: number;
      y: number;
      path: string;
    }
  | {
      kind: "tree-dir";
      x: number;
      y: number;
      path: string;
    }
  | {
      kind: "viewer";
      x: number;
      y: number;
      path: string;
      hasSelection: boolean;
      binary: boolean;
    };

const emptyTree = (): TreeState => ({
  expanded: {},
  children: {},
  loading: {},
  error: null,
});

function clampMenuPos(x: number, y: number, w = 200, h = 120) {
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return {
    x: Math.min(Math.max(8, x), maxX),
    y: Math.min(Math.max(8, y), maxY),
  };
}

export function FilesView() {
  const {
    activeProjectId,
    activeChatId,
    projects,
    addContextChip,
    setWorkspaceMode,
  } = useAppStore();

  const project = projects.find((p) => p.id === activeProjectId);
  const isScratch =
    project?.isScratch ||
    project?.id === SCRATCH_PROJECT_ID ||
    (project?.id.startsWith("scratch:") ?? false);

  const [tree, setTree] = useState<TreeState>(emptyTree);
  const [rootLabel, setRootLabel] = useState("project");
  const [remote, setRemote] = useState(false);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [treeWidth, setTreeWidth] = useState(260);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const chatIdForFs = isScratch ? activeChatId : null;

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Capture scroll in tree/viewer so the menu doesn't float away.
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [ctxMenu]);

  const loadDir = useCallback(
    async (relPath: string) => {
      if (!activeProjectId) return;
      setTree((t) => ({
        ...t,
        loading: { ...t.loading, [relPath]: true },
        error: null,
      }));
      try {
        const listing = await invoke<WorkspaceListing>("list_workspace_dir", {
          projectId: activeProjectId,
          path: relPath || null,
          chatId: chatIdForFs,
        });
        if (relPath === "" || relPath === listing.path) {
          setRootLabel(listing.rootLabel);
          setRemote(listing.remote);
        }
        setTree((t) => ({
          ...t,
          children: { ...t.children, [relPath]: listing.entries },
          loading: { ...t.loading, [relPath]: false },
        }));
      } catch (e) {
        setTree((t) => ({
          ...t,
          loading: { ...t.loading, [relPath]: false },
          error: String(e),
        }));
      }
    },
    [activeProjectId, chatIdForFs],
  );

  // Reset tree when project / scratch chat changes.
  useEffect(() => {
    setTree(emptyTree());
    setActivePath(null);
    setFile(null);
    setFileError(null);
    setSelection(null);
    if (activeProjectId) {
      void loadDir("");
      setTree((t) => ({ ...t, expanded: { ...t.expanded, "": true } }));
    }
  }, [activeProjectId, chatIdForFs, loadDir]);

  const openFile = useCallback(
    async (path: string) => {
      if (!activeProjectId) return;
      setActivePath(path);
      setFileLoading(true);
      setFileError(null);
      setSelection(null);
      try {
        const content = await invoke<WorkspaceFileContent>(
          "read_workspace_file",
          {
            projectId: activeProjectId,
            path,
            chatId: chatIdForFs,
          },
        );
        setFile(content);
      } catch (e) {
        setFile(null);
        setFileError(String(e));
      } finally {
        setFileLoading(false);
      }
    },
    [activeProjectId, chatIdForFs],
  );

  function toggleDir(path: string) {
    setTree((t) => {
      const willExpand = !t.expanded[path];
      if (willExpand && t.children[path] === undefined) {
        void loadDir(path);
      }
      return {
        ...t,
        expanded: { ...t.expanded, [path]: willExpand },
      };
    });
  }

  function addFileChip(path: string, content?: string) {
    addContextChip({
      id: chipId(),
      kind: "file",
      path,
      content: content?.slice(0, 80_000),
    });
  }

  function addDirChip(path: string) {
    addContextChip({
      id: chipId(),
      kind: "dir",
      path,
    });
  }

  function addSelectionChip(sel?: { start: number; end: number } | null) {
    const range = sel ?? selection;
    if (!activePath || !file || !range) return;
    const fileLines = file.content.split("\n");
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    const snippet = fileLines.slice(start - 1, end).join("\n");
    addContextChip({
      id: chipId(),
      kind: "range",
      path: activePath,
      startLine: start,
      endLine: end,
      content: snippet,
    });
  }

  function openTreeCtx(
    e: ReactMouseEvent,
    kind: "tree-file" | "tree-dir",
    path: string,
  ) {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenuPos(e.clientX, e.clientY);
    setCtxMenu({ kind, x, y, path });
  }

  function openViewerCtx(e: ReactMouseEvent) {
    e.preventDefault();
    if (!activePath || !file) return;
    // Prefer live DOM selection so right-click without prior mouseup still works.
    let range = selection;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const aEl = lineElFromNode(sel.anchorNode);
      const fEl = lineElFromNode(sel.focusNode);
      if (aEl && fEl) {
        const s = Number(aEl.dataset.line);
        const en = Number(fEl.dataset.line);
        if (s && en) {
          range = { start: Math.min(s, en), end: Math.max(s, en) };
          setSelection(range);
        }
      }
    }
    const { x, y } = clampMenuPos(e.clientX, e.clientY, 220, 140);
    setCtxMenu({
      kind: "viewer",
      x,
      y,
      path: activePath,
      hasSelection: !!range,
      binary: file.binary,
    });
  }

  const lines = useMemo(
    () => (file && !file.binary ? file.content.split("\n") : []),
    [file],
  );

  if (!activeProjectId || !project) {
    return (
      <main className="main empty-main">
        <WorkspaceHeader title="Files" />
        <div className="hero">
          <h1>No project</h1>
          <p>Select a project to browse its files.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="main files-main">
      <WorkspaceHeader
        title="Files"
        subtitle={
          <>
            <span>{project.name}</span>
            {remote && <span className="muted"> · SSH</span>}
            <span className="mono muted">
              {" "}
              · {isScratch ? "scratch" : displayPath(project.path)}
            </span>
          </>
        }
      />

      <div className="files-body">
        <aside className="file-tree" style={{ width: treeWidth }}>
          <div className="file-tree-toolbar">
            <span className="file-tree-root" title={project.path}>
              {rootLabel}
            </span>
            <button
              type="button"
              className="icon-btn"
              title="Refresh"
              onClick={() => {
                setTree(emptyTree());
                void loadDir("");
                setTree((t) => ({ ...t, expanded: { "": true } }));
              }}
            >
              <RefreshCw size={13} strokeWidth={1.75} />
            </button>
          </div>
          {tree.error && (
            <div className="file-tree-error">{tree.error}</div>
          )}
          <div className="file-tree-list">
            <TreeLevel
              path=""
              depth={0}
              tree={tree}
              activePath={activePath}
              onToggle={toggleDir}
              onOpenFile={(p) => void openFile(p)}
              onAddFile={addFileChip}
              onAddDir={addDirChip}
              onContextFile={(e, p) => openTreeCtx(e, "tree-file", p)}
              onContextDir={(e, p) => openTreeCtx(e, "tree-dir", p)}
            />
            {tree.loading[""] && !tree.children[""] && (
              <div className="file-tree-hint">Loading…</div>
            )}
          </div>
          <div
            className="file-tree-resizer"
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = treeWidth;
              const onMove = (ev: MouseEvent) => {
                setTreeWidth(
                  Math.min(Math.max(startW + (ev.clientX - startX), 180), 420),
                );
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
        </aside>

        <section className="file-viewer">
          {!activePath && (
            <div className="file-viewer-empty">
              <FolderOpen size={28} strokeWidth={1.5} />
              <p>Select a file to preview it.</p>
              <p className="muted">
                Use “Add to chat” on files or folders, or select lines in the
                viewer.
              </p>
            </div>
          )}
          {activePath && fileLoading && (
            <div className="file-viewer-empty">Loading {activePath}…</div>
          )}
          {activePath && fileError && (
            <div className="file-viewer-empty error">{fileError}</div>
          )}
          {activePath && file && !fileLoading && (
            <>
              <div className="file-viewer-bar">
                <div className="file-viewer-path mono" title={activePath}>
                  {activePath}
                  {file.truncated && (
                    <span className="file-badge">truncated</span>
                  )}
                  {file.binary && <span className="file-badge">binary</span>}
                </div>
                <div className="file-viewer-actions">
                  {selection && (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      onClick={() => addSelectionChip()}
                      title="Add selected lines to chat context"
                    >
                      <MessageSquarePlus size={14} strokeWidth={1.75} />
                      Add selection
                    </button>
                  )}
                  {!file.binary && (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      onClick={() => addFileChip(activePath, file.content)}
                      title="Add this file to chat context"
                    >
                      <FilePlus2 size={14} strokeWidth={1.75} />
                      Add file
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost-btn compact"
                    onClick={() => setWorkspaceMode("chat")}
                  >
                    Open chat
                  </button>
                </div>
              </div>
              {file.binary ? (
                <div className="file-viewer-empty">
                  Binary file ({formatBytes(file.size)}). Add the path from the
                  tree, or open it in an external editor.
                </div>
              ) : (
                <pre
                  className="file-code"
                  onContextMenu={openViewerCtx}
                  onMouseUp={() => {
                    const sel = window.getSelection();
                    if (!sel || sel.isCollapsed || !sel.rangeCount) {
                      setSelection(null);
                      return;
                    }
                    // Map selection to line numbers via data-line attributes.
                    const anchor = sel.anchorNode;
                    const focus = sel.focusNode;
                    const aEl = lineElFromNode(anchor);
                    const fEl = lineElFromNode(focus);
                    if (!aEl || !fEl) {
                      setSelection(null);
                      return;
                    }
                    const s = Number(aEl.dataset.line);
                    const e = Number(fEl.dataset.line);
                    if (!s || !e) {
                      setSelection(null);
                      return;
                    }
                    setSelection({
                      start: Math.min(s, e),
                      end: Math.max(s, e),
                    });
                  }}
                >
                  <code>
                    {lines.map((line, i) => {
                      const n = i + 1;
                      const inSel =
                        selection &&
                        n >= Math.min(selection.start, selection.end) &&
                        n <= Math.max(selection.start, selection.end);
                      return (
                        <div
                          key={n}
                          className={`file-line ${inSel ? "is-selected" : ""}`}
                          data-line={n}
                        >
                          <span className="file-line-no">{n}</span>
                          <span className="file-line-text">
                            {line || " "}
                          </span>
                        </div>
                      );
                    })}
                  </code>
                </pre>
              )}
            </>
          )}
        </section>
      </div>

      <Composer />

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="files-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
        >
          {ctxMenu.kind === "tree-file" && (
            <>
              <button
                type="button"
                role="menuitem"
                className="files-ctx-item"
                onClick={() => {
                  void openFile(ctxMenu.path);
                  setCtxMenu(null);
                }}
              >
                <FileIcon size={13} strokeWidth={1.75} />
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                className="files-ctx-item"
                onClick={() => {
                  addFileChip(ctxMenu.path);
                  setCtxMenu(null);
                }}
              >
                <FilePlus2 size={13} strokeWidth={1.75} />
                Add file to chat
              </button>
            </>
          )}
          {ctxMenu.kind === "tree-dir" && (
            <button
              type="button"
              role="menuitem"
              className="files-ctx-item"
              onClick={() => {
                addDirChip(ctxMenu.path);
                setCtxMenu(null);
              }}
            >
              <FolderPlus size={13} strokeWidth={1.75} />
              Add folder to chat
            </button>
          )}
          {ctxMenu.kind === "viewer" && (
            <>
              {ctxMenu.hasSelection && (
                <button
                  type="button"
                  role="menuitem"
                  className="files-ctx-item"
                  onClick={() => {
                    addSelectionChip();
                    setCtxMenu(null);
                  }}
                >
                  <MessageSquarePlus size={13} strokeWidth={1.75} />
                  Add selection to chat
                </button>
              )}
              {!ctxMenu.binary && (
                <button
                  type="button"
                  role="menuitem"
                  className="files-ctx-item"
                  onClick={() => {
                    if (file && !file.binary) {
                      addFileChip(ctxMenu.path, file.content);
                    } else {
                      addFileChip(ctxMenu.path);
                    }
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus2 size={13} strokeWidth={1.75} />
                  Add file to chat
                </button>
              )}
              {ctxMenu.binary && (
                <button
                  type="button"
                  role="menuitem"
                  className="files-ctx-item"
                  onClick={() => {
                    addFileChip(ctxMenu.path);
                    setCtxMenu(null);
                  }}
                >
                  <FilePlus2 size={13} strokeWidth={1.75} />
                  Add path to chat
                </button>
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

function lineElFromNode(node: Node | null): HTMLElement | null {
  let el: Node | null = node;
  while (el) {
    if (el instanceof HTMLElement && el.dataset.line) return el;
    el = el.parentNode;
  }
  return null;
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeLevel({
  path,
  depth,
  tree,
  activePath,
  onToggle,
  onOpenFile,
  onAddFile,
  onAddDir,
  onContextFile,
  onContextDir,
}: {
  path: string;
  depth: number;
  tree: TreeState;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onAddFile: (path: string) => void;
  onAddDir: (path: string) => void;
  onContextFile: (e: ReactMouseEvent, path: string) => void;
  onContextDir: (e: ReactMouseEvent, path: string) => void;
}) {
  const entries = tree.children[path];
  if (!entries) {
    if (tree.loading[path]) {
      return <div className="file-tree-hint">Loading…</div>;
    }
    return null;
  }

  return (
    <>
      {entries.map((ent) => {
        if (ent.isDir) {
          const open = !!tree.expanded[ent.path];
          return (
            <div key={ent.path} className="tree-node">
              <div
                className="tree-row is-dir"
                style={{ paddingLeft: 8 + depth * 12 }}
                onContextMenu={(e) => onContextDir(e, ent.path)}
              >
                <button
                  type="button"
                  className="tree-row-main"
                  onClick={() => onToggle(ent.path)}
                >
                  <span className="tree-chevron">
                    {open ? (
                      <ChevronDown size={13} strokeWidth={2} />
                    ) : (
                      <ChevronRight size={13} strokeWidth={2} />
                    )}
                  </span>
                  <Folder size={14} strokeWidth={1.75} className="tree-icon" />
                  <span className="tree-name">{ent.name}</span>
                </button>
                <button
                  type="button"
                  className="tree-action"
                  title="Add folder to chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddDir(ent.path);
                  }}
                >
                  <FolderPlus size={13} strokeWidth={1.75} />
                </button>
              </div>
              {open && (
                <TreeLevel
                  path={ent.path}
                  depth={depth + 1}
                  tree={tree}
                  activePath={activePath}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  onAddFile={onAddFile}
                  onAddDir={onAddDir}
                  onContextFile={onContextFile}
                  onContextDir={onContextDir}
                />
              )}
            </div>
          );
        }
        return (
          <div
            key={ent.path}
            className={`tree-row is-file ${activePath === ent.path ? "active" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onContextMenu={(e) => onContextFile(e, ent.path)}
          >
            <button
              type="button"
              className="tree-row-main"
              onClick={() => onOpenFile(ent.path)}
            >
              <span className="tree-chevron spacer" />
              <FileIcon size={14} strokeWidth={1.75} className="tree-icon" />
              <span className="tree-name">{ent.name}</span>
            </button>
            <button
              type="button"
              className="tree-action"
              title="Add file to chat"
              onClick={(e) => {
                e.stopPropagation();
                onAddFile(ent.path);
              }}
            >
              <FilePlus2 size={13} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </>
  );
}
