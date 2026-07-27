//! SSH helpers: config hosts, remote exec, directory browse, agent probe.
//!
//! Kept separate from the ACP JSON-RPC connection so protocol code stays dense.

use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

use crate::store::AgentBackend;

const REMOTE_PATH_EXPORT: &str = r#"export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims:$HOME/.local/share/fnm/aliases/default/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; for agent_bin_dir in "$HOME"/.nvm/versions/node/*/bin; do if [ -d "$agent_bin_dir" ]; then PATH="$agent_bin_dir:$PATH"; fi; done; export PATH"#;

/// Quote for a single remote shell argument (OpenSSH concatenates argv with spaces).
pub(crate) fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `bash -lc '<cmd>'` as one ssh remote-command argument.
pub(crate) fn ssh_remote_bash_lc(inner: &str) -> String {
    format!("bash -lc {}", shell_single_quote(inner))
}

/// Shell command run on the remote host under `bash -lc`.
pub(crate) fn remote_agent_shell_command(
    backend: AgentBackend,
    remote_grok_path: Option<&str>,
) -> String {
    let invocation = match backend {
        AgentBackend::Grok => {
            let binary = remote_grok_path
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("grok");
            if binary == "grok" {
                "grok agent --no-leader --always-approve stdio".to_string()
            } else {
                format!(
                    "{} agent --no-leader --always-approve stdio",
                    shell_single_quote(binary)
                )
            }
        }
        AgentBackend::Codex => "codex-acp".to_string(),
        AgentBackend::Claude => "claude-agent-acp".to_string(),
    };

    // Non-interactive SSH sessions need common user install locations explicitly.
    // ACP adapters must not try to open a browser on the remote host.
    format!("{REMOTE_PATH_EXPORT}; export NO_BROWSER=1; exec {invocation}")
}

pub(crate) fn resolve_grok_binary(explicit: Option<String>) -> Result<String> {
    if let Some(path) = explicit.filter(|path| !path.trim().is_empty()) {
        return Ok(path);
    }
    if let Ok(path) = std::env::var("GROK_PATH") {
        if !path.trim().is_empty() {
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

/// Resolve the selected local ACP executable without installing anything at runtime.
pub(crate) fn resolve_agent_binary(
    backend: AgentBackend,
    explicit_grok_path: Option<String>,
) -> Result<String> {
    match backend {
        AgentBackend::Grok => resolve_grok_binary(explicit_grok_path),
        AgentBackend::Codex => resolve_adapter_binary(
            "CODEX_ACP_PATH",
            "codex-acp",
            "@agentclientprotocol/codex-acp@1.1.4",
        ),
        AgentBackend::Claude => resolve_adapter_binary(
            "CLAUDE_ACP_PATH",
            "claude-agent-acp",
            "@agentclientprotocol/claude-agent-acp@0.59.0",
        ),
    }
}

fn resolve_adapter_binary(env_var: &str, binary: &str, package: &str) -> Result<String> {
    if let Ok(path) = std::env::var(env_var) {
        if !path.trim().is_empty() {
            return Ok(path);
        }
    }
    if let Ok(path) = which::which(binary) {
        return Ok(path.to_string_lossy().to_string());
    }
    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{binary}")),
        PathBuf::from(format!("/usr/local/bin/{binary}")),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.splice(
            0..0,
            [
                home.join(".local/bin").join(binary),
                home.join(".volta/bin").join(binary),
                home.join(".asdf/shims").join(binary),
                home.join(".local/share/mise/shims").join(binary),
                home.join(".local/share/fnm/aliases/default/bin")
                    .join(binary),
            ],
        );
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            candidates.extend(
                versions
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path().join("bin").join(binary)),
            );
        }
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Ok(path.to_string_lossy().to_string());
    }
    anyhow::bail!(
        "could not find `{binary}`; set {env_var} or run `npm install --global {package}`"
    )
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

/// Probe a remote host for the selected ACP executable and its home directory.
///
/// Only Grok accepts an explicit remote path. Codex and Claude adapters are
/// deliberately resolved from the remote login shell's PATH.
pub async fn probe_ssh_backend(
    host: &str,
    backend: AgentBackend,
    remote_grok_path: Option<&str>,
) -> Result<Value> {
    let explicit_grok_path = if backend == AgentBackend::Grok {
        remote_grok_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
    } else {
        None
    };
    let binary_name = match backend {
        AgentBackend::Grok => "grok",
        AgentBackend::Codex => "codex-acp",
        AgentBackend::Claude => "claude-agent-acp",
    };
    let which_cmd = match explicit_grok_path {
        Some(path) => {
            let quoted = shell_single_quote(path);
            format!(
                "{REMOTE_PATH_EXPORT}; \
                 if [ -x {quoted} ]; then printf 'AGENT=%s\\n' {quoted}; \
                 else printf 'AGENT=\\n'; fi; \
                 printf 'HOME=%s\\n' \"$HOME\""
            )
        }
        None => format!(
            "{REMOTE_PATH_EXPORT}; \
             agent_path=$(command -v {binary_name} 2>/dev/null || true); \
             printf 'AGENT=%s\\n' \"$agent_path\"; \
             printf 'HOME=%s\\n' \"$HOME\""
        ),
    };
    let out = ssh_exec(host, &which_cmd).await?;
    let mut agent_path = String::new();
    let mut home = String::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("AGENT=") {
            agent_path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("HOME=") {
            home = rest.to_string();
        }
    }
    if agent_path.is_empty() {
        let hint = match backend {
            AgentBackend::Grok if explicit_grok_path.is_some() => {
                "check the configured remote Grok path"
            }
            AgentBackend::Grok => "install Grok Build or set a remote Grok path",
            AgentBackend::Codex => {
                "run `npm install --global @agentclientprotocol/codex-acp@1.1.4` on the remote host"
            }
            AgentBackend::Claude => {
                "run `npm install --global @agentclientprotocol/claude-agent-acp@0.59.0` on the remote host"
            }
        };
        anyhow::bail!("could not find `{binary_name}` on `{host}` (login shell PATH); {hint}");
    }

    let mut result = json!({
        "host": host,
        "backend": backend,
        "agentPath": agent_path,
        "home": home,
        "environmentId": format!("ssh:{host}"),
        "ok": true,
    });
    if backend == AgentBackend::Grok {
        result["grokPath"] = result["agentPath"].clone();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_grok_command_keeps_arguments_and_quotes_explicit_path() {
        let command =
            remote_agent_shell_command(AgentBackend::Grok, Some("/opt/it's grok/bin/grok"));

        assert!(command.contains("export NO_BROWSER=1"));
        assert!(command.contains(
            "exec '/opt/it'\\''s grok/bin/grok' agent --no-leader --always-approve stdio"
        ));
    }

    #[test]
    fn remote_adapter_commands_have_no_arguments_or_runtime_installer() {
        let codex = remote_agent_shell_command(AgentBackend::Codex, Some("/ignored/grok"));
        let claude = remote_agent_shell_command(AgentBackend::Claude, Some("/ignored/grok"));

        assert!(codex.ends_with("exec codex-acp"));
        assert!(claude.ends_with("exec claude-agent-acp"));
        assert!(!codex.contains("npx"));
        assert!(!claude.contains("npx"));
        assert!(!codex.contains("/ignored/grok"));
        assert!(!claude.contains("/ignored/grok"));
    }
}
