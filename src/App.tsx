import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { FilesView } from "./components/FilesView";
import { PermissionModal } from "./components/PermissionModal";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  isMatchingInflightFinish,
  useAppStore,
  waitForApplyDrain,
} from "./store";
import {
  withInflight,
  withoutInflight,
} from "./state/send";
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
          // Scope disconnect to chats on the dead environment/runtime —
          // an SSH agent death must not abort a healthy local turn.
          if (!event.payload.connected) {
            const state = useAppStore.getState();
            const deadEnv =
              event.payload.environmentId ?? state.activeEnvironmentId;
            const deadBackend = normalizeAgentBackend(event.payload.backend);
            const chatOnDeadEnv = (chatId: string) => {
              const meta = state.chats.find((c) => c.id === chatId);
              const project = state.projects.find(
                (p) =>
                  p.id ===
                  (meta?.projectId ??
                    (state.activeChat?.id === chatId
                      ? state.activeChat.projectId
                      : undefined)),
              );
              const chatEnv =
                project?.environmentId || state.activeEnvironmentId;
              const chatBackend = normalizeAgentBackend(
                meta?.backend ??
                  (state.activeChat?.id === chatId
                    ? state.activeChat.backend
                    : undefined),
              );
              return chatEnv === deadEnv && chatBackend === deadBackend;
            };
            const deadInflightIds = Object.keys(state.inflightPrompts).filter(
              chatOnDeadEnv,
            );
            if (deadInflightIds.length === 0) {
              return;
            }
            let prompts = state.inflightPrompts;
            for (const id of deadInflightIds) {
              prompts = withoutInflight(prompts, id);
            }
            const active = state.activeChat;
            const activeOnDeadEnv =
              !!active && chatOnDeadEnv(active.id);
            if (
              activeOnDeadEnv &&
              active?.turns.some((t) => t.status === "streaming")
            ) {
              useAppStore.setState({
                inflightPrompts: prompts,
                permission: null,
                activeChat: abortStreamingTurnsOnDisconnect(
                  active,
                  event.payload.message,
                ),
              });
            } else {
              useAppStore.setState({
                inflightPrompts: prompts,
                permission: null,
              });
            }
            // Disconnect (including cancel hard-kill) clears slots without
            // prompt-finished — flush each affected chat's queue.
            void (async () => {
              await waitForApplyDrain();
              const store = useAppStore.getState();
              for (const id of deadInflightIds) {
                await store.flushMessageQueue(id);
              }
            })();
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
            const finishedChatId = event.payload.chatId;
            const isActiveChat = state.activeChatId === finishedChatId;
            const finishedTurnId = event.payload.turnId ?? null;
            const slot = state.inflightPrompts[finishedChatId];
            // Per-chat turn match: late finish for turn A must not unlock turn B
            // on the same chat. Accept finishes while turn id is not yet adopted.
            const isOurInflight = isMatchingInflightFinish(
              slot,
              finishedTurnId,
            );
            const active = isActiveChat ? state.activeChat : null;

            if (isOurInflight) {
              useAppStore.setState({
                inflightPrompts: withoutInflight(
                  useAppStore.getState().inflightPrompts,
                  finishedChatId,
                ),
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
            // jumps to the final doc instead of dripping late applies.
            await waitForApplyDrain();

            if (isActiveChat) {
              try {
                await refreshChat(finishedChatId);
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
              if (after.activeChat?.id === finishedChatId) {
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

            // Only after the cancelled/finished turn has settled: drain this chat.
            if (isOurInflight) {
              await useAppStore.getState().flushMessageQueue(finishedChatId);
            }
          })();
        }),
        listen<{
          chatId: string;
          sessionId?: string;
          sessionRecreated?: boolean;
          turnId?: string | null;
        }>("chat-updated", (event) => {
          const state = useAppStore.getState();
          // Always patch session meta when recreated (routing depends on it).
          // Also adopt turnId onto this chat's send slot as early as possible
          // so a fast prompt-finished can match before send_message returns.
          const slot = state.inflightPrompts[event.payload.chatId];
          const adoptTurn =
            slot &&
            slot.turnId == null &&
            event.payload.turnId != null &&
            event.payload.turnId !== "";
          if (event.payload.sessionId || adoptTurn) {
            useAppStore.setState({
              chats: event.payload.sessionId
                ? state.chats.map((c) =>
                    c.id === event.payload.chatId
                      ? { ...c, acpSessionId: event.payload.sessionId }
                      : c,
                  )
                : state.chats,
              activeChat:
                event.payload.sessionId &&
                state.activeChat?.id === event.payload.chatId
                  ? {
                      ...state.activeChat,
                      acpSessionId: event.payload.sessionId ?? null,
                    }
                  : state.activeChat,
              inflightPrompts: adoptTurn
                ? withInflight(state.inflightPrompts, event.payload.chatId, {
                    turnId: event.payload.turnId as string,
                    generation: slot!.generation,
                  })
                : state.inflightPrompts,
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
            const chatId = event.payload.chatId;
            // Do NOT clear this chat's slot here — wait for prompt-finished so a
            // queued follow-up cannot start while the session is still cancelling.
            const slot = state.inflightPrompts[chatId];
            const nextPrompts =
              slot && turnId
                ? withInflight(state.inflightPrompts, chatId, {
                    turnId,
                    generation: slot.generation,
                  })
                : state.inflightPrompts;
            if (state.activeChat?.id !== chatId) {
              if (nextPrompts !== state.inflightPrompts) {
                useAppStore.setState({
                  permission: null,
                  inflightPrompts: nextPrompts,
                });
              }
              return;
            }
            const active = state.activeChat;
            if (!active) return;
            useAppStore.setState({
              permission: null,
              inflightPrompts: nextPrompts,
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
        {/*
          Keep both panes mounted so Files retains the open file, draft,
          tree expansion, and Monaco scroll/cursor when switching modes.
        */}
        <div className="workspace-panes">
          <div
            className={`workspace-pane ${filesMode ? "is-hidden" : ""}`}
            aria-hidden={filesMode}
          >
            <ChatView />
          </div>
          <div
            className={`workspace-pane ${filesMode ? "" : "is-hidden"}`}
            aria-hidden={!filesMode}
          >
            <FilesView />
          </div>
        </div>
        <TerminalPanel />
      </div>
      <PermissionModal />
    </div>
  );
}

export default App;
