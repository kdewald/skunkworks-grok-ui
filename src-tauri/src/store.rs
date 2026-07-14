//! Local persistence for projects and chats.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Stable id for the built-in no-project workspace.
pub const SCRATCH_PROJECT_ID: &str = "scratch";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Built-in temp workspace (no real project folder).
    #[serde(default)]
    pub is_scratch: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub acp_session_id: Option<String>,
    pub preview: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: Option<String>,
    pub status: Option<String>,
}

// NOTE: serde `rename_all` on an enum renames *variant names*, not fields.
// Field renames must be explicit (or the frontend sees snake_case).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum IntermediateBlock {
    #[serde(rename = "thought")]
    Thought {
        id: String,
        text: String,
        #[serde(default = "default_true")]
        collapsed: bool,
    },
    #[serde(rename = "tool")]
    Tool {
        id: String,
        #[serde(rename = "toolCallId", alias = "tool_call_id")]
        tool_call_id: String,
        title: String,
        kind: Option<String>,
        status: String,
        #[serde(default, rename = "rawInput", alias = "raw_input")]
        raw_input: Option<serde_json::Value>,
        #[serde(default)]
        content: Option<serde_json::Value>,
        #[serde(default, rename = "rawOutput", alias = "raw_output")]
        raw_output: Option<serde_json::Value>,
        #[serde(default = "default_true")]
        collapsed: bool,
    },
    #[serde(rename = "plan")]
    Plan {
        id: String,
        entries: Vec<PlanEntry>,
        #[serde(default = "default_true")]
        collapsed: bool,
    },
}

fn default_true() -> bool {
    true
}

/// Files attached to a user turn. Only kinds the agent can process via ACP.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAttachment {
    pub id: String,
    pub name: String,
    /// "image" | "text" — default image for older saved chats.
    #[serde(default = "default_image_kind")]
    pub kind: String,
    #[serde(rename = "mimeType", alias = "mime_type")]
    pub mime_type: String,
    /// Path relative to app data dir, e.g. `attachments/<chat>/<id>.png`
    pub path: String,
    /// Optional data URL for image previews in the UI.
    #[serde(default, rename = "dataUrl", alias = "data_url")]
    pub data_url: Option<String>,
    /// Byte size on disk (for UI).
    #[serde(default)]
    pub size: u64,
}

fn default_image_kind() -> String {
    "image".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub user_message: String,
    #[serde(default)]
    pub intermediate: Vec<IntermediateBlock>,
    #[serde(default)]
    pub assistant_message: String,
    pub status: String, // streaming | complete | error | cancelled
    /// When true, the whole intermediate work section is collapsed.
    #[serde(default = "default_true")]
    pub intermediate_collapsed: bool,
    #[serde(default)]
    pub attachments: Vec<FileAttachment>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDocument {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub turns: Vec<Turn>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub projects: Vec<Project>,
    pub chats: Vec<ChatMeta>,
    pub active_project_id: Option<String>,
    pub active_chat_id: Option<String>,
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn open() -> Result<Self> {
        let root = dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("grok-ui");
        fs::create_dir_all(root.join("chats"))
            .with_context(|| format!("create data dir {}", root.display()))?;
        Ok(Self { root })
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn chat_path(&self, chat_id: &str) -> PathBuf {
        self.root.join("chats").join(format!("{chat_id}.json"))
    }

    pub fn load_index(&self) -> Result<AppData> {
        let path = self.index_path();
        if !path.exists() {
            return Ok(AppData::default());
        }
        let raw = fs::read_to_string(&path)?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_index(&self, data: &AppData) -> Result<()> {
        let raw = serde_json::to_string_pretty(data)?;
        fs::write(self.index_path(), raw)?;
        Ok(())
    }

    pub fn load_chat(&self, chat_id: &str) -> Result<ChatDocument> {
        let path = self.chat_path(chat_id);
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("read chat {}", path.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_chat(&self, chat: &ChatDocument) -> Result<()> {
        let raw = serde_json::to_string_pretty(chat)?;
        fs::write(self.chat_path(&chat.id), raw)?;
        Ok(())
    }

    pub fn delete_chat_file(&self, chat_id: &str) -> Result<()> {
        let path = self.chat_path(chat_id);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn data_dir(&self) -> &Path {
        &self.root
    }
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now() -> DateTime<Utc> {
    Utc::now()
}

pub fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// Hidden root for no-project chats: `~/.grok-ui/scratch/`.
/// Each chat gets its own subdirectory so concurrent scratch chats don't collide.
pub fn scratch_root_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grok-ui")
        .join("scratch")
}

/// Parent folder shown in the UI / project index (not a shared agent cwd).
pub fn ensure_scratch_root() -> Result<PathBuf> {
    let path = scratch_root_path();
    fs::create_dir_all(&path)
        .with_context(|| format!("create scratch root {}", path.display()))?;
    let readme = path.join("README.txt");
    if !readme.exists() {
        let _ = fs::write(
            &readme,
            "Grok UI scratch workspaces\n\n\
             Each chat without a project gets its own subdirectory here:\n\
               ~/.grok-ui/scratch/<chat-id>/\n\n\
             That keeps concurrent chats isolated. Safe to delete folders you no longer need.\n",
        );
    }
    Ok(fs::canonicalize(&path).unwrap_or(path))
}

/// Per-chat agent working directory under the scratch root.
pub fn ensure_scratch_chat_dir(chat_id: &str) -> Result<PathBuf> {
    let root = ensure_scratch_root()?;
    // Sanitize: chat ids are UUIDs; still refuse path separators.
    if chat_id.is_empty() || chat_id.contains('/') || chat_id.contains('\\') || chat_id.contains("..")
    {
        anyhow::bail!("invalid scratch chat id");
    }
    let path = root.join(chat_id);
    fs::create_dir_all(&path)
        .with_context(|| format!("create scratch chat dir {}", path.display()))?;
    Ok(fs::canonicalize(&path).unwrap_or(path))
}

pub fn remove_scratch_chat_dir(chat_id: &str) {
    if chat_id.is_empty() || chat_id.contains("..") {
        return;
    }
    let path = scratch_root_path().join(chat_id);
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    }
}

/// Resolve the ACP session cwd for a project (+ chat when scratch).
pub fn resolve_session_cwd(project: &Project, chat_id: &str) -> Result<String> {
    if project.is_scratch || project.id == SCRATCH_PROJECT_ID {
        let path = ensure_scratch_chat_dir(chat_id)?;
        Ok(path.to_string_lossy().to_string())
    } else {
        Ok(project.path.clone())
    }
}
