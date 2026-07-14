//! ACP (Agent Client Protocol) client over `grok agent stdio`.

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
    pub request_id: u64,
    pub session_id: String,
    pub tool_call: Value,
    pub options: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateEvent {
    pub session_id: String,
    pub update: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEvent {
    pub connected: bool,
    pub message: String,
    pub agent_info: Option<Value>,
}

pub struct AcpConnection {
    stdin: AsyncMutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>,
    /// Outstanding agent→client permission request IDs awaiting UI response.
    pending_permissions: Mutex<HashMap<u64, ()>>,
    app: AppHandle,
    _child: Child,
    /// Channel kept so the write side can be closed cleanly later.
    _shutdown_tx: mpsc::Sender<()>,
}

impl AcpConnection {
    pub async fn spawn(app: AppHandle, grok_path: Option<String>) -> Result<Arc<Self>> {
        let binary = resolve_grok_binary(grok_path)?;

        let mut child = Command::new(&binary)
            .args(["agent", "--no-leader", "stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn `{binary} agent stdio`"))?;

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
            stdin: AsyncMutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            pending_permissions: Mutex::new(HashMap::new()),
            app: app.clone(),
            _child: child,
            _shutdown_tx: shutdown_tx,
        });

        // stderr logger
        if let Some(stderr) = stderr {
            let app_err = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "agent-log",
                        json!({ "level": "stderr", "message": line }),
                    );
                }
            });
        }

        // stdout reader
        let reader_conn = Arc::clone(&conn);
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
                                            "message": format!("ACP parse error: {err}; line={line}")
                                        }),
                                    );
                                }
                            }
                            Ok(None) => {
                                let _ = reader_conn.app.emit(
                                    "agent-status",
                                    AgentStatusEvent {
                                        connected: false,
                                        message: "Agent process exited".into(),
                                        agent_info: None,
                                    },
                                );
                                break;
                            }
                            Err(err) => {
                                let _ = reader_conn.app.emit(
                                    "agent-log",
                                    json!({
                                        "level": "error",
                                        "message": format!("stdout read error: {err}")
                                    }),
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

    async fn handle_line(&self, line: &str) -> Result<()> {
        let msg: Value = serde_json::from_str(line)?;

        // Response to our request
        if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
            if msg.get("method").is_none() {
                let result = if let Some(err) = msg.get("error") {
                    Err(anyhow!("RPC error: {err}"))
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
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
                    },
                );
            }
            other => {
                let _ = self.app.emit(
                    "agent-notification",
                    json!({ "method": other, "params": params }),
                );
            }
        }
        Ok(())
    }

    async fn handle_agent_request(&self, id: u64, method: &str, params: Value) -> Result<()> {
        match method {
            "session/request_permission" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let options = params.get("options").cloned().unwrap_or(json!([]));

                // Don't block the stdout reader — UI replies via respond_permission.
                self.pending_permissions.lock().insert(id, ());

                let _ = self.app.emit(
                    "permission-request",
                    PermissionRequestEvent {
                        request_id: id,
                        session_id,
                        tool_call,
                        options,
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
            other => {
                self.write_response(
                    id,
                    Err((-32601, format!("Method not found: {other}"))),
                )
                .await?;
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
        id: u64,
        result: Result<Value, (i32, String)>,
    ) -> Result<()> {
        let msg = match result {
            Ok(value) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": value,
            }),
            Err((code, message)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message },
            }),
        };
        self.write_raw(&msg).await
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_raw(&msg).await?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(600), rx)
            .await
            .map_err(|_| anyhow!("request timed out: {method}"))?
            .map_err(|_| anyhow!("response channel closed: {method}"))??;

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

    pub async fn authenticate_cached(&self) -> Result<Value> {
        self.request(
            "authenticate",
            json!({ "methodId": "cached_token" }),
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

    pub async fn session_prompt(&self, session_id: &str, text: &str) -> Result<Value> {
        self.session_prompt_blocks(
            session_id,
            vec![json!({ "type": "text", "text": text })],
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
        self.notify("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    pub async fn respond_permission(
        &self,
        request_id: u64,
        option_id: Option<String>,
        cancelled: bool,
    ) -> Result<()> {
        // Clean any leftover oneshot
        self.pending_permissions.lock().remove(&request_id);

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

        self.write_response(request_id, Ok(result)).await
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
