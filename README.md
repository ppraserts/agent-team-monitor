# Agent Team Monitor

Multi-agent control center for Claude Code and other CLI agents.

Spawn multiple agents that work in parallel, route messages between them with
`@AgentName`, track usage, and keep each agent in its own chat or terminal pane.

Status: POC
Stack: Tauri 2, Rust, React 19, Vite, Tailwind CSS, Zustand

## What It Does

Agent Team Monitor is a Windows-friendly Tauri desktop app with a Rust backend
and React frontend. It wraps CLI agents, starting with the `claude` CLI, and
lets you run a team of agents at the same time.

- Multi-agent grid: spawn multiple role-based agents such as PM, Architect,
  Backend, Frontend, QA, Reviewer, and Writer.
- Inter-agent routing: an assistant reply that contains a new line like
  `@AgentName message` can be forwarded to that agent.
- Security gates: per-agent controls for mention routing, mention allowlists,
  and permission skipping.
- Live usage: per-agent token and cost accounting, plus team totals.
- Activity feed and graph view: inspect cross-agent events and routed mentions.
- PTY panes: run interactive terminal sessions beside headless agents.
- External session discovery: list existing Claude sessions under
  `%USERPROFILE%\.claude\projects`.
- Local persistence: SQLite stores agent history, messages, usage, settings,
  presets, and boards.
- Boards: Trello-style task boards can assign work to agents.

## Architecture

```text
Tauri desktop app

Frontend: React 19 + TypeScript + Tailwind CSS + Zustand + xterm.js
  - Sidebar: active agents, PTYs, history, settings
  - Tile grid: ChatPanel or TerminalPanel per agent
  - TeamFeed: live cross-agent activity
  - AgentGraph: mention graph with animated edges
  - UsagePanel: token and cost summaries
  - BoardsPanel: local task boards and cards
  - SpawnDialog: presets, vendor selection, security toggles

Backend: Rust
  - adapter.rs: AgentAdapter trait and Claude stream-json adapter
  - manager.rs: spawn, send, kill, event parsing, mention router
  - pty.rs: portable-pty integration, Windows ConPTY-safe
  - db.rs: SQLite persistence and migrations
  - boards.rs: board, column, and card queries
  - sessions.rs: Claude session discovery
  - skills.rs: local skill and slash-command files
  - lib.rs: Tauri commands and event channels
```

## Windows Requirements

Install these first:

- Windows 10/11 with WebView2 Runtime
- Rust stable, installed through `rustup`
- Node.js 20+
- Bun 1.2+ is recommended, but npm also works
- Claude CLI available on `PATH`, or set `CLAUDE_BIN`

Recommended PowerShell setup:

```powershell
rustup update stable
node --version
npm.cmd --version
bun --version
claude --version
```

If PowerShell blocks `npm.ps1` or another package-manager shim with an
execution-policy error, call the `.cmd` or `.exe` shim directly:

```powershell
npm.cmd --version
bun.exe --version
```

Or allow local user scripts:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If PowerShell displays Unicode text incorrectly, use UTF-8 output for that
session:

```powershell
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
```

## Run Locally On Windows

From PowerShell:

```powershell
cd C:\devs\pocs\agent-team-monitor
bun install
bun run tauri dev
```

Without Bun:

```powershell
cd C:\devs\pocs\agent-team-monitor
npm.cmd install
npm.cmd run tauri dev
```

The Vite dev server runs on `http://localhost:1420`. Tauri starts the desktop
window and uses that dev server automatically.

If `claude` is installed but not detected, set the full path before launching:

```powershell
$env:CLAUDE_BIN = "C:\Users\<you>\AppData\Roaming\npm\claude.cmd"
bun run tauri dev
```

## Build A Windows Installer

```powershell
bun run tauri build
```

Without Bun:

```powershell
npm.cmd run tauri build
```

Build outputs are created under:

```text
src-tauri\target\release\bundle\
```

Depending on installed Tauri bundler support, this can include NSIS and MSI
packages.

## How Agent Mentions Work

1. Each spawned agent gets a roster note with the active team names.
2. The backend reads `claude --output-format stream-json` events.
3. When an assistant message contains `@AgentName message` on a new line, the
   backend checks the source agent's mention policy.
4. If allowed, the message is forwarded to the target agent's stdin.
5. The frontend receives a `mention` event, updates the feed, and animates the
   graph edge.
6. Blocked attempts emit `mention_blocked` so the UI can surface or log them.

## Security Model

| Setting | Default | Meaning |
| --- | --- | --- |
| `allow_mentions` | `false` in Rust defaults, enabled in the spawn UI by default | Allows this source agent to route `@AgentName` messages |
| `mention_allowlist` | `[]` | Empty means any target is allowed when mentions are enabled |
| `skip_permissions` | `false` | Passes `--dangerously-skip-permissions` to the CLI |

The proposal workflow in the UI can intentionally enable
`--dangerously-skip-permissions` because the in-chat approval card becomes the
permission gate. Use that only for trusted local automation.

## Useful Commands

```powershell
bun run dev          # frontend only
bun run build        # TypeScript + Vite production build
bun run tauri dev    # full desktop dev app
bun run tauri build  # desktop production build
```

Rust-only checks:

```powershell
cd src-tauri
cargo check
```

## Roadmap

- v1: Claude stream-json adapter, PTY mode, mention routing, security gates
- v2: Gemini CLI adapter
- v2: Remote agents over WebSocket
- v2: Per-agent cost limits and circuit breakers
- v3: MiniMax and OpenAI HTTP adapters
- v3: NAT traversal relay for cross-machine teams

## License

MIT
