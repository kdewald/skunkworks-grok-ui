//! ACP (Agent Client Protocol) client over `grok agent stdio`.
//!
//! Supports local process spawn and remote spawn via SSH
//! (`ssh host -- bash -lc '… grok agent --no-leader stdio'`).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    /// JSON-RPC id from the agent (number or string). Must round-trip on respond.
    pub request_id: Value,
    pub session_id: String,
    pub tool_call: Value,
    pub options: Value,
    #[serde(default)]
    pub environment_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    pub session_id: String,
    pub update: Value,
    #[serde(default)]
    pub environment_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEvent {
    pub connected: bool,
    pub message: String,
    pub agent_info: Option<Value>,
    #[serde(default)]
    pub environment_id: String,
}

/// How to start the `grok agent stdio` process.
#[derive(Debug, Clone)]
pub enum AgentSpawnTarget {
    Local {
        grok_path: Option<String>,
    },
    Ssh {
        /// SSH config Host alias or `user@host`.
        host: String,
        /// Optional absolute path to `grok` on the remote host.
        remote_grok_path: Option<String>,
    },
}

/// JSON-RPC request id (number or string — Grok uses both).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum RpcId {
    Number(u64),
    String(String),
}

impl RpcId {
    fn from_value(v: &Value) -> Option<Self> {
        if let Some(n) = v.as_u64() {
            return Some(Self::Number(n));
        }
        if let Some(s) = v.as_str() {
            return Some(Self::String(s.to_string()));
        }
        // Some agents encode numbers as i64
        if let Some(n) = v.as_i64() {
            if n >= 0 {
                return Some(Self::Number(n as u64));
            }
        }
        None
    }

    fn to_value(&self) -> Value {
        match self {
            Self::Number(n) => json!(n),
            Self::String(s) => json!(s),
        }
    }
}

pub struct AcpConnection {
    pub environment_id: String,
    stdin: AsyncMutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<RpcId, oneshot::Sender<Result<Value>>>>>,
    /// Outstanding agent→client permission request IDs awaiting UI response.
    /// Value is the ACP session id the permission belongs to.
    pending_permissions: Mutex<HashMap<RpcId, String>>,
    /// In-flight `session/prompt` request ids keyed by ACP session id.
    /// Used to force-complete a hung cancel.
    active_prompts: Arc<Mutex<HashMap<String, RpcId>>>,
    app: AppHandle,
    _child: Child,
    /// Channel kept so the write side can be closed cleanly later.
    _shutdown_tx: mpsc::Sender<()>,
}

impl AcpConnection {
    pub async fn spawn(
        app: AppHandle,
        environment_id: String,
        target: AgentSpawnTarget,
    ) -> Result<Arc<Self>> {
        let mut child = match &target {
            AgentSpawnTarget::Local { grok_path } => {
                let binary = resolve_grok_binary(grok_path.clone())?;
                Command::new(&binary)
                    .args(["agent", "--no-leader", "stdio"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .with_context(|| format!("failed to spawn `{binary} agent stdio`"))?
            }
            AgentSpawnTarget::Ssh {
                host,
                remote_grok_path,
            } => {
                // OpenSSH joins remote argv with spaces, so the login-shell command
                // must be a *single* ssh argument (properly shell-quoted).
                let remote_cmd = ssh_remote_bash_lc(&remote_agent_shell_command(
                    remote_grok_path.as_deref(),
                ));
                Command::new("ssh")
                    .args([
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "ConnectTimeout=20",
                        "-o",
                        "ServerAliveInterval=30",
                        // Avoid consuming remote stdin for password prompts; we own stdio for ACP.
                        "-o",
                        "PreferredAuthentications=publickey",
                        "-T",
                        host.as_str(),
                        remote_cmd.as_str(),
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .with_context(|| {
                        format!("failed to spawn ssh to `{host}` for remote grok agent")
                    })?
            }
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("agent stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("agent stdout missing"))?;
        let stderr = child.stderr.take();

        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

        let conn = Arc::new(Self {
            environment_id: environment_id.clone(),
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Mutex::new(HashMap::new()),
            active_prompts: Arc::new(Mutex::new(HashMap::new())),
            app: app.clone(),
            _child: child,
            _shutdown_tx: shutdown_tx,
        });

        // stderr logger
        if let Some(stderr) = stderr {
            let app_err = app.clone();
            let env_id = environment_id.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "agent-log",
                        json!({
                            "level": "stderr",
                            "message": line,
                            "environmentId": env_id,
                        }),
                    );
                }
            });
        }

        // stdout reader
        let reader_conn = Arc::clone(&conn);
        let env_for_exit = environment_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => break,
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(line)) => {
                                if line.trim().is_empty() {
                                    continue;
                                }
                                if let Err(err) = reader_conn.handle_line(&line).await {
                                    let _ = reader_conn.app.emit(
                                        "agent-log",
                                        json!({
                                            "level": "error",
                                            "message": format!("ACP parse error: {err}; line={line}"),
                                            "environmentId": reader_conn.environment_id,
                                        }),
                                    );
                                }
                            }
                            Ok(None) => {
                                // Critical: resolve every in-flight RPC (esp. session/prompt)
                                // or the UI stays "streaming" forever after agent death /
                                // tauri-dev rebuild / crash.
                                reader_conn.fail_all_pending(
                                    "Agent process exited while a request was in flight",
                                );
                                let _ = reader_conn.app.emit(
                                    "agent-status",
                                    AgentStatusEvent {
                                        connected: false,
                                        message: "Agent process exited".into(),
                                        agent_info: None,
                                        environment_id: env_for_exit.clone(),
                                    },
                                );
                                break;
                            }
                            Err(err) => {
                                reader_conn.fail_all_pending(&format!(
                                    "Agent stdout error while a request was in flight: {err}"
                                ));
                                let _ = reader_conn.app.emit(
                                    "agent-log",
                                    json!({
                                        "level": "error",
                                        "message": format!("stdout read error: {err}"),
                                        "environmentId": reader_conn.environment_id,
                                    }),
                                );
                                let _ = reader_conn.app.emit(
                                    "agent-status",
                                    AgentStatusEvent {
                                        connected: false,
                                        message: format!("Agent stdout error: {err}"),
                                        agent_info: None,
                                        environment_id: env_for_exit.clone(),
                                    },
                                );
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(conn)
    }

    pub fn has_pending_permission(&self, request_id: &Value) -> bool {
        let Some(id) = RpcId::from_value(request_id) else {
            return false;
        };
        self.pending_permissions.lock().contains_key(&id)
    }

    /// Fail every outstanding client→agent RPC and clear prompt tracking.
    /// Must be called when the agent process dies or is replaced, otherwise
    /// `session/prompt` awaits forever and the UI turn stays "streaming".
    pub fn fail_all_pending(&self, reason: &str) {
        let pending: Vec<(RpcId, oneshot::Sender<Result<Value>>)> = {
            let mut map = self.pending.lock();
            map.drain().collect()
        };
        let n = pending.len();
        for (_id, tx) in pending {
            let _ = tx.send(Err(anyhow!("{reason}")));
        }
        self.active_prompts.lock().clear();
        // Drop permission waiters (UI will clear on agent-status).
        self.pending_permissions.lock().clear();
        if n > 0 {
            let _ = self.app.emit(
                "agent-log",
                json!({
                    "level": "warn",
                    "message": format!(
                        "Failed {n} in-flight ACP request(s): {reason}"
                    ),
                    "environmentId": self.environment_id,
                }),
            );
        }
    }

    async fn handle_line(&self, line: &str) -> Result<()> {
        let msg: Value = serde_json::from_str(line)?;

        // Message with id: response or agent→client request
        if let Some(id_val) = msg.get("id") {
            if let Some(id) = RpcId::from_value(id_val) {
                if msg.get("method").is_none() {
                    let result = if let Some(err) = msg.get("error") {
                        Err(anyhow!("RPC error: {err}"))
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    };
                    // Clear any session→prompt mapping that pointed at this id.
                    self.active_prompts
                        .lock()
                        .retain(|_, prompt_id| prompt_id != &id);
                    if let Some(tx) = self.pending.lock().remove(&id) {
                        let _ = tx.send(result);
                    }
                    return Ok(());
                }

                // Request from agent to client (has id + method)
                let method = msg
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string();
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                self.handle_agent_request(id, &method, params).await?;
                return Ok(());
            }
        }

        // Notification (method, no id)
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            self.handle_notification(method, params)?;
        }

        Ok(())
    }

    fn handle_notification(&self, method: &str, params: Value) -> Result<()> {
        match method {
            "session/update" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let update = params.get("update").cloned().unwrap_or(Value::Null);
                let _ = self.app.emit(
                    "session-update",
                    SessionUpdateEvent {
                        session_id,
                        update,
                        environment_id: self.environment_id.clone(),
                    },
                );
            }
            other => {
                let _ = self.app.emit(
                    "agent-notification",
                    json!({
                        "method": other,
                        "params": params,
                        "environmentId": self.environment_id,
                    }),
                );
            }
        }
        Ok(())
    }

    async fn handle_agent_request(&self, id: RpcId, method: &str, params: Value) -> Result<()> {
        match method {
            "session/request_permission" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let options = params.get("options").cloned().unwrap_or(json!([]));

                // Support both numeric and string JSON-RPC ids (remote agents often use strings).
                // Never auto-cancel: that aborts long-running tool turns.
                // Track session id so cancel can reject outstanding permissions (ACP requires this).
                self.pending_permissions
                    .lock()
                    .insert(id.clone(), session_id.clone());

                let _ = self.app.emit(
                    "permission-request",
                    PermissionRequestEvent {
                        request_id: id.to_value(),
                        session_id,
                        tool_call,
                        options,
                        environment_id: self.environment_id.clone(),
                    },
                );
            }
            // Client-side FS is intentionally disabled (see initialize clientCapabilities).
            // The agent has its own tools that go through session/request_permission.
            "fs/read_text_file" | "fs/write_text_file" => {
                self.write_response(
                    id,
                    Err((
                        -32601,
                        "Client filesystem methods are disabled; use agent tools".into(),
                    )),
                )
                .await?;
            }
            // Optional client extensions (skills reload, etc.) — acknowledge.
            "skills/reload" | "skills-reload" | "_x.ai/skills/reload" => {
                self.write_response(id, Ok(json!({ "reloaded": 0 })))
                    .await?;
            }
            other => {
                // Prefer empty success for unknown optional methods so agents don't stall.
                let _ = self.app.emit(
                    "agent-log",
                    json!({
                        "level": "debug",
                        "message": format!("Ignoring unsupported agent→client method: {other}"),
                        "environmentId": self.environment_id,
                    }),
                );
                self.write_response(id, Ok(json!({}))).await?;
            }
        }
        Ok(())
    }

    async fn write_raw(&self, value: &Value) -> Result<()> {
        let mut line = serde_json::to_string(value)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }

    async fn write_response(
        &self,
        id: RpcId,
        result: Result<Value, (i32, String)>,
    ) -> Result<()> {
        let id_val = id.to_value();
        let msg = match result {
            Ok(value) => json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "result": value,
            }),
            Err((code, message)) => json!({
                "jsonrpc": "2.0",
                "id": id_val,
                "error": { "code": code, "message": message },
            }),
        };
        self.write_raw(&msg).await
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id_num = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id = RpcId::Number(id_num);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);

        // Track in-flight prompts so cancel can force-complete a hung turn.
        let prompt_session = if method == "session/prompt" {
            params
                .get("sessionId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        } else {
            None
        };
        if let Some(ref sid) = prompt_session {
            self.active_prompts.lock().insert(sid.clone(), id.clone());
        }

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id_num,
            "method": method,
            "params": params,
        });
        self.write_raw(&msg).await?;

        // session/prompt can run for a very long time (tools, remote SSH, etc.).
        // Other RPC methods should complete quickly.
        let result = if method == "session/prompt" {
            let res = rx
                .await
                .map_err(|_| anyhow!("response channel closed: {method}"))?;
            if let Some(sid) = prompt_session {
                self.active_prompts.lock().remove(&sid);
            }
            res
        } else {
            tokio::time::timeout(std::time::Duration::from_secs(120), rx)
                .await
                .map_err(|_| anyhow!("request timed out: {method}"))?
                .map_err(|_| anyhow!("response channel closed: {method}"))?
        }?;

        Ok(result)
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_raw(&msg).await
    }

    pub async fn initialize(&self) -> Result<Value> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {
                        "readTextFile": false,
                        "writeTextFile": false
                    },
                    "terminal": false
                },
                "clientInfo": {
                    "name": "skunkworks-grok-ui",
                    "title": "Skunkworks Grok UI",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )
        .await
    }

    /// Authenticate using initialize result: prefer cached_token, then defaultAuthMethodId.
    pub async fn authenticate_from_init(&self, init: &Value) -> Result<Value> {
        let methods: Vec<String> = init
            .get("authMethods")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let default_id = init
            .get("_meta")
            .and_then(|m| m.get("defaultAuthMethodId"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());

        let method_id = if methods.iter().any(|m| m == "cached_token") {
            "cached_token".to_string()
        } else if let Some(d) = default_id {
            d.to_string()
        } else if methods.len() == 1 {
            methods[0].clone()
        } else {
            anyhow::bail!(
                "no usable auth method on agent (have: {}). \
                 On the remote host, run `grok` once to sign in, or refresh ~/.grok/auth.json.",
                if methods.is_empty() {
                    "none".into()
                } else {
                    methods.join(", ")
                }
            );
        };

        if method_id == "grok.com" {
            anyhow::bail!(
                "Grok on this host only offers interactive browser login (grok.com) — \
                 no cached credentials. SSH to the host and run `grok` (or `grok auth`) to sign in, \
                 then reconnect."
            );
        }

        self.request(
            "authenticate",
            json!({ "methodId": method_id }),
        )
        .await
    }

    pub async fn session_new(&self, cwd: &str) -> Result<Value> {
        self.request(
            "session/new",
            json!({
                "cwd": cwd,
                "mcpServers": []
            }),
        )
        .await
    }

    pub async fn session_load(&self, session_id: &str, cwd: &str) -> Result<Value> {
        self.request(
            "session/load",
            json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": []
            }),
        )
        .await
    }

    /// Send a prompt with arbitrary ACP content blocks (text, image, resource, …).
    pub async fn session_prompt_blocks(
        &self,
        session_id: &str,
        prompt: Vec<Value>,
    ) -> Result<Value> {
        self.request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": prompt
            }),
        )
        .await
    }

    pub async fn session_cancel(&self, session_id: &str) -> Result<()> {
        // ACP: pending permission requests MUST be answered with cancelled
        // before/when the client cancels the turn — otherwise the agent stalls.
        self.cancel_pending_permissions_for_session(session_id)
            .await?;
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await?;

        // Safety net: if the agent never resolves session/prompt after cancel,
        // force-complete so the UI does not stay stuck forever.
        let session_id = session_id.to_string();
        let pending = Arc::clone(&self.pending);
        let active_prompts = Arc::clone(&self.active_prompts);
        let prompt_id = active_prompts.lock().get(&session_id).cloned();
        if let Some(id) = prompt_id {
            let app = self.app.clone();
            let env_id = self.environment_id.clone();
            tokio::spawn(async move {
                // Long-running shell tools often ignore cancel until the process exits.
                // Unstick the pending session/prompt quickly so the next turn can start.
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                // Only force-complete if this prompt is still the active one.
                let still_active = active_prompts
                    .lock()
                    .get(&session_id)
                    .map(|cur| cur == &id)
                    .unwrap_or(false);
                if !still_active {
                    return;
                }
                if let Some(tx) = pending.lock().remove(&id) {
                    active_prompts.lock().remove(&session_id);
                    let _ = app.emit(
                        "agent-log",
                        json!({
                            "level": "warn",
                            "message": format!(
                                "Force-completing cancelled prompt for session {session_id} (agent did not respond in time)"
                            ),
                            "environmentId": env_id,
                        }),
                    );
                    let _ = tx.send(Ok(json!({ "stopReason": "cancelled" })));
                }
            });
        }
        Ok(())
    }

    /// Reject all outstanding permission requests for a session (ACP cancel rule).
    pub async fn cancel_pending_permissions_for_session(&self, session_id: &str) -> Result<()> {
        let ids: Vec<RpcId> = {
            let mut map = self.pending_permissions.lock();
            let ids: Vec<RpcId> = map
                .iter()
                .filter(|(_, sid)| sid.as_str() == session_id || session_id.is_empty())
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                map.remove(id);
            }
            ids
        };
        for id in ids {
            self.write_response(
                id,
                Ok(json!({ "outcome": { "outcome": "cancelled" } })),
            )
            .await?;
        }
        // Tell the UI to dismiss any permission modal.
        let _ = self.app.emit(
            "permission-cleared",
            json!({
                "sessionId": session_id,
                "environmentId": self.environment_id,
            }),
        );
        Ok(())
    }

    pub async fn respond_permission(
        &self,
        request_id: Value,
        option_id: Option<String>,
        cancelled: bool,
    ) -> Result<()> {
        let id = RpcId::from_value(&request_id)
            .ok_or_else(|| anyhow!("invalid permission request id: {request_id}"))?;
        self.pending_permissions.lock().remove(&id);

        let result = if cancelled {
            json!({ "outcome": { "outcome": "cancelled" } })
        } else if let Some(option_id) = option_id {
            json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id
                }
            })
        } else {
            json!({ "outcome": { "outcome": "cancelled" } })
        };

        self.write_response(id, Ok(result)).await
    }
}

/// Quote for a single remote shell argument (OpenSSH concatenates argv with spaces).
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `bash -lc '<cmd>'` as one ssh remote-command argument.
fn ssh_remote_bash_lc(inner: &str) -> String {
    format!("bash -lc {}", shell_single_quote(inner))
}

/// Shell command run on the remote host under `bash -lc`.
fn remote_agent_shell_command(remote_grok_path: Option<&str>) -> String {
    // Ensure common install locations are on PATH for non-interactive login shells.
    let path_export =
        r#"export PATH="$HOME/.local/bin:$HOME/.grok/bin:/usr/local/bin:/opt/homebrew/bin:$PATH""#;
    let binary = remote_grok_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("grok");
    if binary == "grok" {
        format!("{path_export}; exec grok agent --no-leader stdio")
    } else {
        let escaped = binary.replace('\'', "'\\''");
        format!("{path_export}; exec '{escaped}' agent --no-leader stdio")
    }
}

fn resolve_grok_binary(explicit: Option<String>) -> Result<String> {
    if let Some(path) = explicit {
        return Ok(path);
    }
    if let Ok(path) = std::env::var("GROK_PATH") {
        if !path.is_empty() {
            return Ok(path);
        }
    }
    // Common install locations
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        home.join(".local/bin/grok"),
        home.join(".grok/bin/grok"),
        std::path::PathBuf::from("/usr/local/bin/grok"),
        std::path::PathBuf::from("/opt/homebrew/bin/grok"),
    ];
    for c in candidates {
        if c.is_file() {
            return Ok(c.to_string_lossy().to_string());
        }
    }
    which::which("grok")
        .map(|p| p.to_string_lossy().to_string())
        .context("could not find `grok` on PATH; set GROK_PATH or install Grok Build")
}

/// Best-effort parse of `~/.ssh/config` Host aliases (concrete names only).
pub fn list_ssh_config_hosts() -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let path = home.join(".ssh").join("config");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    let mut hosts = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if !lower.starts_with("host ") && !lower.starts_with("host\t") {
            continue;
        }
        let rest = trimmed["host".len()..].trim();
        for token in rest.split_whitespace() {
            // Skip pattern-only hosts (Codex-style).
            if token.contains('*') || token.contains('?') || token.contains('!') {
                continue;
            }
            if token.eq_ignore_ascii_case("host") {
                continue;
            }
            if !hosts.iter().any(|h: &String| h == token) {
                hosts.push(token.to_string());
            }
        }
    }
    hosts.sort();
    hosts
}

/// Run a short remote command over SSH (login shell). Returns stdout.
pub async fn ssh_exec(host: &str, remote_command: &str) -> Result<String> {
    let remote = ssh_remote_bash_lc(remote_command);
    let output = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            "-T",
            host,
            remote.as_str(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .with_context(|| format!("ssh exec failed for host `{host}`"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "ssh `{host}` command failed ({}): {}{}",
            output.status,
            stderr.trim(),
            if stdout.trim().is_empty() {
                String::new()
            } else {
                format!(" | {}", stdout.trim())
            }
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Ensure a per-chat scratch directory exists on a remote host; return absolute path.
pub async fn ensure_remote_scratch_dir(host: &str, chat_id: &str) -> Result<String> {
    if chat_id.is_empty()
        || chat_id.contains('/')
        || chat_id.contains('\\')
        || chat_id.contains("..")
    {
        anyhow::bail!("invalid scratch chat id");
    }
    // Single-quote chat_id for remote shell safety (UUIDs only in practice).
    let cmd = format!(
        "mkdir -p \"$HOME/.grok-ui/scratch/{chat_id}\" && cd \"$HOME/.grok-ui/scratch/{chat_id}\" && pwd"
    );
    ssh_exec(host, &cmd).await
}

/// Probe that a remote path is a directory; return canonical path if possible.
pub async fn resolve_remote_project_path(host: &str, path: &str) -> Result<String> {
    let path = path.trim();
    if path.is_empty() {
        anyhow::bail!("path is empty");
    }
    // Pass path via printf %q-equivalent: escape for single-quoted shell string.
    let escaped = path.replace('\'', "'\\''");
    let cmd = format!(
        "p='{escaped}'; if [ ! -d \"$p\" ]; then echo \"not a directory: $p\" >&2; exit 1; fi; cd \"$p\" && pwd"
    );
    ssh_exec(host, &cmd).await
}

/// One directory entry from a remote folder listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub path: String,
}

/// Listing for the remote folder browser (SSH).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirListing {
    pub path: String,
    pub parent: Option<String>,
    pub home: String,
    pub entries: Vec<RemoteDirEntry>,
    /// True when `query` was applied (recursive search under `path`).
    #[serde(default)]
    pub searched: bool,
}

/// List directories on a remote host, or search under a path when `query` is set.
///
/// - Empty/None `path` → start at `$HOME`
/// - Empty/None `query` → immediate child directories only
/// - Non-empty `query` → case-insensitive name match under `path` (max depth 5, cap 150)
pub async fn list_remote_directory(
    host: &str,
    path: Option<&str>,
    query: Option<&str>,
) -> Result<RemoteDirListing> {
    let path_init = match path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let escaped = p.replace('\'', "'\\''");
            format!("p='{escaped}'")
        }
        None => "p=\"$HOME\"".to_string(),
    };

    let query = query.map(str::trim).filter(|s| !s.is_empty());
    let searched = query.is_some();

    let entries_script = if let Some(q) = query {
        // Restrict metacharacters so the remote shell/find stay well-behaved.
        let safe: String = q
            .chars()
            .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ' | '@' | '+'))
            .take(80)
            .collect();
        if safe.is_empty() {
            anyhow::bail!("search query has no usable characters");
        }
        let q_esc = safe.replace('\'', "'\\''");
        format!(
            r#"q='{q_esc}'
# Recursive name search (dirs only). Prefer find; fall back to shallow listing.
if command -v find >/dev/null 2>&1; then
  find "$curr" -maxdepth 5 \( -type d -o -type l \) -iname "*$q*" 2>/dev/null \
    | head -n 150 \
    | while IFS= read -r full; do
        [ -d "$full" ] || continue
        [ "$full" = "$curr" ] && continue
        name="${{full##*/}}"
        printf '%s\t%s\n' "$name" "$full"
      done
else
  ls -1A 2>/dev/null | while IFS= read -r n; do
    case "$n" in
      *"$q"*|*"$(printf '%s' "$q" | tr '[:upper:]' '[:lower:]')"*) ;;
      *) continue ;;
    esac
    [ -d "$n" ] || continue
    full="$curr/$n"
    printf '%s\t%s\n' "$n" "$full"
  done
fi"#
        )
    } else {
        r#"ls -1A 2>/dev/null | while IFS= read -r n; do
  [ -d "$n" ] || continue
  full="$curr/$n"
  printf '%s\t%s\n' "$n" "$full"
done"#
            .to_string()
    };

    let cmd = format!(
        r#"{path_init}
if [ ! -d "$p" ]; then echo "not a directory: $p" >&2; exit 1; fi
cd "$p" || exit 1
curr=$(pwd -P 2>/dev/null || pwd)
home="$HOME"
parent=$(dirname -- "$curr" 2>/dev/null || dirname "$curr")
if [ "$parent" = "$curr" ]; then parent=""; fi
printf 'CURR=%s\n' "$curr"
printf 'HOME=%s\n' "$home"
printf 'PARENT=%s\n' "$parent"
printf 'BEGIN_ENTRIES\n'
{entries_script}
printf 'END_ENTRIES\n'"#
    );

    let out = ssh_exec(host, &cmd).await?;
    let mut curr = String::new();
    let mut home = String::new();
    let mut parent = String::new();
    let mut entries = Vec::new();
    let mut in_entries = false;

    for line in out.lines() {
        if line == "BEGIN_ENTRIES" {
            in_entries = true;
            continue;
        }
        if line == "END_ENTRIES" {
            in_entries = false;
            continue;
        }
        if !in_entries {
            if let Some(rest) = line.strip_prefix("CURR=") {
                curr = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("HOME=") {
                home = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("PARENT=") {
                parent = rest.to_string();
            }
            continue;
        }
        // name\tpath — path may contain spaces but not tabs/newlines
        let Some((name, full)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || full.is_empty() {
            continue;
        }
        entries.push(RemoteDirEntry {
            name: name.to_string(),
            path: full.to_string(),
        });
    }

    if curr.is_empty() {
        anyhow::bail!("remote listing returned no current path");
    }

    // Stable order for browsing; search results keep find order (often depth-first).
    if !searched {
        entries.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
    }

    Ok(RemoteDirListing {
        path: curr,
        parent: if parent.is_empty() {
            None
        } else {
            Some(parent)
        },
        home,
        entries,
        searched,
    })
}

/// Probe remote host: PATH-visible grok + home directory.
pub async fn probe_ssh_host(host: &str, remote_grok_path: Option<&str>) -> Result<Value> {
    let which_cmd = match remote_grok_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let escaped = p.replace('\'', "'\\''");
            format!(
                "if [ -x '{escaped}' ]; then echo GROK='{escaped}'; else echo GROK=; fi; echo HOME=\"$HOME\""
            )
        }
        None => {
            "command -v grok || true; echo HOME=\"$HOME\"".into()
        }
    };
    let out = ssh_exec(host, &which_cmd).await?;
    let mut grok = String::new();
    let mut home = String::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("GROK=") {
            grok = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("HOME=") {
            home = rest.to_string();
        } else if grok.is_empty() && line.contains('/') && !line.starts_with("HOME=") {
            // `command -v grok` prints a path alone
            grok = line.trim().to_string();
        }
    }
    if remote_grok_path.is_none() && grok.is_empty() {
        // Second try: common install locations
        let fallback = ssh_exec(
            host,
            "for c in \"$HOME/.local/bin/grok\" \"$HOME/.grok/bin/grok\" /usr/local/bin/grok; do \
             if [ -x \"$c\" ]; then echo \"$c\"; break; fi; done; echo HOME=\"$HOME\"",
        )
        .await
        .unwrap_or_default();
        for line in fallback.lines() {
            if let Some(rest) = line.strip_prefix("HOME=") {
                if home.is_empty() {
                    home = rest.to_string();
                }
            } else if grok.is_empty() && line.contains("grok") {
                grok = line.trim().to_string();
            }
        }
    }
    if grok.is_empty() {
        anyhow::bail!(
            "could not find `grok` on `{host}` (login shell PATH). Install Grok Build on the remote host or set a remote grok path."
        );
    }
    Ok(json!({
        "host": host,
        "grokPath": grok,
        "home": home,
        "environmentId": format!("ssh:{host}"),
        "ok": true,
    }))
}

