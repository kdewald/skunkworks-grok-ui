//! Project-sandboxed workspace filesystem (local + SSH) for the Files view.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::store::{
    ensure_scratch_chat_dir, ensure_scratch_root, AppData, Project, LOCAL_ENV_ID, SCRATCH_PROJECT_ID,
};

const MAX_READ_BYTES: u64 = 1_500_000;
const MAX_LIST_ENTRIES: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    /// Path relative to the project root, using `/` separators.
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    /// Relative path of the listed directory (`""` = project root).
    pub path: String,
    pub entries: Vec<WorkspaceEntry>,
    pub root_label: String,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub size: u64,
    pub binary: bool,
    pub language: String,
}

fn is_scratch(project: &Project) -> bool {
    project.is_scratch
        || project.id == SCRATCH_PROJECT_ID
        || project.id.starts_with("scratch:")
}

/// Normalize a relative path: no absolute, no `..`, `/` separators, no trailing slash.
pub fn normalize_rel(path: &str) -> Result<String, String> {
    let path = path.trim().trim_start_matches('/').trim_end_matches('/');
    if path.is_empty() {
        return Ok(String::new());
    }
    let mut out: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("path must stay inside the project".into());
        }
        if part.contains('\0') {
            return Err("invalid path".into());
        }
        out.push(part);
    }
    Ok(out.join("/"))
}

fn join_root(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = normalize_rel(rel)?;
    let mut full = root.to_path_buf();
    if !rel.is_empty() {
        for part in rel.split('/') {
            full.push(part);
        }
    }
    // Ensure we didn't escape via symlink after canonicalize when possible.
    let root_canon = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if full.exists() {
        let full_canon = fs::canonicalize(&full).map_err(|e| e.to_string())?;
        if !full_canon.starts_with(&root_canon) {
            return Err("path must stay inside the project".into());
        }
        Ok(full_canon)
    } else {
        // Parent must be inside root for writes/listing of missing — for read, error later.
        if let Some(parent) = full.parent() {
            if parent.exists() {
                let parent_canon = fs::canonicalize(parent).map_err(|e| e.to_string())?;
                if !parent_canon.starts_with(&root_canon) {
                    return Err("path must stay inside the project".into());
                }
            }
        }
        Ok(full)
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8_192)];
    if sample.contains(&0) {
        return true;
    }
    let non_text = sample
        .iter()
        .filter(|&&b| b < 0x09 || (b > 0x0d && b < 0x20) || b == 0x7f)
        .count();
    non_text * 100 > sample.len() * 5
}

fn language_from_name(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "md" | "mdx" | "markdown" | "mkd" => "markdown",
        "py" | "pyi" | "pyw" | "pyx" => "python",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "cppm" | "ixx" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "html" | "htm" => "html",
        "css" | "scss" => "css",
        "sql" => "sql",
        "xml" => "xml",
        "svg" => "xml",
        "txt" | "log" => "text",
        _ => "text",
    }
    .into()
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve absolute root path (local) or remote absolute path string.
pub fn resolve_workspace_root(
    data: &AppData,
    project_id: &str,
    chat_id: Option<&str>,
) -> Result<(Project, String, bool /* remote */), String> {
    let project = data
        .projects
        .iter()
        .find(|p| p.id == project_id)
        .cloned()
        .ok_or_else(|| format!("unknown project: {project_id}"))?;

    let remote = project.environment_id != LOCAL_ENV_ID
        && data
            .environments
            .iter()
            .find(|e| e.id == project.environment_id)
            .map(|e| e.kind == "ssh")
            .unwrap_or(false);

    if remote {
        let root = if is_scratch(&project) {
            if let Some(cid) = chat_id.filter(|s| !s.is_empty()) {
                if cid.contains('/') || cid.contains("..") {
                    return Err("invalid scratch chat id".into());
                }
                format!("$HOME/.grok-ui/scratch/{cid}")
            } else {
                "$HOME/.grok-ui/scratch".into()
            }
        } else {
            project.path.clone()
        };
        return Ok((project, root, true));
    }

    // Local
    let root = if is_scratch(&project) {
        if let Some(cid) = chat_id.filter(|s| !s.is_empty()) {
            ensure_scratch_chat_dir(cid).map_err(|e| e.to_string())?
        } else {
            ensure_scratch_root().map_err(|e| e.to_string())?
        }
    } else {
        let p = PathBuf::from(&project.path);
        if !p.is_dir() {
            return Err(format!("project folder does not exist: {}", project.path));
        }
        fs::canonicalize(&p).unwrap_or(p)
    };

    Ok((project, root.to_string_lossy().to_string(), false))
}

pub fn list_local(root: &Path, rel: &str) -> Result<WorkspaceListing, String> {
    let rel = normalize_rel(rel)?;
    let dir = join_root(root, &rel)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", rel));
    }

    let mut entries = Vec::new();
    let read = fs::read_dir(&dir).map_err(|e| format!("list dir: {e}"))?;
    for ent in read {
        if entries.len() >= MAX_LIST_ENTRIES {
            break;
        }
        let ent = match ent {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = ent.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" {
            continue;
        }
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        entries.push(WorkspaceEntry {
            name,
            path: child_rel,
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
    });

    Ok(WorkspaceListing {
        path: rel,
        entries,
        root_label: root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| root.to_string_lossy().to_string()),
        remote: false,
    })
}

pub fn read_local(root: &Path, rel: &str) -> Result<WorkspaceFileContent, String> {
    let rel = normalize_rel(rel)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    let file = join_root(root, &rel)?;
    if !file.is_file() {
        return Err(format!("not a file: {rel}"));
    }
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    let size = meta.len();
    let mut truncated = false;
    let bytes = if size > MAX_READ_BYTES {
        truncated = true;
        let mut f = fs::File::open(&file).map_err(|e| e.to_string())?;
        use std::io::Read;
        let mut buf = vec![0u8; MAX_READ_BYTES as usize];
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);
        buf
    } else {
        fs::read(&file).map_err(|e| e.to_string())?
    };

    let name = file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let language = language_from_name(&name);

    if looks_binary(&bytes) {
        return Ok(WorkspaceFileContent {
            path: rel,
            content: String::new(),
            truncated: false,
            size,
            binary: true,
            language,
        });
    }

    let content = String::from_utf8_lossy(&bytes).to_string();
    Ok(WorkspaceFileContent {
        path: rel,
        content,
        truncated,
        size,
        binary: false,
        language,
    })
}

pub fn list_remote(host: &str, root: &str, rel: &str) -> Result<WorkspaceListing, String> {
    let rel = normalize_rel(rel)?;
    // Build remote path. root may contain $HOME for scratch.
    let remote_path = if rel.is_empty() {
        root.to_string()
    } else if root.contains("$HOME") {
        format!("{root}/{rel}")
    } else {
        let root = root.trim_end_matches('/');
        format!("{root}/{rel}")
    };

    // Portable listing (no GNU find -printf) so macOS remotes work.
    let portable = format!(
        r#"set -e
target={}
target=$(eval echo "$target")
if [ ! -d "$target" ]; then
  echo "ERR:not a directory" >&2
  exit 1
fi
cd "$target" || exit 1
# list: type path
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || continue
  [ "$f" = "." ] && continue
  [ "$f" = ".." ] && continue
  [ "$f" = ".DS_Store" ] && continue
  if [ -d "$f" ]; then
    printf 'D|%s\n' "$f"
  else
    printf 'F|%s\n' "$f"
  fi
done | head -n {}
"#,
        shell_single_quote(&remote_path),
        MAX_LIST_ENTRIES
    );

    let output = Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host])
        .arg(format!("bash -lc {}", shell_single_quote(&portable)))
        .output()
        .map_err(|e| format!("ssh list: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh list failed: {}", err.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((kind, name)) = line.split_once('|') else {
            continue;
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let is_dir = kind == "D";
        let child_rel = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };
        entries.push(WorkspaceEntry {
            name: name.to_string(),
            path: child_rel,
            is_dir,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()),
    });

    let root_label = root
        .rsplit('/')
        .find(|s| !s.is_empty() && *s != "$HOME")
        .unwrap_or("remote")
        .to_string();

    Ok(WorkspaceListing {
        path: rel,
        entries,
        root_label,
        remote: true,
    })
}

pub fn read_remote(host: &str, root: &str, rel: &str) -> Result<WorkspaceFileContent, String> {
    let rel = normalize_rel(rel)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    let remote_path = if root.contains("$HOME") {
        format!("{root}/{rel}")
    } else {
        format!("{}/{rel}", root.trim_end_matches('/'))
    };

    let portable = format!(
        r#"set -e
target={}
target=$(eval echo "$target")
if [ ! -f "$target" ]; then
  echo "ERR:not a file" >&2
  exit 1
fi
size=$(wc -c < "$target" | tr -d ' ')
printf 'SIZE:%s\n' "$size"
# binary check: null byte in first 8k
if dd if="$target" bs=8192 count=1 2>/dev/null | grep -q $'\0'; then
  printf 'BINARY:1\n'
  exit 0
fi
printf 'BINARY:0\n'
head -c {} "$target"
"#,
        shell_single_quote(&remote_path),
        MAX_READ_BYTES
    );

    let output = Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host])
        .arg(format!("bash -lc {}", shell_single_quote(&portable)))
        .output()
        .map_err(|e| format!("ssh read: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh read failed: {}", err.trim()));
    }

    let stdout = output.stdout;
    // Parse header lines SIZE: and BINARY:
    let mut pos = 0usize;
    let mut size: u64 = 0;
    let mut binary = false;
    for _ in 0..2 {
        let rest = &stdout[pos..];
        let nl = rest
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| "malformed remote file response".to_string())?;
        let line = String::from_utf8_lossy(&rest[..nl]);
        pos += nl + 1;
        if let Some(s) = line.strip_prefix("SIZE:") {
            size = s.trim().parse().unwrap_or(0);
        } else if let Some(s) = line.strip_prefix("BINARY:") {
            binary = s.trim() == "1";
        }
    }

    let name = rel.rsplit('/').next().unwrap_or(&rel);
    let language = language_from_name(name);

    if binary {
        return Ok(WorkspaceFileContent {
            path: rel,
            content: String::new(),
            truncated: false,
            size,
            binary: true,
            language,
        });
    }

    let body = &stdout[pos..];
    let truncated = size > MAX_READ_BYTES;
    if looks_binary(body) {
        return Ok(WorkspaceFileContent {
            path: rel,
            content: String::new(),
            truncated: false,
            size,
            binary: true,
            language,
        });
    }
    let content = String::from_utf8_lossy(body).to_string();
    Ok(WorkspaceFileContent {
        path: rel,
        content,
        truncated,
        size,
        binary: false,
        language,
    })
}

/// Ensure relative path components are safe (used in tests / helpers).
#[allow(dead_code)]
pub fn is_safe_rel(path: &str) -> bool {
    normalize_rel(path).is_ok()
        && !Path::new(path)
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir))
}

// ── Git status ──────────────────────────────────────────────────────────────

/// Normalized file change kind for the tree UI.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitChangeKind {
    Untracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
    /// Matched by .gitignore / exclude (from `git status --ignored`).
    Ignored,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub kind: GitChangeKind,
    /// True if index (staged) side has a change.
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitStatus {
    /// False when not a git work tree / git missing / command failed softly.
    pub is_repo: bool,
    pub files: Vec<GitFileStatus>,
}

fn classify_xy(x: char, y: char) -> Option<(GitChangeKind, bool)> {
    // Unmerged
    if matches!(x, 'U') || matches!(y, 'U') || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        return Some((GitChangeKind::Conflicted, true));
    }
    // Untracked
    if x == '?' && y == '?' {
        return Some((GitChangeKind::Untracked, false));
    }
    // Ignored (requires `git status --ignored`)
    if x == '!' && y == '!' {
        return Some((GitChangeKind::Ignored, false));
    }

    let staged = !matches!(x, ' ' | '?');
    let worktree = !matches!(y, ' ' | '?');

    // Prefer more "attention-grabbing" for display when both staged + unstaged.
    let kind_from = |c: char| -> Option<GitChangeKind> {
        match c {
            'M' => Some(GitChangeKind::Modified),
            'A' => Some(GitChangeKind::Added),
            'D' => Some(GitChangeKind::Deleted),
            'R' | 'C' => Some(GitChangeKind::Renamed),
            'T' => Some(GitChangeKind::Modified),
            _ => None,
        }
    };

    // Worktree changes often what users mean by "changed"; still mark staged.
    if let Some(k) = kind_from(y) {
        return Some((k, staged));
    }
    if let Some(k) = kind_from(x) {
        return Some((k, true));
    }
    if staged || worktree {
        return Some((GitChangeKind::Modified, staged));
    }
    None
}

fn parse_porcelain(stdout: &str) -> Vec<GitFileStatus> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }
        let bytes = line.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        // path starts at index 3 (after "XY ")
        let rest = line[3..].trim();
        if rest.is_empty() {
            continue;
        }
        // rename: "old -> new"
        let path = if let Some((_, new)) = rest.split_once(" -> ") {
            new.trim()
        } else {
            rest
        };
        // quote-wrapped paths from git; strip trailing slash on dirs
        let path = path.trim_matches('"').replace("\\n", "\n");
        let path = path.replace('\\', "/").trim_end_matches('/').to_string();
        if path.is_empty() {
            continue;
        }
        let Some((kind, staged)) = classify_xy(x, y) else {
            continue;
        };
        out.push(GitFileStatus {
            path,
            kind,
            staged,
        });
    }
    out
}

pub fn git_status_local(root: &Path) -> WorkspaceGitStatus {
    let output = Command::new("git")
        .args(["-C"])
        .arg(root)
        .args([
            "status",
            "--porcelain=v1",
            "-uall",
            "--ignored=matching",
            "--ignore-submodules=dirty",
        ])
        .output();

    let Ok(output) = output else {
        return WorkspaceGitStatus {
            is_repo: false,
            files: vec![],
        };
    };

    // Not a git repo → exit 128 typically
    if !output.status.success() {
        return WorkspaceGitStatus {
            is_repo: false,
            files: vec![],
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    WorkspaceGitStatus {
        is_repo: true,
        files: parse_porcelain(&stdout),
    }
}

pub fn git_status_remote(host: &str, root: &str) -> WorkspaceGitStatus {
    let script = format!(
        r#"set -e
target={}
target=$(eval echo "$target")
cd "$target" 2>/dev/null || exit 128
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 128
git status --porcelain=v1 -uall --ignored=matching --ignore-submodules=dirty
"#,
        shell_single_quote(root)
    );

    let output = Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host])
        .arg(format!("bash -lc {}", shell_single_quote(&script)))
        .output();

    let Ok(output) = output else {
        return WorkspaceGitStatus {
            is_repo: false,
            files: vec![],
        };
    };
    if !output.status.success() {
        return WorkspaceGitStatus {
            is_repo: false,
            files: vec![],
        };
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    WorkspaceGitStatus {
        is_repo: true,
        files: parse_porcelain(&stdout),
    }
}
