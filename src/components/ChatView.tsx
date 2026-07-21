import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FileText } from "lucide-react";
import { useAppStore } from "../store";
import { IntermediateWork } from "./IntermediateWork";
import { Composer } from "./Composer";
import { SubagentPanel } from "./SubagentPanel";
import { WorkspaceHeader } from "./WorkspaceHeader";

/** Distance from bottom (px) still counted as "pinned" for sticky follow. */
const STICK_THRESHOLD = 80;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

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
  /**
   * Sticky follow: when true, stream updates jump to bottom.
   * Cleared on intentional scroll-up (wheel/touch/keys) even during rapid
   * auto-scroll frames — scroll events alone miss those because autoScrolling
   * stays true under heavy streaming.
   */
  const stickToBottom = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const project = projects.find((p) => p.id === activeProjectId);

  const lastTurn = activeChat?.turns[activeChat.turns.length - 1];
  const streaming = lastTurn?.status === "streaming";

  const setStick = useCallback((next: boolean) => {
    if (stickToBottom.current === next) return;
    stickToBottom.current = next;
    setShowJumpLatest(!next);
  }, []);

  // Re-enable follow when switching chats (new conversation context).
  useEffect(() => {
    setStick(true);
  }, [activeChat?.id, setStick]);

  // Detect user intent to leave / rejoin the bottom. Wheel & touch must work
  // even while programmatic scroll is active (stream ticks every frame).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const recomputeFromPosition = () => {
      if (autoScrolling.current) return;
      setStick(distanceFromBottom(el) <= STICK_THRESHOLD);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // Scroll up — detach immediately so the next stream tick does not yank.
        setStick(false);
      } else if (e.deltaY > 0) {
        // Scroll down — re-stick only once we actually reach the bottom.
        requestAnimationFrame(() => {
          if (distanceFromBottom(el) <= STICK_THRESHOLD) setStick(true);
        });
      }
    };

    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      // Finger dragged down → content moves up (reading earlier messages).
      if (y - touchY > 6) setStick(false);
      else if (touchY - y > 6) {
        requestAnimationFrame(() => {
          if (distanceFromBottom(el) <= STICK_THRESHOLD) setStick(true);
        });
      }
      touchY = y;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "Home" ||
        e.key === "ArrowUp" ||
        (e.key === " " && e.shiftKey)
      ) {
        setStick(false);
      }
    };

    const onScroll = () => {
      recomputeFromPosition();
    };

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [activeChat?.id, setStick]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollerRef.current;
    if (!el) return;
    autoScrolling.current = true;
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      window.setTimeout(() => {
        autoScrolling.current = false;
      }, 280);
    } else {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          autoScrolling.current = false;
        });
      });
    }
  }, []);

  // Follow the stream only while sticky. Tick is coarse (length/status) so we
  // don't thrash on every intermediate object identity change.
  const streamTick =
    (lastTurn?.assistantMessage?.length ?? 0) +
    (lastTurn?.intermediate?.length ?? 0) +
    (lastTurn?.status ?? "");
  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    scrollToBottom("auto");
  }, [activeChat?.id, streamTick, streaming, scrollToBottom]);

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
        <WorkspaceHeader
          title={isScratch ? "Scratch" : project?.name || "Chat"}
        />
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
      <WorkspaceHeader
        title={activeChat.title}
        subtitle={
          <>
            <span>{project?.name}</span>
            {activeChat.acpSessionId && (
              <span className="mono muted">
                · {activeChat.acpSessionId.slice(0, 8)}…
              </span>
            )}
            {streaming && <span className="muted"> · streaming</span>}
          </>
        }
      />

      <div className="main-body">
        <div className="main-center">
          <div className="messages-wrap">
            <div className="messages" ref={scrollerRef} tabIndex={-1}>
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

            {showJumpLatest && (
              <button
                type="button"
                className="jump-latest"
                onClick={() => {
                  setStick(true);
                  scrollToBottom("smooth");
                }}
              >
                <ChevronDown size={14} strokeWidth={2} />
                {streaming ? "Jump to latest" : "Jump to bottom"}
              </button>
            )}
          </div>

          {error && <div className="error-banner bottom">{error}</div>}
          <Composer
            onSend={() => {
              // Sending re-engages sticky follow (like ChatGPT / Claude).
              setStick(true);
              requestAnimationFrame(() => scrollToBottom("auto"));
            }}
          />
        </div>

        <SubagentPanel chat={activeChat} focusTurnId={focusTurnId} />
      </div>
    </main>
  );
}
