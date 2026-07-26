//! SSH helpers: config hosts, remote exec, directory browse, grok probe.
//!
//! Kept separate from the ACP JSON-RPC connection so protocol code stays dense.

use std::process::Stdio;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;

/// Quote for a single remote shell argument (OpenSSH concatenates argv with spaces).
pub(crate) fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `bash -lc '<cmd>'` as one ssh remote-command argument.
pub(crate) fn ssh_remote_bash_lc(inner: &str) -> String {
    format!("bash -lc {}", shell_single_quote(inner))
}

/// Shell command run on the remote host under `bash -lc`.
pub(crate) fn remote_agent_shell_command(remote_grok_path: Option<&str>) -> String {
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

pub(crate) fn resolve_grok_binary(explicit: Option<String>) -> Result<String> {
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

