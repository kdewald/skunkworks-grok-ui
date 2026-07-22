import type { Components } from "react-markdown";
import { handleExternalAnchorClick, isExternalUrl } from "./openExternal";

/**
 * Shared ReactMarkdown components so agent/chat links open in the system
 * browser instead of navigating the Tauri webview (which traps the UI).
 */
export const markdownComponents: Components = {
  a({ href, children, ...props }) {
    const external = isExternalUrl(href);
    return (
      <a
        {...props}
        href={href}
        target={external ? "_blank" : props.target}
        rel={external ? "noopener noreferrer" : props.rel}
        onClick={(e) => {
          if (handleExternalAnchorClick(e)) return;
        }}
      >
        {children}
      </a>
    );
  },
};
