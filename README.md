# Skunkworks Grok UI

Unofficial desktop shell for the [Grok Build](https://docs.x.ai/build/overview) coding agent.

Project-scoped chats, collapsible agent work, attachments, and permission prompts, without living only in the terminal TUI.

**Stack:** Tauri 2, React, TypeScript, local `grok` over [ACP](https://agentclientprotocol.com) (`grok agent stdio`).

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
- [Grok Build CLI](https://docs.x.ai/build/overview) installed and authenticated (`grok` on `PATH`, or `GROK_PATH`)
- macOS, Linux, or Windows (Tauri 2 platform deps)

## Build and run

```bash
git clone git@github.com:kdewald/skunkworks-grok-ui.git
cd skunkworks-grok-ui
npm install
npm run tauri:dev      # development with hot reload
```

### Remote SSH (Codex-style)

The desktop window can drive a **remote** `grok agent stdio` over SSH so tools and project files run on another machine.

1. Passwordless SSH to the host (`Host` in `~/.ssh/config`, key auth, `BatchMode` OK).
2. Install a current [Grok Build CLI](https://docs.x.ai/build/overview) **on the remote host** (`grok` on the login-shell `PATH`, e.g. `~/.local/bin`).
3. Sign in **on the remote host** so `~/.grok/auth.json` has a valid cached token (`grok` once interactively, or copy a fresh auth file). Expired tokens only offer browser login, which this UI cannot complete over SSH.
4. In the app: **Connections** (server icon) → pick a host from SSH config or enter `user@host` → **Add & connect**.
5. Switch the **Environment** dropdown, open a remote project path, and chat as usual.

Chat transcripts stay in the local app data dir; the agent process and `cwd` are remote.

### Install as a macOS app (recommended for daily use)

`cargo install` is **not** recommended: it often ships without embedded UI assets and opens a blank white window.

```bash
npm run tauri:build
# App:   src-tauri/target/release/bundle/macos/Skunkworks Grok UI.app
# DMG:   src-tauri/target/release/bundle/dmg/Skunkworks Grok UI_0.4.0_*.dmg
```

Copy the `.app` into `/Applications` or `~/Applications`, then open it from Spotlight or Finder (no terminal required). After UI or backend changes you care about in that install:

```bash
npm run tauri:build
cp -R "src-tauri/target/release/bundle/macos/Skunkworks Grok UI.app" ~/Applications/
```

Prebuilt binaries, app stores, and auto-update are not provided yet.

## Usage

1. Pick **Scratch** or open a project folder.
2. Start a new chat and message Grok.
3. Use the composer **+** menu to attach images or text/code.
4. Expand **Work** for tools and thoughts; collapse when done.
5. Answer permission prompts as needed.
6. Switch **Chat | Files** in the header to browse the project. Add files, folders, or line selections to the composer as context chips.
7. Open the **terminal** from the header icon. Use **+** in the terminal tab bar for additional shells.

| Env | Purpose |
|-----|---------|
| `GROK_PATH` | Path to local `grok` if not on `PATH` |

Remote hosts may set an optional absolute remote `grok` path in Connections if it is not on the remote login-shell `PATH`.

| Data | Where |
|------|--------|
| Transcripts / index | e.g. macOS `~/Library/Application Support/grok-ui/` |
| Scratch working dirs | `~/.grok-ui/scratch/<chat-id>/` |
| Grok auth | Official CLI (`~/.grok/`) |

## Architecture

```
React UI -> Tauri (Rust store + ACP client)
              ├─ local:  grok agent --no-leader stdio
              └─ remote: ssh host -- bash -lc 'grok agent --no-leader stdio'
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
