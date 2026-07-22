import type { GitChangeKind, GitFileStatus, WorkspaceGitStatus } from "./types";

/** Map path → status for O(1) file row lookup. */
export function buildGitStatusMap(
  status: WorkspaceGitStatus | null,
): Map<string, GitFileStatus> {
  const map = new Map<string, GitFileStatus>();
  if (!status?.isRepo) return map;
  for (const f of status.files) {
    const p = f.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p) continue;
    map.set(p, { ...f, path: p });
  }
  return map;
}

function directStatus(
  path: string,
  map: Map<string, GitFileStatus>,
): GitFileStatus | undefined {
  return map.get(path) ?? map.get(path.replace(/\/+$/, ""));
}

/** True if this path or an ancestor directory is gitignored. */
function ignoredByAncestor(
  path: string,
  map: Map<string, GitFileStatus>,
): boolean {
  if (directStatus(path, map)?.kind === "ignored") return true;
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = parts.slice(0, i).join("/");
    if (directStatus(parent, map)?.kind === "ignored") return true;
  }
  return false;
}

/**
 * Status for a tree entry (file or folder).
 * - Files: direct git status, or ignored if under an ignored directory.
 * - Dirs: direct ignored, ancestor ignored, else aggregate of children
 *   (real changes win over ignored).
 */
export function entryGitKind(
  path: string,
  isDir: boolean,
  map: Map<string, GitFileStatus>,
): GitChangeKind | null {
  if (map.size === 0) return null;

  const direct = directStatus(path, map);
  if (direct) {
    // Explicit status on this path.
    if (!isDir || direct.kind === "ignored") return direct.kind;
    // Dir might also be listed as modified (rare); still check children.
  }

  if (ignoredByAncestor(path, map)) return "ignored";

  if (isDir) return dirGitKind(path, map);

  return direct?.kind ?? null;
}

/**
 * Directory is "dirty" if any changed file lives under it.
 * Returns the "worst" kind among children; ignored is lowest priority.
 */
export function dirGitKind(
  dirPath: string,
  map: Map<string, GitFileStatus>,
): GitChangeKind | null {
  if (map.size === 0) return null;
  if (directStatus(dirPath, map)?.kind === "ignored") return "ignored";
  if (ignoredByAncestor(dirPath, map)) return "ignored";

  const prefix = dirPath ? `${dirPath}/` : "";
  let best: GitChangeKind | null = null;
  let bestRank = -1;
  let sawIgnoredChild = false;

  for (const [path, st] of map) {
    if (dirPath === "") {
      // any path under root
    } else if (!path.startsWith(prefix) && path !== dirPath) {
      continue;
    }
    if (st.kind === "ignored") {
      sawIgnoredChild = true;
      continue;
    }
    const rank = kindRank(st.kind);
    if (rank > bestRank) {
      bestRank = rank;
      best = st.kind;
    }
  }

  if (best) return best;
  if (sawIgnoredChild) return "ignored";
  return null;
}

function kindRank(k: GitChangeKind): number {
  switch (k) {
    case "conflicted":
      return 6;
    case "deleted":
      return 5;
    case "modified":
      return 4;
    case "renamed":
      return 3;
    case "added":
      return 2;
    case "untracked":
      return 1;
    case "ignored":
      return 0;
    default:
      return 0;
  }
}

export function gitStatusClass(kind: GitChangeKind | null | undefined): string {
  if (!kind) return "";
  return `git-${kind}`;
}
