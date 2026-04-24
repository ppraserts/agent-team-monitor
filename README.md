# Agent Team Monitor

> Multi-agent control center for Claude Code (and other CLI agents).
> Spawn multiple agents that work in parallel and **talk to each other** with `@AgentName`.

![status](https://img.shields.io/badge/status-POC-orange) ![tauri](https://img.shields.io/badge/Tauri-2-24c8db) ![rust](https://img.shields.io/badge/Rust-1.95-orange) ![react](https://img.shields.io/badge/React-19-61dafb)

## What it does

A **Tauri 2** desktop app (Rust backend + React frontend) that wraps the
`claude` CLI and lets you run a **team** of agents at once:

- 🤖 **Multi-agent grid** — spawn N agents (Backend / Frontend / Architect / Reviewer presets), each in its own pane
- 💬 **Inter-agent routing** — when an agent's reply contains `@AgentName <message>` on a new line, the message is forwarded to that agent's stdin (security-gated, see below)
- 📈 **Live usage** — per-agent input/output/cache tokens, cost, turns; aggregated team total
- 🌐 **Activity feed + Graph view** — chronological cross-agent feed with `LIVE` badges, plus a node-edge graph that animates when agents talk
- 📺 **PTY terminal panes** — full Claude TUI fidelity for interactive use, alongside headless agents (uses `portable-pty`, works on Windows ConPTY)
- 🗂 **External session discovery** — lists existing `~/.claude/projects/*.jsonl` sessions
- 🔌 **Vendor-agnostic** — `AgentAdapter` trait already abstracts Claude; Gemini / MiniMax / remote-WebSocket adapters are next

## Screenshots

> _add screenshots here_

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Tauri App                                                       │
│                                                                  │
│  Frontend (React 19 + TS + Tailwind v4 + Zustand + xterm.js)     │
│  ├─ Sidebar           agent / pty / external-session list        │
│  ├─ Tile grid         ChatPanel | TerminalPanel per agent        │
│  ├─ TeamFeed          live cross-agent activity                  │
│  ├─ AgentGraph        node-edge view, animated mention edges     │
│  └─ SpawnDialog       presets + per-agent security toggles       │
│                                                                  │
│  Backend (Rust 1.95)                                             │
│  ├─ adapter.rs        AgentAdapter trait + ClaudeStreamJson      │
│  ├─ manager.rs        spawn / send / kill / mention router       │
│  │                    single-owner-of-Child via oneshot kill_tx  │
│  ├─ pty.rs            portable-pty + ChildKiller (ConPTY-safe)   │
│  ├─ sessions.rs       walk ~/.claude/projects/*.jsonl            │
│  └─ lib.rs            Tauri commands + event channels            │
└──────────────────────────────────────────────────────────────────┘
```

## How agents talk to each other

1. Each agent is spawned with a system prompt that says
   _"address your teammates with `@AgentName <message>` on a new line"_.
2. The Rust `AgentManager` parses `claude --output-format stream-json`
   events from each agent's stdout.
3. When an `assistant` text contains `@AgentName ...`, the manager:
   - Checks `allow_mentions` on the source agent (per-agent opt-in).
   - Checks `mention_allowlist` (if non-empty, target name must be listed).
   - Resolves `AgentName → id`, then writes a new `user` message to the
     target agent's stdin.
   - Emits `Mention { from_id, to_id, to_name, message }` so the UI can
     animate the edge in the graph and add a row to the activity feed.
4. Blocked mentions emit `MentionBlocked { reason }` so the UI can show
   the attempt without forwarding.

## Security model

| Per-agent toggle              | Default | What it does |
|--------------------------------|--------|--------------|
| `allow_mentions`              | `true` | Required for this agent's `@mentions` to be routed |
| `mention_allowlist: string[]` | `[]`   | If non-empty, target name must be listed |
| `skip_permissions`            | `false`| Pass `--dangerously-skip-permissions` to the CLI |

**Why this matters:** A prompt-injected agent could try to write
`@OtherAgent rm -rf /`. With `allow_mentions=false` (or `OtherAgent`
not on the allowlist), the message is blocked. With
`skip_permissions=false`, even forwarded messages still hit Claude's
normal tool-permission prompts.

## Running locally

**Prerequisites:**
- Rust 1.88+ (`rustup update stable`)
- Node 20+ + Bun 1.2+ (or pnpm/npm)
- `claude` CLI on `PATH` (or `CLAUDE_BIN` env var)
- Windows: WebView2 (preinstalled on Win11)

```bash
git clone https://github.com/ppraserts/agent-team-monitor.git
cd agent-team-monitor
bun install
bun run tauri dev
```

**Build a standalone `.exe`:**

```bash
bun run tauri build
# → src-tauri/target/release/bundle/{nsis,msi}/...
```

## Roadmap

- [x] v1: Claude stream-json + PTY mode + mention routing + security gates
- [ ] v2: Gemini CLI adapter (proves the trait)
- [ ] v2: Remote agents over WebSocket (cross-machine teams)
- [ ] v2: Per-agent cost limits / circuit breakers
- [ ] v3: MiniMax / OpenAI HTTP adapters
- [ ] v3: NAT-traversal relay for inter-machine teams

## License

MIT
