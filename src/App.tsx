import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { FilesView } from "./components/FilesView";
import { PermissionModal } from "./components/PermissionModal";
import { TerminalPanel } from "./components/TerminalPanel";
import { useAppStore, waitForApplyDrain } from "./store";
import type { PermissionRequest } from "./types";
import "./App.css";

function App() {
  const bootstrap = useAppStore((s) => s.bootstrap);
  const connectAgent = useAppStore((s) => s.connectAgent);
  const applySessionUpdate = useAppStore((s) => s.applySessionUpdate);
  const setPermission = useAppStore((s) => s.setPermission);
  const setAgentStatus = useAppStore((s) => s.setAgentStatus);
  const pushLog = useAppStore((s) => s.pushLog);
  const refreshChat = useAppStore((s) => s.refreshChat);
  const ready = useAppStore((s) => s.ready);
  const workspaceMode = useAppStore((s) => s.workspaceMode);

  // Connect once on mount. selectChat may also connect; both paths are single-flight.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await bootstrap();
      if (cancelled) return;
      // Bootstrap/selectChat may already have connected for the saved chat's env.
      const state = useAppStore.getState();
      if (state.connectedEnvironments.includes(state.activeEnvironmentId)) {
        return;
      }
      try {
        await connectAgent();
      } catch {
        // status pill shows the error
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register Tauri event listeners once; await before cleanup so we never leak a listener.
  useEffect(() => {
    let cancelled = false;
    const unsubs: UnlistenFn[] = [];

    void (async () => {
      const pairs: Array<Promise<UnlistenFn>> = [
        listen<{
          sessionId: string;
          update: unknown;
          environmentId?: string;
        }>("session-update", (event) => {
          void applySessionUpdate(
            event.payload.sessionId,
            event.payload.update,
            event.payload.environmentId,
          );
        }),
        listen<PermissionRequest>("permission-request", (event) => {
          const p = event.payload as PermissionRequest & {
            request_id?: number | string;
          };
          const requestId = p.requestId ?? p.request_id;
          if (requestId === undefined || requestId === null) {
            pushLog("[permission] missing request id");
            return;
          }
          setPermission({
            requestId,
            sessionId: p.sessionId,
            toolCall: p.toolCall as PermissionRequest["toolCall"],
            options: (p.options ?? []) as PermissionRequest["options"],
            environmentId: p.environmentId,
          });
        }),
        listen<{
          connected: boolean;
          message: string;
          environmentId?: string;
        }>("agent-status", (event) => {
          setAgentStatus({
            connected: event.payload.connected,
            message: event.payload.message,
            environmentId: event.payload.environmentId,
          });
          // Scope disconnect to the environment owning the inflight chat —
          // an SSH agent death must not abort a healthy local turn.
          if (!event.payload.connected) {
            const state = useAppStore.getState();
            const deadEnv = event.payload.environmentId;
            const inflightId = state.inflightChatId;
            let inflightOnDeadEnv = !deadEnv;
            if (deadEnv && inflightId) {
              const meta = state.chats.find((c) => c.id === inflightId);
              const project = state.projects.find(
                (p) => p.id === (meta?.projectId ?? state.activeChat?.projectId),
              );
              const chatEnv = project?.environmentId || state.activeEnvironmentId;
              inflightOnDeadEnv = chatEnv === deadEnv;
            }
            if (!inflightOnDeadEnv) {
              return;
            }
            const active = state.activeChat;
            const activeOnDeadEnv =
              !deadEnv ||
              (() => {
                const project = state.projects.find(
                  (p) => p.id === active?.projectId,
                );
                return (
                  (project?.environmentId || state.activeEnvironmentId) ===
                  deadEnv
                );
              })();
            if (
              activeOnDeadEnv &&
              active?.turns.some((t) => t.status === "streaming")
            ) {
              useAppStore.setState({
                busy: false,
                inflightChatId: null,
                inflightTurnId: null,
                inflightGeneration: null,
                permission: null,
                activeChat: {
                  ...active,
                  turns: active.turns.map((t) =>
                    t.status === "streaming"
                      ? {
                          ...t,
                          status: "error",
                          intermediateCollapsed: true,
                          assistantMessage: t.assistantMessage
                            ? `${t.assistantMessage}\n\n---\n**Turn aborted:** agent disconnected (${event.payload.message})`
                            : `**Turn aborted:** agent disconnected (${event.payload.message})`,
                        }
                      : t,
                  ),
                },
              });
            } else if (inflightOnDeadEnv) {
              useAppStore.setState({
                busy: false,
                inflightChatId: null,
                inflightTurnId: null,
                inflightGeneration: null,
                permission: null,
              });
            }
            // Disconnect (including cancel hard-kill) clears the slot without
            // prompt-finished — flush the global queue so follow-ups are not
            // stranded forever behind a never-matching finish event.
            if (inflightOnDeadEnv) {
              const finishedChat = inflightId;
              void (async () => {
                await waitForApplyDrain();
                await useAppStore
                  .getState()
                  .flushMessageQueue(finishedChat ?? undefined);
              })();
            }
          }
        }),
        listen<{ level?: string; message?: string }>("agent-log", (event) => {
          pushLog(
            `[${event.payload.level ?? "log"}] ${event.payload.message ?? ""}`,
          );
        }),
        listen<{
          chatId: string;
          turnId?: string | null;
          ok?: boolean;
          error?: string | null;
          stopReason?: string | null;
        }>("prompt-finished", (event) => {
          void (async () => {
            const state = useAppStore.getState();
            const isActiveChat = state.activeChatId === event.payload.chatId;
            const finishedTurnId = event.payload.turnId ?? null;
            // Turn-scoped: only clear the send slot when this exact generation
            // finishes (late finish for turn A must not unlock turn B).
            // While send_message is still in flight (inflightTurnId not set yet),
            // ignore finishes with a turnId — dispatchSend will adopt the turn
            // id from the response; a stale prior finish must not unlock early.
            const isOurInflight =
              state.inflightChatId === event.payload.chatId &&
              (state.inflightTurnId != null
                ? finishedTurnId === state.inflightTurnId
                : finishedTurnId == null);
            const active = isActiveChat ? state.activeChat : null;

            if (isOurInflight) {
              useAppStore.setState({
                busy: false,
                inflightChatId: null,
                inflightTurnId: null,
                inflightGeneration: null,
                error:
                  isActiveChat &&
                  event.payload.ok === false &&
                  event.payload.error
                    ? String(event.payload.error)
                    : isActiveChat
                      ? null
                      : state.error,
                permission:
                  event.payload.stopReason === "cancelled"
                    ? null
                    : state.permission,
              });
            } else if (
              isActiveChat &&
              event.payload.ok === false &&
              event.payload.error
            ) {
              useAppStore.setState({ error: String(event.payload.error) });
            }

            // Mark only the finished turn cancelled when needed.
            if (
              event.payload.stopReason === "cancelled" &&
              active &&
              finishedTurnId
            ) {
              useAppStore.setState({
                activeChat: {
                  ...active,
                  turns: active.turns.map((t) =>
                    t.id === finishedTurnId
                      ? {
                          ...t,
                          status: "cancelled",
                          intermediateCollapsed: true,
                        }
                      : t,
                  ),
                },
              });
            }

            // Drain any still-buffered stream chunks before refresh so the UI
            // jumps to the final doc instead of dripping late applies after busy=false.
            await waitForApplyDrain();

            if (isActiveChat) {
              try {
                await refreshChat(event.payload.chatId);
              } catch {
                // ignore
              }
            }

            // Disk may still say streaming for the cancelled turn — re-assert.
            if (
              isActiveChat &&
              event.payload.stopReason === "cancelled" &&
              finishedTurnId
            ) {
              const after = useAppStore.getState();
              if (after.activeChat?.id === event.payload.chatId) {
                const chat = after.activeChat;
                const t = chat.turns.find((x) => x.id === finishedTurnId);
                if (t && (t.status === "streaming" || t.status === "cancelling")) {
                  useAppStore.setState({
                    activeChat: {
                      ...chat,
                      turns: chat.turns.map((x) =>
                        x.id === finishedTurnId
                          ? {
                              ...x,
                              status: "cancelled",
                              intermediateCollapsed: true,
                            }
                          : x,
                      ),
                    },
                  });
                }
              }
            }

            // Only after the cancelled/finished turn has settled: schedule queue.
            if (isOurInflight) {
              await useAppStore
                .getState()
                .flushMessageQueue(event.payload.chatId);
            }
          })();
        }),
        listen<{
          chatId: string;
          sessionId?: string;
          sessionRecreated?: boolean;
        }>("chat-updated", (event) => {
          const state = useAppStore.getState();
          // Always patch session meta when recreated (routing depends on it).
          if (event.payload.sessionId) {
            useAppStore.setState({
              chats: state.chats.map((c) =>
                c.id === event.payload.chatId
                  ? { ...c, acpSessionId: event.payload.sessionId }
                  : c,
              ),
              activeChat:
                state.activeChat?.id === event.payload.chatId
                  ? {
                      ...state.activeChat,
                      acpSessionId: event.payload.sessionId ?? null,
                    }
                  : state.activeChat,
            });
          }
          // Ignore transcript refresh for chats the user is not viewing.
          if (state.activeChatId !== event.payload.chatId) return;
          const cancelledIds = new Set(
            state.activeChat?.turns
              .filter((t) => t.status === "cancelled")
              .map((t) => t.id) ?? [],
          );
          void (async () => {
            await refreshChat(event.payload.chatId);
            if (cancelledIds.size === 0) return;
            const after = useAppStore.getState();
            if (after.activeChat?.id !== event.payload.chatId) return;
            const active = after.activeChat;
            let changed = false;
            const turns = active.turns.map((t) => {
              if (
                cancelledIds.has(t.id) &&
                (t.status === "streaming" || t.status === "cancelling")
              ) {
                changed = true;
                return { ...t, status: "cancelled", intermediateCollapsed: true };
              }
              return t;
            });
            if (changed) {
              useAppStore.setState({ activeChat: { ...active, turns } });
            }
          })();
        }),
        listen("permission-cleared", () => {
          useAppStore.setState({ permission: null });
        }),
        listen<{ chatId: string; turnId?: string | null }>(
          "cancel-started",
          (event) => {
            const state = useAppStore.getState();
            const turnId = event.payload.turnId;
            // Do NOT clear busy/inflight here — wait for prompt-finished so a
            // queued follow-up cannot start while the session is still cancelling.
            if (state.activeChat?.id !== event.payload.chatId) {
              return;
            }
            const active = state.activeChat;
            if (!active) return;
            useAppStore.setState({
              permission: null,
              inflightTurnId:
                state.inflightChatId === event.payload.chatId
                  ? turnId ?? state.inflightTurnId
                  : state.inflightTurnId,
              activeChat: {
                ...active,
                turns: active.turns.map((t) => {
                  const match = turnId
                    ? t.id === turnId
                    : t.status === "streaming" || t.status === "cancelling";
                  if (!match) return t;
                  return {
                    ...t,
                    status: "cancelled",
                    intermediateCollapsed: true,
                    intermediate: t.intermediate.map((b) =>
                      b.type === "tool" &&
                      (b.status === "pending" ||
                        b.status === "in_progress" ||
                        b.status === "running")
                        ? { ...b, status: "cancelled" }
                        : b,
                    ),
                  };
                }),
              },
            });
          },
        ),
      ];

      const resolved = await Promise.all(pairs);
      if (cancelled) {
        resolved.forEach((u) => u());
        return;
      }
      unsubs.push(...resolved);
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
    // Stable store actions — register listeners once only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-card">Starting Skunkworks Grok UI…</div>
      </div>
    );
  }

  const filesMode = workspaceMode === "files";

  return (
    <div className={`app-shell ${filesMode ? "is-files-mode" : ""}`}>
      {/* Stay mounted so width/opacity can animate closed in Files mode. */}
      <div className="sidebar-slot" aria-hidden={filesMode}>
        <Sidebar />
      </div>
      <div className="workspace">
        {filesMode ? <FilesView /> : <ChatView />}
        <TerminalPanel />
      </div>
      <PermissionModal />
    </div>
  );
}

export default App;
