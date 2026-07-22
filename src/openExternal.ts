import { openUrl } from "@tauri-apps/plugin-opener";

/** Schemes that should leave the app (system browser / OS handler). */
const EXTERNAL_SCHEMES = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
  "vscode:",
  "file:",
]);

/**
 * True when following this URL would leave the app shell (or open an OS
 * handler). In-app routes / anchors / data/blob previews return false.
 */
export function isExternalUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return false;
  }
  try {
    const url = new URL(trimmed, window.location.href);
    if (url.origin === window.location.origin) return false;
    return EXTERNAL_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

/** Open a URL with the OS default handler (browser for http/https). */
export async function openExternalUrl(href: string): Promise<void> {
  const trimmed = href.trim();
  if (!trimmed) return;
  try {
    await openUrl(trimmed);
  } catch (err) {
    // Fallback if the opener plugin fails (e.g. browser-only tests).
    console.error("openExternalUrl failed:", err);
    window.open(trimmed, "_blank", "noopener,noreferrer");
  }
}

/**
 * If the event target is (inside) an external link, prevent in-webview
 * navigation and open the system browser instead. Returns true when handled.
 */
export function handleExternalAnchorClick(
  event: Pick<Event, "target" | "preventDefault" | "stopPropagation">,
): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest("a");
  if (!anchor) return false;
  const href = anchor.getAttribute("href");
  if (!isExternalUrl(href)) return false;
  // Never navigate this webview — always hand off to the OS.
  event.preventDefault();
  event.stopPropagation();
  if (href) void openExternalUrl(href);
  return true;
}
