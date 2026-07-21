# Changelog

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

[0.3.1]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.3.1
[0.3.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.3.0
[0.2.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.2.0
[0.1.0]: https://github.com/kdewald/skunkworks-grok-ui/releases/tag/v0.1.0
