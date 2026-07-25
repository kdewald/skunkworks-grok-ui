//! Language Server Protocol process manager.
//!
//! Spawns local language servers (stdio) and bridges JSON-RPC to the frontend.
//! Remote/SSH workspaces are not supported yet (servers need a local file tree).
//!
//! | id         | Binary (first found on PATH)                                      |
//! |------------|-------------------------------------------------------------------|
//! | typescript | `typescript-language-server --stdio` (or `npx -y …`)              |
//! | python     | `pyright-langserver --stdio` / `basedpyright-langserver` / `pylsp`|
//! | rust       | `rust-analyzer`                                                   |
//! | cpp        | `clangd`                                                          |
//!
//! Go is intentionally not supported.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub id: String,
    pub available: bool,
    pub running: bool,
    pub command: Option<String>,
    pub root: Option<String>,
    pub error: Option<String>,
}

struct PendingMap {
    map: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
}

struct LiveServer {
    id: String,
    root: PathBuf,
    command: String,
    stdin: Arc<AsyncMutex<ChildStdin>>,
    pending: Arc<Mutex<PendingMap>>,
    next_id: Arc<AtomicU64>,
    child: Arc<AsyncMutex<Option<Child>>>,
}

pub struct LspHub {
    inner: Mutex<HashMap<String, Arc<LiveServer>>>,
}

impl Default for LspHub {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl LspHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status_all(&self) -> Vec<LspServerStatus> {
        let ids = ["typescript", "python", "rust", "cpp"];
        let running = self.inner.lock();
        ids.iter()
            .map(|id| {
                let cmd = resolve_server_command(id);
                let live = running.get(*id);
                let available = cmd.is_some();
                LspServerStatus {
                    id: (*id).to_string(),
                    available,
                    running: live.is_some(),
                    command: cmd.map(|(c, a)| format!("{} {}", c, a.join(" "))),
                    root: live.map(|s| s.root.display().to_string()),
                    error: if available {
                        None
                    } else {
                        Some(missing_hint(id))
                    },
                }
            })
            .collect()
    }

    pub async fn ensure(
        &self,
        app: AppHandle,
        id: &str,
        root: PathBuf,
    ) -> Result<LspServerStatus, String> {
        if !root.is_absolute() {
            return Err("workspace root must be absolute for LSP".into());
        }
        if !root.is_dir() {
            return Err(format!(
                "workspace root is not a directory: {}",
                root.display()
            ));
        }

        {
            let map = self.inner.lock();
            if let Some(live) = map.get(id) {
                if live.root == root {
                    return Ok(status_for(live));
                }
            }
        }

        self.stop(id).await;

        let (bin, args) =
            resolve_server_command(id).ok_or_else(|| missing_hint(id))?;

        let mut child = Command::new(&bin)
            .args(&args)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn {bin}: {e}"))?;

        let stdin = child.stdin.take().ok_or("lsp stdin missing")?;
        let stdout = child.stdout.take().ok_or("lsp stdout missing")?;
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            let lang = id.to_string();
            let app_err = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = app_err.emit(
                        "lsp-log",
                        json!({ "serverId": lang, "stream": "stderr", "line": line }),
                    );
                }
            });
        }

        let pending = Arc::new(Mutex::new(PendingMap {
            map: HashMap::new(),
        }));
        let next_id = Arc::new(AtomicU64::new(1));
        let stdin = Arc::new(AsyncMutex::new(stdin));
        let child = Arc::new(AsyncMutex::new(Some(child)));

        let pending_r = Arc::clone(&pending);
        let app_r = app.clone();
        let lang = id.to_string();
        let child_r = Arc::clone(&child);
        let stdin_r = Arc::clone(&stdin);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_lsp_message(&mut reader).await {
                    Ok(Some(value)) => {
                        handle_incoming(&app_r, &lang, &pending_r, &stdin_r, value).await;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = app_r.emit(
                            "lsp-log",
                            json!({ "serverId": lang, "stream": "error", "line": e }),
                        );
                        break;
                    }
                }
            }
            {
                let mut pend = pending_r.lock();
                for (_, tx) in pend.map.drain() {
                    let _ = tx.send(Err("language server exited".into()));
                }
            }
            if let Some(mut c) = child_r.lock().await.take() {
                let _ = c.kill().await;
            }
        });

        let live = Arc::new(LiveServer {
            id: id.to_string(),
            root: root.clone(),
            command: format!("{} {}", bin, args.join(" ")),
            stdin: Arc::clone(&stdin),
            pending: Arc::clone(&pending),
            next_id: Arc::clone(&next_id),
            child: Arc::clone(&child),
        });

        let root_uri = path_to_uri(&root);
        live.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {
                    "name": "skunkworks-grok-ui",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "rootUri": root_uri,
                "rootPath": root.to_string_lossy(),
                "capabilities": {
                    "textDocument": {
                        "synchronization": {
                            "dynamicRegistration": false,
                            "didSave": true
                        },
                        "completion": {
                            "completionItem": {
                                "snippetSupport": true,
                                "documentationFormat": ["markdown", "plaintext"]
                            },
                            "contextSupport": true
                        },
                        "hover": {
                            "contentFormat": ["markdown", "plaintext"]
                        },
                        "definition": { "linkSupport": true },
                        "publishDiagnostics": {
                            "relatedInformation": true
                        }
                    },
                    "workspace": {
                        "workspaceFolders": true,
                        "configuration": true
                    }
                },
                "workspaceFolders": [{
                    "uri": root_uri,
                    "name": root.file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("workspace")
                }],
                "initializationOptions": initialization_options(id)
            }),
        )
        .await?;

        live.notify("initialized", json!({})).await?;

        self.inner.lock().insert(id.to_string(), Arc::clone(&live));
        Ok(status_for(&live))
    }

    pub async fn stop(&self, id: &str) {
        let old = self.inner.lock().remove(id);
        if let Some(live) = old {
            let _ = live.request("shutdown", Value::Null).await;
            let _ = live.notify("exit", Value::Null).await;
            if let Some(mut c) = live.child.lock().await.take() {
                let _ = c.kill().await;
            }
        }
    }

    pub async fn request(
        &self,
        id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let live = self
            .inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("language server `{id}` is not running"))?;
        live.request(method, params).await
    }

    pub async fn notify(&self, id: &str, method: &str, params: Value) -> Result<(), String> {
        let live = self
            .inner
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("language server `{id}` is not running"))?;
        live.notify(method, params).await
    }
}

impl LiveServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map.insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        write_lsp_message(&self.stdin, &msg).await?;

        match tokio::time::timeout(std::time::Duration::from_secs(45), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => Err("LSP response channel closed".into()),
            Err(_) => {
                self.pending.lock().map.remove(&id);
                Err(format!("LSP request timed out: {method}"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = if params.is_null() && method == "exit" {
            json!({ "jsonrpc": "2.0", "method": method })
        } else {
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            })
        };
        write_lsp_message(&self.stdin, &msg).await
    }
}

fn status_for(live: &LiveServer) -> LspServerStatus {
    LspServerStatus {
        id: live.id.clone(),
        available: true,
        running: true,
        command: Some(live.command.clone()),
        root: Some(live.root.display().to_string()),
        error: None,
    }
}

async fn handle_incoming(
    app: &AppHandle,
    server_id: &str,
    pending: &Arc<Mutex<PendingMap>>,
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    value: Value,
) {
    // Response
    if let Some(id_val) = value.get("id") {
        if value.get("method").is_none() {
            let id = id_val
                .as_u64()
                .or_else(|| id_val.as_i64().map(|i| i as u64));
            if let Some(id) = id {
                if let Some(tx) = pending.lock().map.remove(&id) {
                    if let Some(err) = value.get("error") {
                        let _ = tx.send(Err(err.to_string()));
                    } else {
                        let _ = tx.send(Ok(value
                            .get("result")
                            .cloned()
                            .unwrap_or(Value::Null)));
                    }
                }
            }
            return;
        }
    }

    // Server → client request
    if let (Some(id), Some(method)) = (
        value.get("id").cloned(),
        value.get("method").and_then(|m| m.as_str()),
    ) {
        let result = match method {
            "workspace/configuration" => {
                // Array of nulls matching requested items
                let items = value
                    .pointer("/params/items")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                json!(vec![Value::Null; items])
            }
            "window/workDoneProgress/create" | "client/registerCapability" => Value::Null,
            _ => Value::Null,
        };
        let _ = write_lsp_message(
            stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            }),
        )
        .await;
        let _ = app.emit(
            "lsp-server-request",
            json!({
                "serverId": server_id,
                "method": method,
                "params": value.get("params").cloned().unwrap_or(Value::Null),
            }),
        );
        return;
    }

    // Notification (e.g. textDocument/publishDiagnostics)
    if let Some(method) = value.get("method").and_then(|m| m.as_str()) {
        let _ = app.emit(
            "lsp-notification",
            json!({
                "serverId": server_id,
                "method": method,
                "params": value.get("params").cloned().unwrap_or(Value::Null),
            }),
        );
    }
}

async fn write_lsp_message(
    stdin: &Arc<AsyncMutex<ChildStdin>>,
    msg: &Value,
) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut guard = stdin.lock().await;
    guard
        .write_all(header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    guard
        .write_all(body.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    guard.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn read_lsp_message<R: AsyncReadExt + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().ok();
        }
    }
    let len = content_length.ok_or_else(|| "LSP message missing Content-Length".to_string())?;
    let mut buf = vec![0u8; len];
    reader
        .read_exact(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&buf).map_err(|e| e.to_string())?;
    Ok(Some(value))
}

pub fn path_to_uri(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        // Windows-style
        let normalized = s.replace('\\', "/");
        format!("file:///{normalized}")
    }
}

pub fn rel_to_uri(root: &Path, rel: &str) -> String {
    path_to_uri(&root.join(rel))
}

fn initialization_options(id: &str) -> Value {
    match id {
        "typescript" => json!({ "hostInfo": "skunkworks-grok-ui" }),
        _ => json!({}),
    }
}

fn missing_hint(id: &str) -> String {
    match id {
        "typescript" => {
            "Install: npm i -g typescript typescript-language-server".into()
        }
        "python" => {
            "Install: pip install pyright  (or basedpyright / python-lsp-server)".into()
        }
        "rust" => "Install: rustup component add rust-analyzer".into(),
        "cpp" => "Install: clangd (e.g. brew install llvm)".into(),
        _ => format!("No language server configured for `{id}`"),
    }
}

fn resolve_server_command(id: &str) -> Option<(String, Vec<String>)> {
    match id {
        "typescript" => first_which(&[("typescript-language-server", vec!["--stdio".into()])])
            .or_else(|| {
                which::which("npx").ok().map(|p| {
                    (
                        p.to_string_lossy().to_string(),
                        vec![
                            "-y".into(),
                            "typescript-language-server".into(),
                            "--stdio".into(),
                        ],
                    )
                })
            }),
        "python" => first_which(&[
            ("pyright-langserver", vec!["--stdio".into()]),
            ("basedpyright-langserver", vec!["--stdio".into()]),
            ("pylsp", vec![]),
        ]),
        "rust" => first_which(&[("rust-analyzer", vec![])]),
        "cpp" => first_which(&[("clangd", vec![])]),
        _ => None,
    }
}

fn first_which(candidates: &[(&str, Vec<String>)]) -> Option<(String, Vec<String>)> {
    for (bin, args) in candidates {
        if let Ok(path) = which::which(bin) {
            return Some((path.to_string_lossy().to_string(), args.clone()));
        }
    }
    None
}
