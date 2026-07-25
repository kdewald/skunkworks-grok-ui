//! Live ACP integration test against the local `grok` CLI.
//!
//! Spawns `grok agent --no-leader --always-approve stdio`, runs a prompt that
//! should produce intermediate reasoning, and records every `session/update`
//! kind + text so we can see whether thought vs message channels are labeled
//! correctly on the wire (independent of the UI).
//!
//! ## Run (requires authenticated `grok` on PATH)
//!
//! ```bash
//! cd src-tauri
//! GROK_ACP_LIVE=1 cargo test --test acp_thought_labels -- --ignored --nocapture
//! ```
//!
//! Optional:
//! - `GROK_BIN=/path/to/grok` — override binary
//! - `GROK_ACP_STRICT=1` — fail if status-like text appears on `agent_thought_chunk`
//! - `GROK_ACP_TIMEOUT_SECS=180` — prompt timeout (default 120)

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// ── helpers ─────────────────────────────────────────────────────────────────

fn live_enabled() -> bool {
    matches!(
        std::env::var("GROK_ACP_LIVE").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

fn grok_bin() -> PathBuf {
    if let Ok(p) = std::env::var("GROK_BIN") {
        return PathBuf::from(p);
    }
    which::which("grok").expect("grok not found on PATH; set GROK_BIN or install Grok CLI")
}

fn timeout() -> Duration {
    let secs: u64 = std::env::var("GROK_ACP_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(120);
    Duration::from_secs(secs)
}

fn extract_chunk_text(update: &Value) -> String {
    if let Some(text) = update.pointer("/content/text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    if let Some(content) = update.get("content") {
        if let Some(text) = content.as_str() {
            return text.to_string();
        }
        if let Some(text) = content.get("text").and_then(|t| t.as_str()) {
            return text.to_string();
        }
    }
    if let Some(text) = update.get("text").and_then(|t| t.as_str()) {
        return text.to_string();
    }
    String::new()
}

fn update_kind(update: &Value) -> String {
    update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string()
}

/// Same-ish prefixes the UI uses when re-routing mislabeled thought chunks.
fn looks_like_status_message(text: &str) -> bool {
    let t = text.trim_start();
    let t = t.trim_start_matches(['*', '_', '`', '"', '\'', '“', '”']);
    const PREFIXES: &[&str] = &[
        "Got it",
        "I'll ",
        "I will ",
        "I see ",
        "I see what",
        "Here's ",
        "Here are ",
        "Here is ",
        "Done.",
        "Done!",
        "Fixing ",
        "Implementing ",
        "Restoring ",
        "Checking ",
        "Reading ",
        "Looking ",
        "Building ",
        "Updating ",
        "Cleaning ",
        "Removing ",
        "Adding ",
        "Creating ",
        "Writing ",
        "Running ",
        "Sorry ",
        "Sure ",
        "Of course",
        "Sounds good",
        "On it",
        "Working on",
    ];
    PREFIXES
        .iter()
        .any(|p| t.starts_with(p) || t.starts_with(&p.to_ascii_lowercase()))
}

// ── minimal ACP stdio client ────────────────────────────────────────────────

struct AcpStdio {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    /// Incoming lines from the agent stdout reader.
    rx: Receiver<Value>,
    /// Pending JSON-RPC responses keyed by id (as string form of number/string).
    pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
    /// session/update params collected for this connection only (not a process-global).
    notifications: Arc<Mutex<Vec<Value>>>,
}

fn rpc_id_key(id: &Value) -> String {
    match id {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl AcpStdio {
    fn spawn() -> Self {
        let bin = grok_bin();
        let mut child = Command::new(&bin)
            .args([
                "agent",
                "--no-leader",
                "--always-approve",
                "stdio",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("failed to spawn `{} agent stdio`: {e}", bin.display()));

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    eprintln!("[grok-stderr] {line}");
                }
            });
        }

        let (tx_line, rx_line) = mpsc::channel::<Value>();
        let pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_r = Arc::clone(&pending);
        let notifications: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[grok-stdout] parse error: {e}; line={line}");
                        continue;
                    }
                };

                // Response to our request (id present, no method).
                if let Some(id) = msg.get("id") {
                    if msg.get("method").is_none() {
                        let key = rpc_id_key(id);
                        let result = if let Some(err) = msg.get("error") {
                            Err(format!("RPC error: {err}"))
                        } else {
                            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                        };
                        if let Some(tx) = pending_r.lock().unwrap().remove(&key) {
                            let _ = tx.send(result);
                        }
                        continue;
                    }
                }

                // Agent→client request or notification — forward to main loop.
                let _ = tx_line.send(msg);
            }
        });

        Self {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            rx: rx_line,
            pending,
            notifications,
        }
    }

    fn write_json(&mut self, value: &Value) {
        let mut line = serde_json::to_string(value).expect("serialize");
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .expect("write stdin");
        self.stdin.flush().expect("flush stdin");
    }

    fn request(&mut self, method: &str, params: Value, wait: Duration) -> Result<Value, String> {
        let id_num = self.next_id.fetch_add(1, Ordering::SeqCst);
        let id_key = id_num.to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id_key.clone(), tx);

        self.write_json(&json!({
            "jsonrpc": "2.0",
            "id": id_num,
            "method": method,
            "params": params,
        }));

        // Drain agent→client traffic while waiting for the response.
        let deadline = Instant::now() + wait;
        loop {
            // Check if response already arrived.
            match rx.try_recv() {
                Ok(res) => return res,
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(format!("response channel closed for {method}"));
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            if Instant::now() >= deadline {
                self.pending.lock().unwrap().remove(&id_key);
                return Err(format!("timeout waiting for {method} ({wait:?})"));
            }
            // Process agent messages with a short wait so we don't spin.
            let remain = deadline.saturating_duration_since(Instant::now());
            let slice = remain.min(Duration::from_millis(50));
            match self.rx.recv_timeout(slice) {
                Ok(msg) => self.handle_agent_message(msg),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("agent stdout closed".into());
                }
            }
        }
    }

    fn handle_agent_message(&mut self, msg: Value) {
        // Agent→client request (has id + method).
        if let (Some(id), Some(method)) = (msg.get("id"), msg.get("method").and_then(|m| m.as_str()))
        {
            match method {
                "session/request_permission" => {
                    // Auto-allow: pick first option id if present, else empty allow.
                    let option_id = msg
                        .pointer("/params/options/0/optionId")
                        .or_else(|| msg.pointer("/params/options/0/id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("allow");
                    self.write_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "outcome": {
                                "outcome": "selected",
                                "optionId": option_id,
                            }
                        }
                    }));
                }
                "fs/read_text_file" | "fs/write_text_file" => {
                    self.write_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "client fs disabled" }
                    }));
                }
                _ => {
                    // Keep the agent moving.
                    self.write_json(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {}
                    }));
                }
            }
            return;
        }

        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            if method == "session/update" {
                self.notifications
                    .lock()
                    .unwrap()
                    .push(msg.get("params").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn drain_pending_notifications(&mut self, budget: Duration) {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(20)) {
                Ok(msg) => self.handle_agent_message(msg),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
}

impl Drop for AcpStdio {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Default)]
struct StreamStats {
    thought_chunks: usize,
    message_chunks: usize,
    other_updates: HashMap<String, usize>,
    thought_text: String,
    message_text: String,
    /// Thought chunks that look like user-facing status (possible mislabels).
    status_like_on_thought: Vec<String>,
    /// Ordered (kind, text) for every text-bearing update.
    chunk_log: Vec<(String, String)>,
}

fn consume_notifications(acp: &AcpStdio, stats: &mut StreamStats) {
    let batch = std::mem::take(&mut *acp.notifications.lock().unwrap());
    for params in batch {
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let kind = update_kind(&update);
        let text = extract_chunk_text(&update);
        if matches!(
            kind.as_str(),
            "agent_thought_chunk" | "agent_message_chunk"
        ) || !text.is_empty()
        {
            stats.chunk_log.push((kind.clone(), text.clone()));
        }
        match kind.as_str() {
            "agent_thought_chunk" => {
                stats.thought_chunks += 1;
                if looks_like_status_message(&text) {
                    stats
                        .status_like_on_thought
                        .push(text.chars().take(160).collect());
                }
                stats.thought_text.push_str(&text);
            }
            "agent_message_chunk" => {
                stats.message_chunks += 1;
                stats.message_text.push_str(&text);
            }
            other => {
                *stats.other_updates.entry(other.to_string()).or_insert(0) += 1;
            }
        }
    }
}

// ── test ────────────────────────────────────────────────────────────────────

/// Pure reasoning (no tools) — baseline that the CLI labels cleanly.
const THINKING_PROMPT: &str = "\
Think carefully step by step before answering. Do not use any tools.

Compute (17 × 23) + (41 × 19) − 88. Show the intermediate products in your \
reasoning, then give only the final integer as the user-visible answer on its own line.

Do not call tools, do not read files, do not run shell commands.";

/// Coding-style turn that mirrors the desktop bug report (plan → announce → act).
const CODING_STYLE_PROMPT: &str = "\
You are a coding agent. The user said:

\"I preferred the old fonts, and remove the LLM note, that shouldn't go there\"

1) Think step by step about what they want (list 1–3 concrete file changes).
2) Then announce your plan to the user in a short status line starting with \
   exactly: Got it—
3) Then give a short final reply describing the edit plan (do NOT use tools, \
   do NOT edit files).

Do not call tools.";

struct LiveSession {
    acp: AcpStdio,
    session_id: String,
}

fn connect_session(cwd: &std::path::Path) -> LiveSession {
    let mut acp = AcpStdio::spawn();
    let wait_short = Duration::from_secs(60);

    let init = acp
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false
                },
                "clientInfo": {
                    "name": "skunkworks-grok-ui-test",
                    "title": "ACP thought label probe",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
            wait_short,
        )
        .expect("initialize");
    eprintln!(
        "initialize ok: keys={:?}",
        init.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );

    let methods: Vec<String> = init
        .get("authMethods")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let method_id = if methods.iter().any(|m| m == "cached_token") {
        "cached_token".to_string()
    } else if let Some(d) = init
        .pointer("/_meta/defaultAuthMethodId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        d.to_string()
    } else if methods.len() == 1 {
        methods[0].clone()
    } else {
        panic!("no usable auth method (have {methods:?}); run `grok` once to sign in");
    };
    acp.request(
        "authenticate",
        json!({ "methodId": method_id }),
        wait_short,
    )
    .expect("authenticate");
    eprintln!("authenticate ok ({method_id})");

    let _ = std::fs::create_dir_all(cwd);
    let session = acp
        .request(
            "session/new",
            json!({
                "cwd": cwd.to_string_lossy(),
                "mcpServers": []
            }),
            wait_short,
        )
        .expect("session/new");
    let session_id = session
        .get("sessionId")
        .and_then(|s| s.as_str())
        .expect("sessionId")
        .to_string();
    eprintln!("session/new ok: {session_id}");

    LiveSession { acp, session_id }
}

fn run_prompt(session: &mut LiveSession, prompt: &str) -> StreamStats {
    session.acp.notifications.lock().unwrap().clear();
    let mut stats = StreamStats::default();

    let prompt_started = Instant::now();
    let prompt_result = session.acp.request(
        "session/prompt",
        json!({
            "sessionId": session.session_id,
            "prompt": [{ "type": "text", "text": prompt }]
        }),
        timeout(),
    );
    session
        .acp
        .drain_pending_notifications(Duration::from_millis(500));
    consume_notifications(&session.acp, &mut stats);

    let prompt_result = prompt_result.expect("session/prompt");
    eprintln!(
        "session/prompt finished in {:?}: stopReason={:?}",
        prompt_started.elapsed(),
        prompt_result.get("stopReason")
    );
    print_stats(&stats);
    stats
}

fn print_stats(stats: &StreamStats) {
    eprintln!("── wire stream summary ──");
    eprintln!("  agent_thought_chunk : {}", stats.thought_chunks);
    eprintln!("  agent_message_chunk : {}", stats.message_chunks);
    eprintln!("  other sessionUpdate : {:?}", stats.other_updates);
    eprintln!(
        "  thought text ({} chars): {:?}",
        stats.thought_text.len(),
        stats.thought_text.chars().take(500).collect::<String>()
    );
    eprintln!(
        "  message text ({} chars): {:?}",
        stats.message_text.len(),
        stats.message_text.chars().take(500).collect::<String>()
    );
    if !stats.status_like_on_thought.is_empty() {
        eprintln!(
            "  status-like on THOUGHT channel ({}):",
            stats.status_like_on_thought.len()
        );
        for (i, s) in stats.status_like_on_thought.iter().enumerate() {
            eprintln!("    [{i}] {s:?}");
        }
    } else {
        eprintln!("  status-like on THOUGHT channel: none");
    }
    // First ~30 chunk kinds for order diagnosis
    eprintln!("  first chunks:");
    for (i, (k, t)) in stats.chunk_log.iter().take(40).enumerate() {
        eprintln!(
            "    {i:02} {k:22} {:?}",
            t.chars().take(80).collect::<String>()
        );
    }
}

fn assert_basic_streams(stats: &StreamStats) {
    assert!(
        stats.message_chunks > 0,
        "expected at least one agent_message_chunk; got 0 (total updates: {:?})",
        stats.other_updates
    );
    assert!(
        !stats.message_text.trim().is_empty(),
        "message chunks present but empty text"
    );
    // Thinking is expected for our prompts but not guaranteed every model call.
    if stats.thought_chunks == 0 {
        eprintln!("  WARN: no agent_thought_chunk on this run (agent skipped reasoning stream)");
    } else {
        assert!(!stats.thought_text.trim().is_empty());
    }
}

fn assert_strict_if_enabled(stats: &StreamStats) {
    if matches!(
        std::env::var("GROK_ACP_STRICT").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    ) {
        assert!(
            stats.status_like_on_thought.is_empty(),
            "GROK_ACP_STRICT: status-like text on agent_thought_chunk: {:?}",
            stats.status_like_on_thought
        );
    }
}

#[test]
#[ignore = "live: set GROK_ACP_LIVE=1 and run with --ignored (needs grok CLI + auth)"]
fn grok_cli_emits_thought_and_message_chunks() {
    if !live_enabled() {
        eprintln!("skip: set GROK_ACP_LIVE=1 to run this live test");
        return;
    }

    let cwd = std::env::temp_dir().join("grok-ui-acp-thought-test");
    let mut session = connect_session(&cwd);
    let stats = run_prompt(&mut session, THINKING_PROMPT);
    assert_basic_streams(&stats);
    assert_strict_if_enabled(&stats);
}

/// Coding-style prompt that previously produced "Got it—" inside Thinking in the UI.
#[test]
#[ignore = "live: set GROK_ACP_LIVE=1 and run with --ignored (needs grok CLI + auth)"]
fn grok_cli_coding_style_status_vs_thought() {
    if !live_enabled() {
        eprintln!("skip: set GROK_ACP_LIVE=1 to run this live test");
        return;
    }

    let cwd = std::env::temp_dir().join("grok-ui-acp-coding-thought-test");
    // Tiny fake project so the agent has a path context.
    let _ = std::fs::create_dir_all(cwd.join("src"));
    let _ = std::fs::write(
        cwd.join("src/layout.tsx"),
        "export default function Layout() { return <div>LLM note here</div>; }\n",
    );

    let mut session = connect_session(&cwd);
    let stats = run_prompt(&mut session, CODING_STYLE_PROMPT);
    assert_basic_streams(&stats);

    // Diagnose: is "Got it" on the thought channel (agent) or only on message (correct)?
    let got_it_on_thought = stats.thought_text.contains("Got it");
    let got_it_on_message = stats.message_text.contains("Got it");
    eprintln!("  Got it on thought={got_it_on_thought} on message={got_it_on_message}");

    // Always report; fail in strict mode or if message channel never got the status
    // while thought did (the desktop bug pattern).
    if got_it_on_thought && !got_it_on_message {
        eprintln!(
            "BUG PATTERN: status 'Got it' only on agent_thought_chunk (agent mislabel or dual-channel draft)"
        );
    }
    assert_strict_if_enabled(&stats);

    // Soft fail when the classic mix pattern appears on the wire — this is the
    // signal the desktop UI was papering over. Fail so we don't ignore it.
    assert!(
        !(got_it_on_thought && stats.thought_text.contains("old fonts") && !got_it_on_message),
        "wire put status 'Got it' into the same thought stream as reasoning without a message: \
         thought={:?} message={:?}",
        stats.thought_text.chars().take(300).collect::<String>(),
        stats.message_text.chars().take(300).collect::<String>()
    );
}

/// Tool-using turn (closer to real desktop coding sessions).
const TOOL_CODING_PROMPT: &str = "\
The user said: \"I preferred the old fonts, and remove the LLM note\".

1) Think step by step about what to change.
2) Read src/layout.tsx with a tool.
3) Briefly tell the user what you found and what you would change.
Do not edit files — read only.";

#[test]
#[ignore = "live: set GROK_ACP_LIVE=1 and run with --ignored (needs grok CLI + auth)"]
fn grok_cli_tool_turn_thought_vs_message() {
    if !live_enabled() {
        eprintln!("skip: set GROK_ACP_LIVE=1 to run this live test");
        return;
    }

    let cwd = std::env::temp_dir().join("grok-ui-acp-tool-thought-test");
    let _ = std::fs::create_dir_all(cwd.join("src"));
    let _ = std::fs::write(
        cwd.join("src/layout.tsx"),
        r#"export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html className="font-body">
      <body>
        {/* LLM note: generated by AI */}
        {children}
      </body>
    </html>
  );
}
"#,
    );

    let mut session = connect_session(&cwd);
    let stats = run_prompt(&mut session, TOOL_CODING_PROMPT);
    assert_basic_streams(&stats);

    let mut thought_runs: Vec<String> = Vec::new();
    let mut msg_runs: Vec<String> = Vec::new();
    let mut cur_kind = String::new();
    let mut cur = String::new();
    for (k, t) in &stats.chunk_log {
        if k != "agent_thought_chunk" && k != "agent_message_chunk" {
            continue;
        }
        if *k != cur_kind {
            if cur_kind == "agent_thought_chunk" && !cur.is_empty() {
                thought_runs.push(std::mem::take(&mut cur));
            } else if cur_kind == "agent_message_chunk" && !cur.is_empty() {
                msg_runs.push(std::mem::take(&mut cur));
            }
            cur_kind = k.clone();
            cur = t.clone();
        } else {
            cur.push_str(t);
        }
    }
    if cur_kind == "agent_thought_chunk" && !cur.is_empty() {
        thought_runs.push(cur);
    } else if cur_kind == "agent_message_chunk" && !cur.is_empty() {
        msg_runs.push(cur);
    }

    eprintln!("  thought runs ({}):", thought_runs.len());
    for (i, r) in thought_runs.iter().enumerate() {
        eprintln!("    T{i}: {:?}", r.chars().take(200).collect::<String>());
    }
    eprintln!("  message runs ({}):", msg_runs.len());
    for (i, r) in msg_runs.iter().enumerate() {
        eprintln!("    M{i}: {:?}", r.chars().take(200).collect::<String>());
    }

    let mixed_thought = thought_runs.iter().any(|r| {
        let has_plan = r.contains("user wants")
            || r.contains("User wants")
            || r.contains("need to")
            || r.contains("should ");
        let has_status = looks_like_status_message(r)
            || r.contains("Got it")
            || r.contains("I'll restore")
            || r.contains("I'll read");
        has_plan && has_status
    });
    eprintln!("  mixed plan+status in one thought run: {mixed_thought}");
    assert_strict_if_enabled(&stats);
    assert!(
        !mixed_thought,
        "wire mixed plan+status inside one thought run: {thought_runs:?}"
    );
}
