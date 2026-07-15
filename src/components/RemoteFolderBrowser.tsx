import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUp,
  Folder,
  Home,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { RemoteDirListing } from "../types";

type Props = {
  open: boolean;
  environmentId: string;
  environmentName: string;
  busy?: boolean;
  onClose: () => void;
  onSelect: (path: string) => Promise<void> | void;
};

export function RemoteFolderBrowser({
  open,
  environmentId,
  environmentName,
  busy = false,
  onClose,
  onSelect,
}: Props) {
  const [listing, setListing] = useState<RemoteDirListing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [filter, setFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadGen = useRef(0);

  const load = useCallback(
    async (path?: string | null, query?: string | null) => {
      const gen = ++loadGen.current;
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<RemoteDirListing>("list_remote_dir", {
          environmentId,
          path: path?.trim() || null,
          query: query?.trim() || null,
        });
        if (gen !== loadGen.current) return;
        setListing(result);
        setPathInput(result.path);
        setActiveSearch(query?.trim() || "");
      } catch (e) {
        if (gen !== loadGen.current) return;
        setError(String(e));
      } finally {
        if (gen === loadGen.current) setLoading(false);
      }
    },
    [environmentId],
  );

  useEffect(() => {
    if (!open) return;
    setListing(null);
    setPathInput("");
    setFilter("");
    setSearchQuery("");
    setActiveSearch("");
    setError(null);
    setSelecting(false);
    void load(null, null);
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, environmentId, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !selecting) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, selecting]);

  const entries = useMemo(() => {
    if (!listing) return [];
    // Server already searched when activeSearch is set; still allow local filter.
    const q = filter.trim().toLowerCase();
    if (!q) return listing.entries;
    return listing.entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    );
  }, [listing, filter]);

  async function goToPath() {
    const path = pathInput.trim();
    if (!path) return;
    setFilter("");
    setSearchQuery("");
    await load(path, null);
  }

  async function runSearch() {
    const q = searchQuery.trim();
    if (!q) {
      setActiveSearch("");
      await load(listing?.path ?? null, null);
      return;
    }
    setFilter("");
    await load(listing?.path ?? (pathInput.trim() || null), q);
  }

  async function clearSearch() {
    setSearchQuery("");
    setActiveSearch("");
    setFilter("");
    await load(listing?.path ?? null, null);
  }

  async function openEntry(path: string) {
    setFilter("");
    setSearchQuery("");
    setActiveSearch("");
    await load(path, null);
  }

  async function confirmSelect() {
    const path = (listing?.path || pathInput).trim();
    if (!path || selecting || busy) return;
    setSelecting(true);
    setError(null);
    try {
      await onSelect(path);
    } catch (e) {
      setError(String(e));
      setSelecting(false);
    }
  }

  if (!open) return null;

  const currentPath = listing?.path ?? pathInput;
  const canGoUp = Boolean(listing?.parent);
  const canGoHome =
    Boolean(listing?.home) && listing?.path !== listing?.home;

  return (
    <div
      className="remote-path-overlay"
      onClick={() => {
        if (!selecting) onClose();
      }}
    >
      <div
        className="remote-folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Browse remote folder"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="remote-folder-header">
          <div>
            <div className="remote-path-title">Open remote project</div>
            <p className="connections-hint" style={{ margin: "4px 0 0" }}>
              Browse folders on <strong>{environmentName}</strong>
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="Close"
            onClick={onClose}
            disabled={selecting}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="remote-folder-toolbar">
          <button
            type="button"
            className="icon-btn"
            title="Parent folder"
            disabled={!canGoUp || loading || selecting}
            onClick={() => {
              if (listing?.parent) void openEntry(listing.parent);
            }}
          >
            <ArrowUp size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Home"
            disabled={!canGoHome || loading || selecting}
            onClick={() => {
              if (listing?.home) void openEntry(listing.home);
            }}
          >
            <Home size={15} strokeWidth={1.75} />
          </button>
          <input
            className="text-input remote-folder-path"
            value={pathInput}
            disabled={loading || selecting}
            placeholder="/home/you/src/project"
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void goToPath();
              }
            }}
            spellCheck={false}
          />
          <button
            type="button"
            className="ghost-btn compact"
            disabled={loading || selecting || !pathInput.trim()}
            onClick={() => void goToPath()}
          >
            Go
          </button>
        </div>

        <div className="remote-folder-search-row">
          <div className="remote-folder-search-wrap">
            <Search
              size={14}
              strokeWidth={1.75}
              className="remote-folder-search-icon"
              aria-hidden
            />
            <input
              ref={searchRef}
              className="text-input remote-folder-search"
              value={activeSearch ? searchQuery : filter || searchQuery}
              disabled={loading || selecting}
              placeholder={
                activeSearch
                  ? "Searching under this folder…"
                  : "Filter this folder, or search deeper…"
              }
              onChange={(e) => {
                const v = e.target.value;
                setSearchQuery(v);
                if (!activeSearch) setFilter(v);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  // Enter runs recursive search under current path
                  void runSearch();
                }
              }}
              spellCheck={false}
            />
          </div>
          {activeSearch ? (
            <button
              type="button"
              className="ghost-btn compact"
              disabled={loading || selecting}
              onClick={() => void clearSearch()}
            >
              Clear
            </button>
          ) : (
            <button
              type="button"
              className="ghost-btn compact"
              disabled={loading || selecting || !searchQuery.trim()}
              onClick={() => void runSearch()}
              title="Search folders under current path (max depth 5)"
            >
              Search
            </button>
          )}
        </div>

        {activeSearch && (
          <div className="remote-folder-search-meta">
            Results for “{activeSearch}” under {currentPath || "…"}
          </div>
        )}

        <div className="remote-folder-list" aria-busy={loading}>
          {loading && !listing && (
            <div className="remote-folder-empty">
              <Loader2 size={16} className="spin" strokeWidth={1.75} />
              Loading folders…
            </div>
          )}
          {!loading && error && !listing && (
            <div className="remote-folder-empty error">{error}</div>
          )}
          {listing && entries.length === 0 && !loading && (
            <div className="remote-folder-empty">
              {activeSearch || filter.trim()
                ? "No matching folders"
                : "No subfolders"}
            </div>
          )}
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="remote-folder-item"
              disabled={loading || selecting}
              onClick={() => void openEntry(entry.path)}
              onDoubleClick={() => void openEntry(entry.path)}
              title={entry.path}
            >
              <Folder size={14} strokeWidth={1.75} aria-hidden />
              <span className="remote-folder-item-text">
                <span className="remote-folder-item-name">{entry.name}</span>
                {activeSearch && (
                  <span className="remote-folder-item-path">{entry.path}</span>
                )}
              </span>
            </button>
          ))}
          {loading && listing && (
            <div className="remote-folder-loading-bar">
              <Loader2 size={12} className="spin" strokeWidth={1.75} />
              Updating…
            </div>
          )}
        </div>

        {error && listing && (
          <div className="connections-error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}

        <div className="remote-folder-footer">
          <div className="remote-folder-current" title={currentPath}>
            {currentPath || "…"}
          </div>
          <div className="remote-path-actions" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="ghost-btn"
              onClick={onClose}
              disabled={selecting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-btn"
              disabled={!currentPath.trim() || busy || selecting || loading}
              onClick={() => void confirmSelect()}
            >
              {selecting ? "Adding…" : "Open folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
