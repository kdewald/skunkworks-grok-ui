import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, FileText, Pencil } from "lucide-react";
import { useAppStore } from "../store";
import { IntermediateWork } from "./IntermediateWork";
import { Composer } from "./Composer";
import { SubagentPanel } from "./SubagentPanel";
import { WorkspaceHeader } from "./WorkspaceHeader";
import {
  AGENT_BACKENDS,
  agentBackendLabel,
  normalizeAgentBackend,
} from "../types";

/** Distance from bottom (px) still counted as "pinned" for sticky follow. */
const STICK_THRESHOLD = 80;

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function ChatView() {
  const {
    activeChat,
    activeBackend,
    activeProjectId,
    projects,
    busy,
    error,
    createChat,
    setActiveBackend,
    setChatModel,
    setChatAccessMode,
    startEditTurn,
    composerEdit,
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
  const backendLabel = agentBackendLabel(
    normalizeAgentBackend(activeChat?.backend ?? activeBackend),
  );
  const agentConfig = activeChat?.agentConfig;
  const modelLabel = agentConfig?.modelName ?? agentConfig?.modelId ?? "Default model";
  const accessLabel =
    agentConfig?.accessModeName ?? agentConfig?.accessModeId ?? "Agent default";

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
              ? `General chat with ${backendLabel}. Each scratch chat has its own hidden working folder.`
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
            {activeChat.turns.length > 0 && (
              <span className="agent-lock-summary">
                · {backendLabel} · {modelLabel} · {accessLabel}
              </span>
            )}
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
                <div className="new-chat-setup">
                  <div className="new-chat-setup-title">New chat</div>
                  <div className="new-chat-selectors">
                    <label className="new-chat-field">
                      <span>Provider</span>
                      <select
                        value={normalizeAgentBackend(activeChat.backend)}
                        disabled={busy}
                        onChange={(event) =>
                          void setActiveBackend(
                            normalizeAgentBackend(event.target.value),
                          )
                        }
                      >
                        {AGENT_BACKENDS.map((backend) => (
                          <option key={backend} value={backend}>
                            {agentBackendLabel(backend)}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="new-chat-field">
                      <span>Model</span>
                      <select
                        value={agentConfig?.modelId ?? ""}
                        disabled={
                          busy || (agentConfig?.availableModels.length ?? 0) < 2
                        }
                        onChange={(event) =>
                          void setChatModel(event.target.value).catch(() => {})
                        }
                      >
                        {(agentConfig?.availableModels.length ?? 0) === 0 ? (
                          <option value="">Agent default</option>
                        ) : (
                          agentConfig?.availableModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name}
                            </option>
                          ))
                        )}
                      </select>
                    </label>

                    <label className="new-chat-field">
                      <span>Access</span>
                      <select
                        value={agentConfig?.accessModeId ?? ""}
                        disabled={
                          busy ||
                          (agentConfig?.availableAccessModes.length ?? 0) < 2
                        }
                        onChange={(event) =>
                          void setChatAccessMode(event.target.value).catch(
                            () => {},
                          )
                        }
                      >
                        {(agentConfig?.availableAccessModes.length ?? 0) === 0 ? (
                          <option value="">Agent default</option>
                        ) : (
                          agentConfig?.availableAccessModes.map((mode) => (
                            <option key={mode.id} value={mode.id}>
                              {mode.name}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                  </div>
                  <div className="new-chat-setup-hint">
                    These settings lock after your first message. {backendLabel}{" "}
                    will work in <code>{project?.path}</code>.
                  </div>
                </div>
              )}
              {activeChat.turns.map((turn) => {
                const canEdit =
                  turn.userMessage.trim().length > 0 ||
                  (turn.attachments?.length ?? 0) > 0;
                const isSource =
                  composerEdit?.chatId === activeChat.id &&
                  composerEdit?.turnId === turn.id;

                return (
                  <div key={turn.id} className="turn">
                    <div
                      className={`user-msg ${isSource ? "is-edit-source" : ""}`}
                    >
                      <div className="user-msg-header">
                        <div className="role">You</div>
                        {canEdit && (
                          <button
                            type="button"
                            className="user-msg-edit-btn"
                            title="Edit in composer (resend rolls back later messages)"
                            onClick={() => {
                              startEditTurn(turn.id);
                              setStick(true);
                              requestAnimationFrame(() =>
                                scrollToBottom("smooth"),
                              );
                            }}
                          >
                            <Pencil size={12} strokeWidth={1.85} />
                            {isSource ? "Editing…" : "Edit"}
                          </button>
                        )}
                      </div>
                      {turn.attachments && turn.attachments.length > 0 && (
                        <div className="msg-attachments">
                          {turn.attachments.map((a) =>
                            a.kind === "image" && a.dataUrl ? (
                              <div
                                key={a.id}
                                className="msg-attach"
                                title={a.name}
                              >
                                <img src={a.dataUrl} alt={a.name} />
                              </div>
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
                      <div className="role">{backendLabel}</div>
                      {/* Parent tools / thinking / answers only — subagents are in the rail. */}
                      <IntermediateWork turn={turn} />
                      {turn.status === "streaming" &&
                        !turn.assistantMessage &&
                        !turn.intermediate.some(
                          (b) => b.type === "message",
                        ) && (
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
                );
              })}
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
