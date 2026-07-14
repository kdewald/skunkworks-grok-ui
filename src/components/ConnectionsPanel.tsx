import { useEffect, useState } from "react";
import { Server, Trash2, X, Plug, Unplug, Plus } from "lucide-react";
import { useAppStore } from "../store";
import { LOCAL_ENV_ID } from "../types";

export function ConnectionsPanel() {
  const {
    connectionsOpen,
    setConnectionsOpen,
    environments,
    activeEnvironmentId,
    connectedEnvironments,
    sshHosts,
    busy,
    error,
    addSshEnvironment,
    removeEnvironment,
    connectAgent,
    disconnectAgent,
    setActiveEnvironment,
    refreshSshHosts,
  } = useAppStore();

  const [hostInput, setHostInput] = useState("");
  const [remoteGrokPath, setRemoteGrokPath] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (connectionsOpen) {
      void refreshSshHosts();
    }
  }, [connectionsOpen, refreshSshHosts]);

  if (!connectionsOpen) return null;

  async function onAddHost(host: string) {
    setLocalError(null);
    try {
      await addSshEnvironment(
        host.trim(),
        undefined,
        remoteGrokPath.trim() || undefined,
      );
      setHostInput("");
      setRemoteGrokPath("");
    } catch (e) {
      setLocalError(String(e));
    }
  }

  return (
    <div
      className="connections-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Connections"
      onClick={() => setConnectionsOpen(false)}
    >
      <div
        className="connections-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="connections-header">
          <div className="connections-title-row">
            <Server size={16} strokeWidth={1.75} />
            <h2>Connections</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setConnectionsOpen(false)}
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <p className="connections-blurb">
          Run Grok on a remote machine over SSH (Codex-style). The agent and
          project files live on the remote host; this window is the client.
        </p>

        <div className="connections-list">
          {environments.map((env) => {
            const connected = connectedEnvironments.includes(env.id);
            const active = env.id === activeEnvironmentId;
            return (
              <div
                key={env.id}
                className={[
                  "connection-row",
                  active ? "active" : "",
                  connected ? "connected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  className="connection-main"
                  onClick={() => void setActiveEnvironment(env.id)}
                >
                  <div className="connection-name">
                    <span
                      className={`dot ${connected ? "ok" : "bad"}`}
                      aria-hidden
                    />
                    {env.name}
                    {active && <span className="env-badge">Active</span>}
                  </div>
                  <div className="connection-meta">
                    {env.kind === "local"
                      ? "Local agent"
                      : `SSH · ${env.sshHost ?? env.id}`}
                    {env.remoteGrokPath
                      ? ` · ${env.remoteGrokPath}`
                      : env.kind === "ssh"
                        ? " · grok on PATH"
                        : ""}
                  </div>
                </button>
                <div className="connection-actions">
                  {connected ? (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      disabled={busy}
                      title="Disconnect"
                      onClick={() => void disconnectAgent(env.id)}
                    >
                      <Unplug size={14} strokeWidth={1.75} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      disabled={busy}
                      title="Connect"
                      onClick={() => void connectAgent(env.id)}
                    >
                      <Plug size={14} strokeWidth={1.75} />
                    </button>
                  )}
                  {env.id !== LOCAL_ENV_ID && (
                    <button
                      type="button"
                      className="ghost-btn compact danger"
                      disabled={busy}
                      title="Remove"
                      onClick={() => {
                        if (
                          confirm(
                            `Remove connection “${env.name}” and its projects/chats from this app?`,
                          )
                        ) {
                          void removeEnvironment(env.id);
                        }
                      }}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="connections-add">
          <div className="section-label">Add SSH host</div>
          {sshHosts.length > 0 && (
            <div className="ssh-host-chips">
              {sshHosts
                .filter(
                  (h) =>
                    !environments.some(
                      (e) => e.sshHost === h || e.id === `ssh:${h}`,
                    ),
                )
                .map((h) => (
                  <button
                    key={h}
                    type="button"
                    className="chip-btn"
                    disabled={busy}
                    onClick={() => void onAddHost(h)}
                  >
                    {h}
                  </button>
                ))}
            </div>
          )}
          <div className="connections-form">
            <input
              className="text-input"
              placeholder="Host alias or user@host"
              value={hostInput}
              onChange={(e) => setHostInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hostInput.trim()) {
                  void onAddHost(hostInput);
                }
              }}
              disabled={busy}
            />
            <input
              className="text-input"
              placeholder="Remote grok path (optional)"
              value={remoteGrokPath}
              onChange={(e) => setRemoteGrokPath(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              className="primary-btn"
              disabled={busy || !hostInput.trim()}
              onClick={() => void onAddHost(hostInput)}
            >
              <Plus size={14} strokeWidth={1.75} />
              Add & connect
            </button>
          </div>
          <p className="connections-hint">
            Requires passwordless SSH (BatchMode) and <code>grok</code> on the
            remote login-shell PATH. Auth tokens stay on the remote host.
          </p>
          {(localError || error) && (
            <div className="connections-error">{localError || error}</div>
          )}
        </div>
      </div>
    </div>
  );
}
