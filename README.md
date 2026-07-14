# Skunkworks Grok UI

Unofficial desktop shell for the [Grok Build](https://docs.x.ai/build/overview) coding agent.

Project-scoped chats, collapsible agent work, attachments, and permission prompts, without living only in the terminal TUI.

**Stack:** Tauri 2, React, TypeScript, local `grok` over [ACP](https://agentclientprotocol.com) (`grok agent stdio`).

## Features

- **Projects + chats**: many workspaces; many chats per folder
- **Scratch chats**: no project required; isolated dirs under `~/.grok-ui/scratch/<chat-id>/`
- **Collapsible Work**: thoughts, tools, plans
- **Attachments**: images and text/code (not PDF, Office, or zip as embeds)
- **Permissions**: approve or deny tool runs
- **Session continuity**: ACP load when possible; local history rehydrate if not

## Prerequisites

- Node.js **20.19+** or **22.12+** (Vite requirement)
- Rust (stable)
- [Grok Build CLI](https://docs.x.ai/build/overview) installed and authenticated (`grok` on `PATH`, or `GROK_PATH`)
- macOS, Linux, or Windows (Tauri 2 platform deps)

## Build and run (local only)

```bash
git clone git@github.com:kdewald/skunkworks-grok-ui.git
cd skunkworks-grok-ui
npm install
npm run tauri:dev      # development
# or
npm run tauri:build    # release bundle under src-tauri/target/release/bundle/
```

Cargo-oriented (after UI build):

```bash
npm install && npm run build
cargo install --path src-tauri
```

Prebuilt binaries, app stores, and auto-update are not provided yet.

## Usage

1. Pick **Scratch** or open a project folder.
2. Start a new chat and message Grok.
3. Use the composer **+** menu to attach images or text/code.
4. Expand **Work** for tools and thoughts; collapse when done.
5. Answer permission prompts as needed.

| Env | Purpose |
|-----|---------|
| `GROK_PATH` | Path to `grok` if not on `PATH` |

| Data | Where |
|------|--------|
| Transcripts / index | e.g. macOS `~/Library/Application Support/grok-ui/` |
| Scratch working dirs | `~/.grok-ui/scratch/<chat-id>/` |
| Grok auth | Official CLI (`~/.grok/`) |

## Architecture

```
React UI -> Tauri (Rust store + ACP client) -> grok agent stdio
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
