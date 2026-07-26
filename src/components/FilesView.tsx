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
  Save,
} from "lucide-react";
import { useAppStore } from "../store";
import { chipId } from "../contextChips";
import type {
  GitChangeKind,
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceGitStatus,
  WorkspaceListing,
} from "../types";
import { SCRATCH_PROJECT_ID } from "../types";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { Composer } from "./Composer";
import { MonacoViewer } from "./MonacoViewer";
import { lspDidSave } from "../lsp/client";
import type { LineRange } from "../editorTypes";
import { setLspWorkspace } from "../lsp/client";
import { displayPath } from "../pathDisplay";
import { buildGitStatusMap, entryGitKind, gitStatusClass } from "../gitStatus";

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
  /** Working buffer for the open file (may differ from disk when dirty). */
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Brief "Saved" flash after successful autosave / manual save. */
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const saveFileRef = useRef<() => Promise<void>>(async () => {});
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selection, setSelection] = useState<LineRange | null>(null);
  const [lspStatusMsg, setLspStatusMsg] = useState<string | null>(null);
  /** Absolute local workspace root (for Monaco model URIs / LSP). Null for SSH. */
  const [workspaceAbsRoot, setWorkspaceAbsRoot] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(260);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);

  const chatIdForFs = isScratch ? activeChatId : null;
  const gitMap = useMemo(() => buildGitStatusMap(gitStatus), [gitStatus]);

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

  const loadGitStatus = useCallback(async () => {
    if (!activeProjectId) {
      setGitStatus(null);
      return;
    }
    try {
      const st = await invoke<WorkspaceGitStatus>("git_workspace_status", {
        projectId: activeProjectId,
        chatId: chatIdForFs,
      });
      setGitStatus(st);
    } catch {
      setGitStatus(null);
    }
  }, [activeProjectId, chatIdForFs]);

  // Reset tree when project / scratch chat changes.
  useEffect(() => {
    setTree(emptyTree());
    setActivePath(null);
    setFile(null);
    setFileError(null);
    setSelection(null);
    setGitStatus(null);
    if (activeProjectId) {
      void loadDir("");
      void loadGitStatus();
      setTree((t) => ({ ...t, expanded: { ...t.expanded, "": true } }));
    }
  }, [activeProjectId, chatIdForFs, loadDir, loadGitStatus]);

  // Point the LSP hub at the local workspace root (no-op for SSH).
  useEffect(() => {
    if (!activeProjectId) {
      setWorkspaceAbsRoot(null);
      return;
    }
    let cancelled = false;
    void setLspWorkspace({
      projectId: activeProjectId,
      chatId: chatIdForFs,
      remote,
    }).then((root) => {
      if (!cancelled) setWorkspaceAbsRoot(root);
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, chatIdForFs, remote]);

  // Refresh git status when Files is focused / periodically while open.
  useEffect(() => {
    if (!activeProjectId) return;
    const onFocus = () => void loadGitStatus();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(() => void loadGitStatus(), 12_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(t);
    };
  }, [activeProjectId, loadGitStatus]);

  /** Guards late open/save results when the user switches files quickly. */
  const fileSessionGen = useRef(0);

  const openFile = useCallback(
    async (path: string) => {
      if (!activeProjectId) return;
      const gen = ++fileSessionGen.current;
      setActivePath(path);
      setFileLoading(true);
      setFileError(null);
      setSaveError(null);
      setSelection(null);
      setDirty(false);
      try {
        const content = await invoke<WorkspaceFileContent>(
          "read_workspace_file",
          {
            projectId: activeProjectId,
            path,
            chatId: chatIdForFs,
          },
        );
        if (fileSessionGen.current !== gen) return;
        setFile(content);
        setDraft(content.binary ? "" : content.content);
      } catch (e) {
        if (fileSessionGen.current !== gen) return;
        setFile(null);
        setDraft("");
        setFileError(String(e));
      } finally {
        if (fileSessionGen.current === gen) {
          setFileLoading(false);
        }
      }
    },
    [activeProjectId, chatIdForFs],
  );

  const canEdit =
    !!file && !file.binary && !file.truncated && !fileLoading;

  const saveFile = useCallback(async () => {
    if (!activeProjectId || !activePath || !file || !canEdit || saving) return;
    // Avoid no-op saves (e.g. autosave race after manual save).
    if (!dirty && draft === file.content) return;
    const gen = fileSessionGen.current;
    const path = activePath;
    const snapshot = draft;
    const fileSnap = file;
    setSaving(true);
    setSaveError(null);
    setJustSaved(false);
    try {
      await invoke("write_workspace_file", {
        projectId: activeProjectId,
        path,
        content: snapshot,
        chatId: chatIdForFs,
      });
      // Late save must not clobber a different open file.
      if (fileSessionGen.current !== gen || activePath !== path) return;
      setFile({
        ...fileSnap,
        content: snapshot,
        size: new TextEncoder().encode(snapshot).length,
        truncated: false,
      });
      setDirty(false);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 1500);
      void lspDidSave(path, snapshot);
      void loadGitStatus();
    } catch (e) {
      if (fileSessionGen.current === gen) {
        setSaveError(String(e));
      }
    } finally {
      if (fileSessionGen.current === gen) {
        setSaving(false);
      }
    }
  }, [
    activeProjectId,
    activePath,
    file,
    canEdit,
    saving,
    dirty,
    draft,
    chatIdForFs,
    loadGitStatus,
  ]);

  saveFileRef.current = () => saveFile();

  /** Debounced autosave (~900ms after last edit). */
  useEffect(() => {
    if (!dirty || !canEdit || saving) return;
    if (autosaveTimer.current != null) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      void saveFileRef.current();
    }, 900);
    return () => {
      if (autosaveTimer.current != null) {
        window.clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
    };
  }, [draft, dirty, canEdit, saving, activePath]);

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      setDirty(value !== (file?.content ?? ""));
      setSaveError(null);
      setJustSaved(false);
    },
    [file?.content],
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
    if (!activePath || !file || file.binary || !range) return;
    // Prefer the live draft (what Monaco shows), not the last disk snapshot.
    const source = draft.length > 0 || dirty ? draft : file.content;
    const fileLines = source.split("\n");
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
              title="Refresh tree & git status"
              onClick={() => {
                setTree(emptyTree());
                void loadDir("");
                void loadGitStatus();
                setTree((t) => ({ ...t, expanded: { "": true } }));
              }}
            >
              <RefreshCw size={13} strokeWidth={1.75} />
            </button>
          </div>
          {gitStatus?.isRepo && (
            <div className="file-tree-git-legend" title="Git status colors">
              <span className="git-untracked">new</span>
              <span className="git-modified">mod</span>
              <span className="git-added">add</span>
              <span className="git-deleted">del</span>
              <span className="git-ignored">ign</span>
            </div>
          )}
          {tree.error && (
            <div className="file-tree-error">{tree.error}</div>
          )}
          <div className="file-tree-list">
            <TreeLevel
              path=""
              depth={0}
              tree={tree}
              activePath={activePath}
              gitMap={gitMap}
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
                  {dirty && <span className="file-badge dirty">edited</span>}
                  {!file.binary && file.language && file.language !== "text" && (
                    <span className="file-badge lang">{file.language}</span>
                  )}
                  {file.truncated && (
                    <span className="file-badge">truncated</span>
                  )}
                  {file.binary && <span className="file-badge">binary</span>}
                </div>
                <div className="file-viewer-actions">
                  {lspStatusMsg && (
                    <span className="file-badge lsp" title={lspStatusMsg}>
                      {lspStatusMsg}
                    </span>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className={
                        dirty
                          ? "ghost-btn compact is-save-dirty"
                          : "ghost-btn compact"
                      }
                      onClick={() => void saveFile()}
                      disabled={(!dirty && !justSaved) || saving}
                      title="Autosaves after you pause typing; ⌘S / Ctrl+S saves now"
                    >
                      <Save size={14} strokeWidth={1.75} />
                      {saving
                        ? "Saving…"
                        : justSaved
                          ? "Saved"
                          : dirty
                            ? "Save"
                            : "Saved"}
                    </button>
                  )}
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
                      onClick={() => addFileChip(activePath, draft)}
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
              {saveError && (
                <div className="file-save-error" role="alert">
                  {saveError}
                </div>
              )}
              {file.truncated && !file.binary && (
                <div className="file-save-error muted" role="status">
                  File is truncated in the preview — open it externally to edit
                  the full contents.
                </div>
              )}
              {file.binary ? (
                <div className="file-viewer-empty">
                  Binary file ({formatBytes(file.size)}). Add the path from the
                  tree, or open it in an external editor.
                </div>
              ) : (
                <MonacoViewer
                  content={draft}
                  language={file.language}
                  path={activePath}
                  modelPath={
                    workspaceAbsRoot && activePath
                      ? `${workspaceAbsRoot.replace(/\/+$/, "")}/${activePath.replace(/^\/+/, "")}`
                      : undefined
                  }
                  editable={canEdit}
                  onChange={onDraftChange}
                  onSave={() => void saveFile()}
                  onSelectionChange={setSelection}
                  onLspStatus={setLspStatusMsg}
                  onAddSelectionToChat={(range) => {
                    setSelection(range);
                    addSelectionChip(range);
                  }}
                  onAddFileToChat={() => {
                    if (activePath) addFileChip(activePath, draft);
                  }}
                />
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
        </div>
      )}
    </main>
  );
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
  gitMap,
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
  gitMap: Map<string, { path: string; kind: GitChangeKind; staged: boolean }>;
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
          const kind = entryGitKind(ent.path, true, gitMap);
          const gClass = gitStatusClass(kind);
          return (
            <div key={ent.path} className="tree-node">
              <div
                className={`tree-row is-dir ${gClass}`}
                style={{ paddingLeft: 8 + depth * 12 }}
                onContextMenu={(e) => onContextDir(e, ent.path)}
                title={kind ? `Git: ${kind}` : undefined}
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
                  gitMap={gitMap}
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
        const kind = entryGitKind(ent.path, false, gitMap);
        const gClass = gitStatusClass(kind);
        return (
          <div
            key={ent.path}
            className={`tree-row is-file ${activePath === ent.path ? "active" : ""} ${gClass}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onContextMenu={(e) => onContextFile(e, ent.path)}
            title={kind ? `Git: ${kind}` : undefined}
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
