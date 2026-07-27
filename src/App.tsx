import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { FilesView } from "./components/FilesView";
import { PermissionModal } from "./components/PermissionModal";
import { TerminalPanel } from "./components/TerminalPanel";
import { useAppStore, waitForApplyDrain } from "./store";
import {
  abortStreamingTurnsOnDisconnect,
  collectCancelledTurnIds,
  markTurnCancelledById,
  markTurnsCancelled,
  reassertCancelledTurns,
} from "./state/turns";
import {
  normalizeAgentBackend,
  type AgentBackend,
  type PermissionRequest,
} from "./types";
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
      if (
        state.isRuntimeConnected(
          state.activeEnvironmentId,
          state.activeBackend,
        )
      ) {
        return;
      }
      try {
        await connectAgent(state.activeEnvironmentId, state.activeBackend);
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
          backend?: AgentBackend;
        }>("session-update", (event) => {
          void applySessionUpdate(
            event.payload.sessionId,
            event.payload.update,
            event.payload.environmentId,
            event.payload.backend,
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
            backend: normalizeAgentBackend(p.backend),
          });
        }),
        listen<{
          connected: boolean;
          message: string;
          environmentId?: string;
          backend?: AgentBackend;
        }>("agent-status", (event) => {
          setAgentStatus({
            connected: event.payload.connected,
            message: event.payload.message,
            environmentId: event.payload.environmentId,
            backend: normalizeAgentBackend(event.payload.backend),
          });
          // Scope disconnect to the environment owning the inflight chat —
          // an SSH agent death must not abort a healthy local turn.
          if (!event.payload.connected) {
            const state = useAppStore.getState();
            const deadEnv =
              event.payload.environmentId ?? state.activeEnvironmentId;
            const deadBackend = normalizeAgentBackend(event.payload.backend);
            const inflightId = state.inflightChatId;
            let inflightOnDeadEnv = false;
            if (inflightId) {
              const meta = state.chats.find((c) => c.id === inflightId);
              const project = state.projects.find(
                (p) => p.id === (meta?.projectId ?? state.activeChat?.projectId),
              );
              const chatEnv = project?.environmentId || state.activeEnvironmentId;
              const chatBackend = normalizeAgentBackend(
                meta?.backend ??
                  (state.activeChat?.id === inflightId
                    ? state.activeChat.backend
                    : undefined),
              );
              inflightOnDeadEnv =
                chatEnv === deadEnv && chatBackend === deadBackend;
            }
            if (!inflightOnDeadEnv) {
              return;
            }
            const active = state.activeChat;
            const activeOnDeadEnv =
              (() => {
                const project = state.projects.find(
                  (p) => p.id === active?.projectId,
                );
                return (
                  (project?.environmentId || state.activeEnvironmentId) ===
                    deadEnv &&
                  normalizeAgentBackend(active?.backend) === deadBackend
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
                activeChat: abortStreamingTurnsOnDisconnect(
                  active,
                  event.payload.message,
                ),
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
                  turns: markTurnCancelledById(active.turns, finishedTurnId),
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
                const { turns, changed } = reassertCancelledTurns(
                  chat.turns,
                  new Set([finishedTurnId]),
                );
                if (changed) {
                  useAppStore.setState({
                    activeChat: { ...chat, turns },
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
          const cancelledIds = collectCancelledTurnIds(state.activeChat);
          void (async () => {
            await refreshChat(event.payload.chatId);
            if (cancelledIds.size === 0) return;
            const after = useAppStore.getState();
            if (after.activeChat?.id !== event.payload.chatId) return;
            const active = after.activeChat;
            const { turns, changed } = reassertCancelledTurns(
              active.turns,
              cancelledIds,
            );
            if (changed) {
              useAppStore.setState({ activeChat: { ...active, turns } });
            }
          })();
        }),
        listen<{
          environmentId?: string;
          backend?: AgentBackend;
        }>("permission-cleared", (event) => {
          const state = useAppStore.getState();
          const permission = state.permission;
          if (!permission) return;
          const sameEnvironment =
            !event.payload?.environmentId ||
            permission.environmentId === event.payload.environmentId;
          const sameBackend =
            !event.payload?.backend ||
            normalizeAgentBackend(permission.backend) ===
              normalizeAgentBackend(event.payload.backend);
          if (sameEnvironment && sameBackend) {
            useAppStore.setState({ permission: null });
          }
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
                turns: markTurnsCancelled(active.turns, { turnId }),
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
