//! Project-scoped interactive terminal (local PTY; SSH for remote projects).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::store::{
    ensure_scratch_chat_dir, ensure_scratch_root, AppData, Environment, Project, LOCAL_ENV_ID,
    SCRATCH_PROJECT_ID,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub cwd: String,
    pub project_id: String,
    pub remote: bool,
}

struct LiveTerminal {
    id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    /// Keep master alive for the session lifetime (not Sync — behind Mutex).
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Child process handle for kill/wait.
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<LiveTerminal>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl TerminalManager {
    pub fn open(
        &self,
        app: AppHandle,
        data: &AppData,
        project_id: &str,
        chat_id: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        let project = data
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .cloned()
            .ok_or_else(|| format!("unknown project: {project_id}"))?;

        let env = data
            .environments
            .iter()
            .find(|e| e.id == project.environment_id)
            .cloned();

        let remote = project.environment_id != LOCAL_ENV_ID
            && env
                .as_ref()
                .map(|e| e.kind == "ssh")
                .unwrap_or(false);

        let (cwd, cmd) = if remote {
            build_remote_command(&project, env.as_ref(), chat_id)?
        } else {
            build_local_command(&project, chat_id)?
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("open pty: {e}"))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell: {e}"))?;
        // Drop slave so the child owns the tty end.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take pty writer: {e}"))?;

        let id = Uuid::new_v4().to_string();
        let live = Arc::new(LiveTerminal {
            id: id.clone(),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        });

        self.sessions.lock().insert(id.clone(), Arc::clone(&live));

        // Reader thread → frontend events.
        let app_out = app.clone();
        let term_id = id.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_out.emit(
                            "terminal-data",
                            TerminalDataPayload {
                                id: term_id.clone(),
                                data: chunk,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let _ = app_out.emit(
                "terminal-exit",
                TerminalExitPayload {
                    id: term_id,
                    code: None,
                },
            );
        });

        // Reap child when it exits (separate from reader EOF in some cases).
        let app_exit = app;
        let live_wait = Arc::clone(&live);
        thread::spawn(move || {
            let code = {
                let mut child = live_wait.child.lock();
                match child.wait() {
                    Ok(status) => status.exit_code(),
                    Err(_) => 1,
                }
            };
            let _ = app_exit.emit(
                "terminal-exit",
                TerminalExitPayload {
                    id: live_wait.id.clone(),
                    code: Some(code as i32),
                },
            );
        });

        Ok(TerminalInfo {
            id,
            cwd,
            project_id: project_id.to_string(),
            remote,
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let live = {
            let sessions = self.sessions.lock();
            sessions.get(id).cloned()
        }
        .ok_or_else(|| format!("unknown terminal: {id}"))?;
        let mut w = live.writer.lock();
        w.write_all(data.as_bytes())
            .map_err(|e| format!("write terminal: {e}"))?;
        w.flush().map_err(|e| format!("flush terminal: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let live = {
            let sessions = self.sessions.lock();
            sessions.get(id).cloned()
        }
        .ok_or_else(|| format!("unknown terminal: {id}"))?;
        let result = live.master.lock().resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
        result.map_err(|e| format!("resize terminal: {e}"))
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let live = {
            let mut sessions = self.sessions.lock();
            sessions.remove(id)
        };
        if let Some(live) = live {
            if let Some(mut child) = live.child.try_lock() {
                let _ = child.kill();
            }
        }
        Ok(())
    }

}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataPayload {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    id: String,
    code: Option<i32>,
}

fn is_scratch(project: &Project) -> bool {
    project.is_scratch
        || project.id == SCRATCH_PROJECT_ID
        || project.id.starts_with("scratch:")
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".into()
        } else {
            "/bin/zsh".into()
        }
    })
}

fn build_local_command(
    project: &Project,
    chat_id: Option<&str>,
) -> Result<(String, CommandBuilder), String> {
    let cwd = if is_scratch(project) {
        if let Some(cid) = chat_id.filter(|s| !s.is_empty()) {
            ensure_scratch_chat_dir(cid).map_err(|e| e.to_string())?
        } else {
            ensure_scratch_root().map_err(|e| e.to_string())?
        }
        .to_string_lossy()
        .to_string()
    } else {
        project.path.clone()
    };

    if !is_scratch(project) {
        let p = std::path::Path::new(&cwd);
        if !p.is_dir() {
            return Err(format!("project folder does not exist: {cwd}"));
        }
    }

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // Login shell so PATH / profile match a normal terminal.
    if !cfg!(windows) {
        cmd.arg("-l");
    }
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    Ok((cwd, cmd))
}

fn build_remote_command(
    project: &Project,
    env: Option<&Environment>,
    chat_id: Option<&str>,
) -> Result<(String, CommandBuilder), String> {
    let host = env
        .and_then(|e| e.ssh_host.as_deref())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            project
                .environment_id
                .strip_prefix("ssh:")
                .filter(|s| !s.is_empty())
        })
        .ok_or_else(|| "remote project has no SSH host".to_string())?;

    let (display_cwd, remote_inner) = if is_scratch(project) {
        if let Some(cid) = chat_id.filter(|s| !s.is_empty()) {
            if cid.contains('/') || cid.contains('\'') || cid.contains(' ') || cid.contains("..") {
                return Err("invalid scratch chat id".into());
            }
            (
                format!("$HOME/.grok-ui/scratch/{cid}"),
                format!(
                    "mkdir -p \"$HOME/.grok-ui/scratch/{cid}\" && cd \"$HOME/.grok-ui/scratch/{cid}\" && exec \"${{SHELL:-/bin/bash}}\" -l"
                ),
            )
        } else {
            (
                "$HOME/.grok-ui/scratch".into(),
                "mkdir -p \"$HOME/.grok-ui/scratch\" && cd \"$HOME/.grok-ui/scratch\" && exec \"${{SHELL:-/bin/bash}}\" -l".into(),
            )
        }
    } else {
        (
            project.path.clone(),
            format!(
                "cd {} && exec \"${{SHELL:-/bin/bash}}\" -l",
                shell_single_quote(&project.path)
            ),
        )
    };

    let mut cmd = CommandBuilder::new("ssh");
    // Force a TTY so interactive programs work over SSH.
    cmd.arg("-tt");
    cmd.arg(host);
    // Single remote command argument (OpenSSH joins argv with spaces).
    cmd.arg(format!("bash -lc {}", shell_single_quote(&remote_inner)));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    Ok((display_cwd, cmd))
}
