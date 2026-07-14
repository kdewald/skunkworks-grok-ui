/** Shorten absolute paths for sidebar labels. Full path stays on title/tooltip. */

export function displayPath(absPath: string): string {
  if (!absPath) return "";
  const home =
    typeof window !== "undefined"
      ? // best-effort: common macOS/Linux home prefix from path itself
        absPath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/)?.[1] ?? null
      : null;

  let p = absPath;
  if (home && p.startsWith(home)) {
    p = `~${p.slice(home.length)}`;
  }

  // Collapse long middle segments: ~/Workspaces/…/repo
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p.startsWith("/") || p.startsWith("~") ? p : parts.join("/");

  const head = parts[0]; // ~ or Users
  const parent = parts[parts.length - 2];
  const leaf = parts[parts.length - 1];
  if (head === "~" || head.startsWith("~")) {
    return `~/${parts[1] ?? ""}/…/${leaf}`.replace(/\/+/g, "/").replace("~//", "~/");
  }
  // Prefer parent/leaf for depth
  return `…/${parent}/${leaf}`;
}
