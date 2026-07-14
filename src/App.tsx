import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { PermissionModal } from "./components/PermissionModal";
import { useAppStore } from "./store";
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

  // Connect once on mount. Empty deps + ignore flag avoids StrictMode double-connect races.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await bootstrap();
      if (cancelled) return;
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
        listen<{ sessionId: string; update: unknown }>(
          "session-update",
          (event) => {
            void applySessionUpdate(
              event.payload.sessionId,
              event.payload.update,
            );
          },
        ),
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
        }),
        listen<{ level?: string; message?: string }>("agent-log", (event) => {
          pushLog(
            `[${event.payload.level ?? "log"}] ${event.payload.message ?? ""}`,
          );
        }),
        listen<{ chatId: string; ok?: boolean; error?: string | null }>(
          "prompt-finished",
          (event) => {
            void refreshChat(event.payload.chatId);
            useAppStore.setState({
              busy: false,
              error:
                event.payload.ok === false && event.payload.error
                  ? String(event.payload.error)
                  : null,
            });
          },
        ),
        listen<{ chatId: string }>("chat-updated", (event) => {
          void refreshChat(event.payload.chatId);
        }),
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

  return (
    <div className="app-shell">
      <Sidebar />
      <ChatView />
      <PermissionModal />
    </div>
  );
}

export default App;
