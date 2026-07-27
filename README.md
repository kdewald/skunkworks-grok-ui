# Skunkworks Grok UI

Unofficial desktop shell for ACP-compatible coding agents. Grok, Codex, and
Claude can share the same projects and UI while each chat keeps its chosen
backend.

Project-scoped chats, collapsible agent work, attachments, and permission prompts, without living only in the terminal TUI.

**Stack:** Tauri 2, React, TypeScript, and [ACP](https://agentclientprotocol.com).

## Features

- **Projects + chats**: many workspaces; many chats per folder
- **Scratch chats**: no project required; isolated dirs under `~/.grok-ui/scratch/<chat-id>/`
- **Project terminal**: interactive shell in the project folder (SSH for remote projects)
- **Files view**: project file tree + read-only viewer; pin files, folders, or line ranges as chat context
- **Collapsible Work**: thoughts, tools, plans
- **Attachments**: images and text/code (not PDF, Office, or zip as embeds)
- **Permissions**: approve or deny tool runs
- **Session continuity**: ACP load when possible; local history rehydrate if not

## Prerequisites

- Node.js **20.19+** or **22.12+** (Vite requirement)
- Rust (stable)
- macOS, Linux, or Windows (Tauri 2 platform deps)

Install and sign in with at least one supported CLI. The UI reuses that CLI's
existing credentials:

| Backend | Runtime requirement |
|---------|---------------------|
| Grok | [Grok Build CLI](https://docs.x.ai/build/overview), with `grok` on `PATH` or `GROK_PATH` set |
| Codex | Codex CLI plus `npm install --global @agentclientprotocol/codex-acp@1.1.4` |
| Claude | Node.js 22+, Claude Code, and `npm install --global @agentclientprotocol/claude-agent-acp@0.59.0` |

The ACP adapters are pinned intentionally. The app does not run `npx` or install
software at runtime.

## Build and run

```bash
git clone git@github.com:kdewald/skunkworks-grok-ui.git
cd skunkworks-grok-ui
npm install
npm run tauri:dev      # development with hot reload
```

### Remote SSH

The desktop window can drive any supported backend over SSH so tools and
project files run on another machine.

1. Passwordless SSH to the host (`Host` in `~/.ssh/config`, key auth, `BatchMode` OK).
2. Install the selected CLI and its ACP adapter, if needed, **on the remote host**.
3. Sign in with that CLI **on the remote host**. Grok requires a valid cached token; Codex and Claude reuse their existing CLI credentials.
4. In the app: **Connections** (server icon) → pick a host from SSH config or enter `user@host` → **Add & connect**.
5. Switch the **Environment** and **Backend** selectors, open a remote project path, and chat as usual.

Chat transcripts stay in the local app data dir; the agent process and `cwd` are remote.

### Install as a macOS app (recommended for daily use)

`cargo install` is **not** recommended: it often ships without embedded UI assets and opens a blank white window.

```bash
npm run tauri:build
# App:   src-tauri/target/release/bundle/macos/Skunkworks Grok UI.app
# DMG:   src-tauri/target/release/bundle/dmg/Skunkworks Grok UI_0.7.0_*.dmg
```

Copy the `.app` into `/Applications` or `~/Applications`, then open it from Spotlight or Finder (no terminal required). After UI or backend changes you care about in that install:

```bash
npm run tauri:build
cp -R "src-tauri/target/release/bundle/macos/Skunkworks Grok UI.app" ~/Applications/
```

Prebuilt binaries, app stores, and auto-update are not provided yet.

## Usage

1. Pick **Scratch** or open a project folder.
2. Pick a backend, start a new chat, and send a message.
3. Use the composer **+** menu to attach images or text/code.
4. Expand **Work** for tools and thoughts; collapse when done.
5. Answer permission prompts as needed.
6. Switch **Chat | Files** in the header to browse the project. Add files, folders, or line selections to the composer as context chips.
7. Open the **terminal** from the header icon. Use **+** in the terminal tab bar for additional shells.

| Env | Purpose |
|-----|---------|
| `GROK_PATH` | Path to local `grok` if not on `PATH` |
| `CODEX_ACP_PATH` | Path to local `codex-acp` if not on `PATH` |
| `CLAUDE_ACP_PATH` | Path to local `claude-agent-acp` if not on `PATH` |

Remote hosts may set an optional absolute remote `grok` path in Connections if it is not on the remote login-shell `PATH`.

| Data | Where |
|------|--------|
| Transcripts / index | e.g. macOS `~/Library/Application Support/grok-ui/` |
| Scratch working dirs | `~/.grok-ui/scratch/<chat-id>/` |
| Authentication | Managed by each official CLI |

## Architecture

```
React UI -> Tauri (Rust store + ACP client)
              ├─ Grok:   grok agent --no-leader stdio
              ├─ Codex:  codex-acp
              └─ Claude: claude-agent-acp

Each process can run locally or behind `ssh host -- bash -lc '…'`.
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run tauri:dev` | Desktop + hot reload |
| `npm run tauri:build` | Release bundle |
| `npm run build` | Frontend only |

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

```
Copyright 2026 kdewald
```

## Disclaimer

This is an independent open-source project. It is **not affiliated with, endorsed by, or sponsored by xAI, SpaceX, SpaceXAI, X Corp., or any related entity**. "Grok", "Grok Build", "xAI", and similar names are trademarks of their respective owners and are used only to describe compatible software.
