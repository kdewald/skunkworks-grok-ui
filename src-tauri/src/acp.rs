//! ACP (Agent Client Protocol) client over a supported agent backend.
//!
//! Supports local process spawn and remote spawn via SSH
//! (`ssh host -- bash -lc '… <agent> stdio'`).

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::ssh::{remote_agent_shell_command, resolve_agent_binary, ssh_remote_bash_lc};
use crate::store::AgentBackend;

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
    #[serde(default)]
    pub backend: AgentBackend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    pub session_id: String,
    pub update: Value,
    #[serde(default)]
    pub environment_id: String,
    #[serde(default)]
    pub backend: AgentBackend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEvent {
    pub connected: bool,
    pub message: String,
    pub agent_info: Option<Value>,
    #[serde(default)]
    pub environment_id: String,
    #[serde(default)]
    pub backend: AgentBackend,
}

/// How to start a backend's ACP process.
#[derive(Debug, Clone)]
pub enum AgentSpawnTarget {
    Local {
        backend: AgentBackend,
        /// Optional absolute path to Grok. Ignored by adapter backends.
        grok_path: Option<String>,
    },
    Ssh {
        backend: AgentBackend,
        /// SSH config Host alias or `user@host`.
        host: String,
        /// Optional absolute path to `grok` on the remote host.
        remote_grok_path: Option<String>,
    },
}

impl AgentSpawnTarget {
    pub fn backend(&self) -> AgentBackend {
        match self {
            Self::Local { backend, .. } | Self::Ssh { backend, .. } => *backend,
        }
    }
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
    pub backend: AgentBackend,
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
    /// Child process — taken on shutdown so we can kill it explicitly.
    child: Mutex<Option<Child>>,
    /// Closes the stdout reader loop on shutdown/replace.
    shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    /// False after stdout EOF, stdout error, or explicit shutdown.
    alive: AtomicBool,
}

impl AcpConnection {
    pub async fn spawn(
        app: AppHandle,
        environment_id: String,
        target: AgentSpawnTarget,
    ) -> Result<Arc<Self>> {
        let backend = target.backend();
        let mut child = match &target {
            AgentSpawnTarget::Local { grok_path, .. } => {
                let binary = resolve_agent_binary(backend, grok_path.clone())?;
                let mut command = Command::new(&binary);
                if let Some(parent) = Path::new(&binary)
                    .parent()
                    .filter(|path| !path.as_os_str().is_empty())
                {
                    let inherited = std::env::var_os("PATH").unwrap_or_default();
                    let paths = std::iter::once(parent.to_path_buf())
                        .chain(std::env::split_paths(&inherited));
                    if let Ok(path) = std::env::join_paths(paths) {
                        // npm adapter launchers use `#!/usr/bin/env node`; use
                        // the Node beside the globally installed adapter.
                        command.env("PATH", path);
                    }
                }
                if backend == AgentBackend::Grok {
                    command.args(["agent", "--no-leader", "--always-approve", "stdio"]);
                }
                command
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                    .with_context(|| {
                        format!("failed to spawn {} ACP agent `{binary}`", backend.as_str())
                    })?
            }
            AgentSpawnTarget::Ssh {
                host,
                remote_grok_path,
                ..
            } => {
                // OpenSSH joins remote argv with spaces, so the login-shell command
                // must be a *single* ssh argument (properly shell-quoted).
                let remote_cmd = ssh_remote_bash_lc(&remote_agent_shell_command(
                    backend,
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
                        format!(
                            "failed to spawn ssh to `{host}` for remote {} ACP agent",
                            backend.as_str()
                        )
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
            backend,
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            pending_permissions: Mutex::new(HashMap::new()),
            active_prompts: Arc::new(Mutex::new(HashMap::new())),
            app: app.clone(),
            child: Mutex::new(Some(child)),
            shutdown_tx: Mutex::new(Some(shutdown_tx)),
            alive: AtomicBool::new(true),
        });

        // stderr logger
        if let Some(stderr) = stderr {
            let app_err = app.clone();
            let env_id = environment_id.clone();
            let stderr_backend = backend;
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "agent-log",
                        json!({
                            "level": "stderr",
                            "message": line,
                            "environmentId": env_id,
                            "backend": stderr_backend,
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
                                            "backend": reader_conn.backend,
                                        }),
                                    );
                                }
                            }
                            Ok(None) => {
                                // Critical: resolve every in-flight RPC (esp. session/prompt)
                                // or the UI stays "streaming" forever after agent death /
                                // tauri-dev rebuild / crash.
                                reader_conn.alive.store(false, Ordering::SeqCst);
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
                                        backend: reader_conn.backend,
                                    },
                                );
                                break;
                            }
                            Err(err) => {
                                reader_conn.alive.store(false, Ordering::SeqCst);
                                reader_conn.fail_all_pending(&format!(
                                    "Agent stdout error while a request was in flight: {err}"
                                ));
                                let _ = reader_conn.app.emit(
                                    "agent-log",
                                    json!({
                                        "level": "error",
                                        "message": format!("stdout read error: {err}"),
                                        "environmentId": reader_conn.environment_id,
                                        "backend": reader_conn.backend,
                                    }),
                                );
                                let _ = reader_conn.app.emit(
                                    "agent-status",
                                    AgentStatusEvent {
                                        connected: false,
                                        message: format!("Agent stdout error: {err}"),
                                        agent_info: None,
                                        environment_id: env_for_exit.clone(),
                                        backend: reader_conn.backend,
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
                    "backend": self.backend,
                }),
            );
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Stop the reader loop and kill the child process. Safe to call more than once.
    pub async fn shutdown(&self, reason: &str) {
        self.alive.store(false, Ordering::SeqCst);
        self.fail_all_pending(reason);
        // Take handles under the sync lock, then await without holding it (Send).
        let tx = self.shutdown_tx.lock().take();
        let child = self.child.lock().take();
        if let Some(tx) = tx {
            let _ = tx.send(()).await;
        }
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
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
                        backend: self.backend,
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
                        "backend": self.backend,
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
                        backend: self.backend,
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
                        "backend": self.backend,
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

    async fn write_response(&self, id: RpcId, result: Result<Value, (i32, String)>) -> Result<()> {
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
                    "terminal": false,
                    "session": {
                        "configOptions": {
                            "boolean": {}
                        }
                    }
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

    /// Apply Grok's initialize-time auth selection.
    ///
    /// Adapter backends own their authentication flow and must not use this helper.
    pub async fn authenticate_grok_from_init(&self, init: &Value) -> Result<Value> {
        if self.backend != AgentBackend::Grok {
            anyhow::bail!(
                "Grok authentication helper cannot authenticate the {} backend",
                self.backend.as_str()
            );
        }

        let methods: Vec<String> = init
            .get("authMethods")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        m.get("id")
                            .and_then(|id| id.as_str())
                            .map(|s| s.to_string())
                    })
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

        self.request("authenticate", json!({ "methodId": method_id }))
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

    pub async fn session_set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value> {
        self.request(
            "session/set_mode",
            json!({
                "sessionId": session_id,
                "modeId": mode_id
            }),
        )
        .await
    }

    pub async fn session_set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: Value,
    ) -> Result<Value> {
        self.request(
            "session/set_config_option",
            json!({
                "sessionId": session_id,
                "configId": config_id,
                "value": value
            }),
        )
        .await
    }

    pub async fn session_set_model(&self, session_id: &str, model_id: &str) -> Result<Value> {
        self.request(
            "session/set_model",
            json!({
                "sessionId": session_id,
                "modelId": model_id
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

    pub async fn session_cancel(self: &Arc<Self>, session_id: &str) -> Result<()> {
        // Arm the hard-kill watchdog *before* any cancel I/O so a wedged stdin
        // pipe cannot prevent recovery indefinitely.
        let session_id_owned = session_id.to_string();
        let active_prompts = Arc::clone(&self.active_prompts);
        let prompt_id = active_prompts.lock().get(&session_id_owned).cloned();
        if let Some(id) = prompt_id {
            let this = Arc::clone(self);
            let sid = session_id_owned.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                let still_active = active_prompts
                    .lock()
                    .get(&sid)
                    .map(|cur| cur == &id)
                    .unwrap_or(false);
                if !still_active || !this.is_alive() {
                    return;
                }
                let _ = this.app.emit(
                    "agent-log",
                    json!({
                        "level": "warn",
                        "message": format!(
                            "Cancel timeout for session {sid}; killing agent process \
                             so a queued follow-up cannot share a still-running session"
                        ),
                        "environmentId": this.environment_id,
                        "backend": this.backend,
                    }),
                );
                this.shutdown(&format!(
                    "Agent killed after cancel timeout (session {sid})"
                ))
                .await;
                let _ = this.app.emit(
                    "agent-status",
                    AgentStatusEvent {
                        connected: false,
                        message: "Agent killed after cancel timeout".into(),
                        agent_info: None,
                        environment_id: this.environment_id.clone(),
                        backend: this.backend,
                    },
                );
            });
        }

        // ACP: pending permission requests MUST be answered with cancelled
        // before/when the client cancels the turn — otherwise the agent stalls.
        // Bound I/O so a dead pipe cannot hang cancel forever (watchdog above
        // is the real recovery path).
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.cancel_pending_permissions_for_session(session_id),
        )
        .await;
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            self.notify("session/cancel", json!({ "sessionId": session_id })),
        )
        .await;
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
            self.write_response(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })))
                .await?;
        }
        // Tell the UI to dismiss any permission modal.
        let _ = self.app.emit(
            "permission-cleared",
            json!({
                "sessionId": session_id,
                "environmentId": self.environment_id,
                "backend": self.backend,
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
