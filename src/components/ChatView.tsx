import { useEffect, useLayoutEffect, useRef } from "react";
import { FileText } from "lucide-react";
import { useAppStore } from "../store";
import { IntermediateWork } from "./IntermediateWork";
import { Composer } from "./Composer";
import { SubagentPanel } from "./SubagentPanel";

export function ChatView() {
  const {
    activeChat,
    activeProjectId,
    projects,
    busy,
    error,
    createChat,
  } = useAppStore();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** True while we programmatically move scrollTop (ignore those events). */
  const autoScrolling = useRef(false);
  /** User scrolled away from bottom — pause follow until they return or send. */
  const userAway = useRef(false);
  const project = projects.find((p) => p.id === activeProjectId);

  const lastTurn = activeChat?.turns[activeChat.turns.length - 1];
  const streaming = lastTurn?.status === "streaming";

  // Reset follow mode when switching chats or starting a new turn.
  useEffect(() => {
    userAway.current = false;
  }, [activeChat?.id, activeChat?.turns.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onScroll = () => {
      if (autoScrolling.current) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Only pin "away" when clearly not at bottom (avoid thrash while content grows).
      userAway.current = distance > 140;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeChat?.id]);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollerRef.current;
    if (!el) return;
    autoScrolling.current = true;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      // smooth scroll fires many scroll events; release the guard after it settles.
      window.setTimeout(() => {
        autoScrolling.current = false;
      }, 250);
    } else {
      el.scrollTop = el.scrollHeight;
      // release after layout
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          autoScrolling.current = false;
        });
      });
    }
  };

  // Follow the stream without scrolling on every intermediate object identity
  // change (that was thrashing layout during tool storms).
  const streamTick =
    (lastTurn?.assistantMessage?.length ?? 0) +
    (lastTurn?.intermediate?.length ?? 0) +
    (lastTurn?.status ?? "");
  useLayoutEffect(() => {
    if (userAway.current) return;
    scrollToBottom("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, streamTick, streaming]);

  const isScratch = project?.isScratch || project?.id === "scratch";

  if (!activeProjectId) {
    return (
      <main className="main empty-main">
        <div className="hero">
          <h1>Skunkworks Grok UI</h1>
          <p>
            Unofficial client. Chat without a project (isolated temp folder), or
            open a real project folder for repo work.
          </p>
          <button
            className="primary-btn"
            disabled={busy}
            onClick={() => createChat()}
          >
            Start a scratch chat
          </button>
        </div>
      </main>
    );
  }

  if (!activeChat) {
    return (
      <main className="main empty-main">
        <div className="hero">
          <h1>{isScratch ? "Scratch" : project?.name}</h1>
          <p className="mono">
            {isScratch
              ? "No project · ~/.grok-ui/scratch/<chat>/"
              : project?.path}
          </p>
          <p>
            {isScratch
              ? "General chat with Grok. Each scratch chat has its own hidden working folder."
              : "No chat selected."}
          </p>
          <button
            className="primary-btn"
            disabled={busy}
            onClick={() => createChat()}
          >
            {isScratch ? "New scratch chat" : "Start a new chat"}
          </button>
        </div>
      </main>
    );
  }

  const focusTurnId =
    lastTurn?.status === "streaming"
      ? lastTurn.id
      : activeChat.turns[activeChat.turns.length - 1]?.id;

  return (
    <main className="main">
      <header className="chat-header">
        <div>
          <div className="chat-header-title">{activeChat.title}</div>
          <div className="chat-header-sub">
            <span>{project?.name}</span>
            {activeChat.acpSessionId && (
              <span className="mono muted">
                · {activeChat.acpSessionId.slice(0, 8)}…
              </span>
            )}
            {streaming && <span className="muted"> · streaming</span>}
          </div>
        </div>
        {userAwayHint(streaming)}
      </header>

      <div className="main-body">
        <div className="main-center">
          <div className="messages" ref={scrollerRef}>
            {activeChat.turns.length === 0 && (
              <div className="empty-hint center">
                Send a message to start. Grok can read and edit files in{" "}
                <code>{project?.path}</code>.
              </div>
            )}
            {activeChat.turns.map((turn) => (
              <div key={turn.id} className="turn">
                <div className="user-msg">
                  <div className="role">You</div>
                  {turn.attachments && turn.attachments.length > 0 && (
                    <div className="msg-attachments">
                      {turn.attachments.map((a) =>
                        a.kind === "image" && a.dataUrl ? (
                          <a
                            key={a.id}
                            href={a.dataUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="msg-attach"
                            title={a.name}
                          >
                            <img src={a.dataUrl} alt={a.name} />
                          </a>
                        ) : (
                          <div
                            key={a.id}
                            className="msg-attach file-chip"
                            title={a.name}
                          >
                            <span className="file-chip-icon">
                              <FileText size={15} strokeWidth={1.75} />
                            </span>
                            <span className="file-chip-name">{a.name}</span>
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {turn.userMessage && (
                    <div className="user-text">{turn.userMessage}</div>
                  )}
                </div>
                <div className="agent-col">
                  <div className="role">Grok</div>
                  {/* Parent tools / thinking / answers only — subagents are in the rail. */}
                  <IntermediateWork turn={turn} />
                  {turn.status === "streaming" &&
                    !turn.assistantMessage &&
                    !turn.intermediate.some((b) => b.type === "message") && (
                      <div className="typing">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                  {turn.status === "error" &&
                    !turn.assistantMessage.includes("**Turn failed:**") && (
                      <div className="error-banner">Turn failed</div>
                    )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} className="scroll-anchor" />
          </div>

          {error && <div className="error-banner bottom">{error}</div>}
          <Composer
            onSend={() => {
              userAway.current = false;
              requestAnimationFrame(() => scrollToBottom("auto"));
            }}
          />
        </div>

        <SubagentPanel chat={activeChat} focusTurnId={focusTurnId} />
      </div>
    </main>
  );
}

/** Placeholder — keep header clean; scroll-away is silent. */
function userAwayHint(_streaming: boolean) {
  return null;
}
