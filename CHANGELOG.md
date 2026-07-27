# Changelog

## [0.7.0] — 2026-07-27

### Added

- Interchangeable Grok, Codex, and Claude ACP backends, persisted per chat
- Local and SSH agent runtimes scoped independently by environment and backend
- New-chat Provider, Model, and Access selectors populated from each agent's
  advertised ACP capabilities
- Codex and Claude ACP adapter discovery using credentials from the existing
  CLI login

### Changed

- Provider, model, and access settings lock after the first message and remain
  visible in the chat header
- Switching providers automatically connects the matching CLI and replaces an
  unused draft so messages cannot route to the previous backend
- New sessions default to Full Access: Grok `--always-approve`, Codex
  `agent-full-access`, and Claude `bypassPermissions`
- ACP adapter requirements are pinned and documented; the app never installs
  software at runtime

### Fixed

- Recreated ACP sessions restore the chat's selected model and access mode
- Session streams, permissions, connection state, and cancellation are routed
  by both environment and backend to prevent cross-provider state leaks
- Thought and message timelines preserve whitespace-only chunks and embedded
  newlines exactly

### Packaging

- Version bump to 0.7.0

## [0.6.2] — 2026-07-26

### Fixed

- ACP stream assembly matches Grok Build TUI: pure text concat (no space-glue heuristics)
- `agent_thought_chunk` / `agent_message_chunk` kinds are trusted (no content-based re-routing of thoughts into messages)
- Words like `minion` no longer split mid-stream (`min ion`)

### Changed

- Thinking UI: **Thinking…** while live, **Thought** when sealed; muted markdown body
- Thought collapses after a later message/work seals it (TUI-style finish thinking)

### Packaging

- Version bump to 0.6.2

## [0.6.1] — 2026-07-25

### Changed

- Modularization: pure ACP transcript reducer (`chat::transcript`), session/history helpers (`chat::session`)
- SSH utilities extracted from ACP connection code (`ssh.rs`)
- Thin Tauri command modules for terminal, workspace FS, and LSP
- Frontend state modules: turn lifecycle reducers, stream apply drain, send-slot helpers
- Files open/save generation guards against stale async results

### Added

- Vitest unit tests for pure frontend state modules (`npm test`)
- Expanded Rust unit tests for transcript apply and session rehydrate helpers

### Packaging

- Version bump to 0.6.1

## [0.6.0] — 2026-07-25

### Added

- Files viewer uses **Monaco** as the sole editor (CodeMirror removed)
- Files viewer: edit + save text files (⌘S / Ctrl+S; local and SSH workspaces)
- **LSP bridge** for local workspaces (stdio language servers):
  - TypeScript/JavaScript → `typescript-language-server`
  - Python → `pyright-langserver` / `basedpyright` / `pylsp`
  - Rust → `rust-analyzer` (prefers `rustup which`; detects dead rustup proxies)
  - C/C++ → `clangd`
  - Completions, hover, go-to-definition, diagnostics (when servers are installed)
  - Status chip in the file bar when an LSP attaches
- Files editor **autosave** (~900ms after you stop typing); Save button still available
- Monaco context menu actions: **Add Selection to Chat** / **Add File to Chat** (alongside Go to Definition)

### Fixed

- Go-to-definition / hover / completions when Monaco model URIs were workspace-relative while LSP used absolute `file://` paths
- Append-to-chat from the editor: custom overlay was hidden under Monaco’s context menu; actions now live in Monaco’s menu
- Selection context chips use the live draft buffer, not a stale disk snapshot

### Packaging

- Version bump to 0.6.0

## [0.5.4] — 2026-07-25

### Fixed

- Thinking stream no longer glues bare ACP tokens without spaces (`change`+`I` → `changeI`, `fontsGot it`)
- Status-like monologue markers (`Got it`, `I found …`) split out of Thinking into the assistant message stream
- Mid-answer thought chunks fold into the open message bubble
- Thinking collapses when a turn finishes so replies stay primary
- Timeline no longer reorders message↔thought runs

### Added

- Live ACP integration tests against `grok agent stdio` (`GROK_ACP_LIVE=1`)
- Unit tests for thought/message stream assembly

### Packaging

- Version bump to 0.5.4

## [0.5.3] — 2026-07-24

### Added

- KaTeX rendering for LaTeX in assistant / subagent markdown (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`)

### Fixed

- Backend prompt registry: one in-flight `send_message` per chat (turn append under write lock)
- Stop + queued follow-up: keep send slot until turn settles; cancel hard-kill after timeout (no synthetic cancel success)
- Stop no longer poisons `cancelling_sessions` when the turn already finished (30s send lock)
- Global FIFO message queue; disconnect/cancel-kill flushes; retriable queue head + idle flush kick
- `ensure_chat_session` / `selectChat` only patch session meta; ensure single-flight + CAS
- Connect single-flight per environment; ACP `shutdown()` kills child; dead connections replaced
- Stream apply requires matching `sessionId`; late subagent/task/tool/thought updates after complete
- Shell-only MultiResult no longer swallows normal tool output
- Thought chunks append as ACP deltas (no ends_with heuristic)
- Live-cache disk mutations; delete/remove project/env refuse inflight and clear queue for deleted chats
- Edit-resend waits for inflight release; does not hijack another chat’s send slot
- Finalizer never overwrites a cancelled turn with complete
- `sync_meta` failure no longer leaves a permanent inflight claim
- Disconnect handling scoped to the environment that owns the inflight chat
- LaTeX normalize protects inline code and fences
- Tool work strip more compact (collapsed “Work N tools” by default; denser rows)

### Packaging

- Version bump to 0.5.3

## [0.5.1] — 2026-07-24

### Added

- Edit & resend a previous user message (rolls back that turn and everything after; fresh ACP session with rehydrated history)
- Subagents panel toggle in the workspace header (badge with count; button only when subagents exist)
- Codex-style message queue while a turn is running (Stop to interrupt; queue drains after)

### Fixed

- Subagent tool calls and fanned-in child responses no longer leak into the main chat transcript
- Shell MultiResult rows (e.g. `cd … && scripts/…`) no longer appear as subagent cards
- Auto-recover from stale ACP sessions (`unknown session id`) by recreating the session, re-seeding history, and retrying once
- User messages no longer vanish after send (session ensure no longer overwrites the live chat with a stale disk snapshot)
- Stop overwriting the open chat when a background send finishes; stop applying stream updates to the wrong chat
- Queue drains correctly across chat switches; inflight/busy claimed before connect
- Mid-turn session recreate marks session loaded and updates frontend meta
- Cancel updates the live chat document immediately
- Parent tools remain visible while subagents are running
- Stop truncating model replies (accept parent message chunks while subagents run; accept late chunks after turn complete)
- Stop stays visible while editing a prior message

### Packaging

- Version bump to 0.5.1

## [0.5.0] — 2026-07-22

### Added

- Git status colors in the Files tree (`new` / `mod` / `add` / `del` / `ign`)
- CodeMirror 6 syntax highlighting with extensible language registry
- Open external links in the system browser (markdown, terminal, global click safety net)
- Webview navigation guard so external sites cannot replace the app UI

### Fixed

- Clicking agent links no longer navigates the entire Tauri window (no back button)
- Composer Send/Enter stuck after a lost `prompt-finished` (e.g. after webview hijack)
- Draft text restored when send fails
- Startup auto-selected chat now syncs sidebar project, environment, and Files tree
- Active chat revealed in the sidebar (expand project / show more when needed)
- `set_active_chat` persists matching `active_project_id` and environment

### Packaging

- Version bump to 0.5.0

## [0.4.0] — 2026-07-21

### Added

- **Files** workspace mode (Chat | Files): project file tree, read-only viewer
- Context chips for files, folders, and line ranges (toolbar + right-click)
- Sandboxed local/SSH workspace FS (`list_workspace_dir`, `read_workspace_file`)

### Fixed

- Project name click toggles expand/collapse when already selected

### Packaging

- Version bump to 0.4.0

## [0.3.1] — 2026-07-21

### Fixed

- Terminal tabs are project-bound: switching projects no longer carries another project's shells

### Packaging

- Version bump to 0.3.1

## [0.3.0] — 2026-07-21

### Added

- Project terminal panel with multi-tab interactive shells (local PTY; SSH for remote projects)
- Codex-style project tree: chats nested under each project, collapsible groups
- Terminal toggle in the chat header (top-right); open additional shells with **+**

### Fixed

- Opening or switching projects left the previous project's chat on screen
- Terminal panel UI opened without starting a usable shell

### Packaging

- Version bump to 0.3.0

## [0.2.0] — 2026-07-14

### Added

- Remote SSH environments (Codex-style multi-host agent connections)
- Subagent side panel for parallel workers (Task-variant spawn + MultiResult reports)
- Message queue for follow-ups while a turn is running
- Remote folder browser for SSH project paths
- Batched `apply_session_updates` path for stream apply performance

### Fixed

- UI drip after stream finished (per-token IPC backlog)
- Stop/cancel stuck busy; permissions cleared on cancel
- Chat selection stolen by background refresh
- Empty new chats no longer saved
- Agent disconnect leaves turns streaming forever
- Subagent output interleaved into parent transcript
- Compact tools / distinct thinking layout polish

### Packaging

- Version bump to 0.2.0

## [0.1.0] — 2026-07-14

### Added

- Desktop shell over `grok agent stdio` (ACP)
- Multi-project and multi-chat sidebar
- Scratch workspace (`~/.grok-ui/scratch/<chat-id>/`)
- Streaming transcript with collapsible Work
- Attachments: images + text/code
- Permission prompts
- Session load / recreate + local history seed
- Warm dark UI, Lucide icons

### Packaging

- Repo: [kdewald/skunkworks-grok-ui](https://github.com/kdewald/skunkworks-grok-ui)
- Bundle id: `dev.kdewald.skunkworks.grokui`
- License: Apache-2.0
- Unofficial; not affiliated with xAI / SpaceX / SpaceXAI / X Corp.

[0.7.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.7.0
[0.4.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.4.0
[0.3.1]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.3.1
[0.3.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.3.0
[0.2.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.2.0
[0.1.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.1.0
