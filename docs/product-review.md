# Product Review: Agent Team Monitor

Date: 2026-05-01

## Product Positioning

Agent Team Monitor is strongest when framed as a desktop control center for running multiple CLI coding agents as a coordinated team. The core value is not "another chat UI"; it is process orchestration, live observability, task routing, and guardrails around local agent work.

The current product already has a useful foundation:

- Multi-agent panes with live chat and status.
- PTY terminal panes for interactive CLI sessions.
- Agent-to-agent routing through `@AgentName`.
- Usage and cost visibility from local Claude data.
- Trello-style boards with workflow rules and assignee handoff.
- Approval proposal cards for risky agent actions.
- Local persistence for messages, usage, settings, presets, and boards.
- Workspace tools, git status, file tree, and external editor entry points.

The main opportunity is to make the product feel less like a collection of powerful panes and more like an operating system for agent work: clear workflow state, reliable guardrails, review checkpoints, and searchable memory.

## Recommended Priorities

### P0: Make The Core Loop Trustworthy

These are the improvements most likely to make users comfortable running real work through the app.

1. Add a first-run readiness checklist.

   Show whether `claude`, Node/npm/Bun, git, editor tools, Nerd Font, and the app database are detected. Link each failure to a concrete fix. The app currently discovers vendors and tools, but the user has to infer setup problems from runtime behavior.

2. Add explicit agent run logs.

   Keep a per-agent technical log that includes spawn command metadata, stderr, exit code, resume/session id, routing decisions, blocked mentions, and DB write failures. This should be separate from chat, so user-facing conversation stays clean.

3. Add a "review before done" workflow.

   Boards already support columns and rules. Add a built-in lane pattern such as Backlog -> Doing -> Review -> Done, with a Reviewer/QA handoff when a card enters Review. This turns multi-agent work into a controlled workflow instead of ad hoc chatting.

4. Make approval state durable.

   Proposal decisions currently live in frontend memory. Persist proposal blocks, approval/denial decisions, timestamp, approving user, and affected commands/files. This matters for auditability and for recovering after app reloads.

5. Improve failure surfaces.

   Many operations log to console or show generic toasts. Centralize errors into a visible diagnostics panel: spawn failed, command unavailable, ccusage failed, permission blocked, DB error, route blocked, terminal exit.

### P1: Make Multi-Agent Work Easier To Direct

These improve day-to-day usability once the core loop works.

1. Add team templates.

   Users should be able to spawn a named team preset in one click: "Full-stack feature team", "Review team", "Docs team", "Debugging team". The current agent presets are good building blocks, but spawning a whole working set is still manual.

2. Add card-to-agent lifecycle automation.

   A card assigned to agents should show live status: queued, sent, working, blocked, needs review, done. When an agent reports completion, the app can suggest the next lane rather than only linking/unlinking cards.

3. Add mention inbox and unread routing.

   Agent-to-agent messages are powerful but can become noisy. Add an inbox view grouped by target agent and card, with unread counts and filters for blocked mentions, direct questions, and handoffs.

4. Add saved workspace profiles.

   Store common working directories, default agents, board selection, terminal layout, and editor preference. This reduces setup friction for recurring projects.

5. Add command palette.

   A global keyboard-driven palette for spawn agent, open terminal, create card, search history, run compact, open settings, and switch pane would make the app faster for power users.

### P2: Make The Product Scalable

These matter when sessions become large or teams are used for real projects.

1. Searchable history.

   Add full-text search over messages, tool uses, cards, decisions, and session ids. The SQLite store already has the right foundation; FTS would make prior work reusable.

2. Better context management.

   Current compaction asks the agent to summarize, kills it, respawns, and appends summary to the system prompt. Add a visible compact history, summary quality preview, and manual edit before respawn.

3. Multi-vendor adapter maturity.

   The adapter trait is ready for more vendors, but only Claude is implemented. Add clear capability flags per vendor: stream events, tool events, cost usage, resume, model selection, safe mode.

4. Workspace artifact tracking.

   Track files touched by each agent, commits created, tests run, and commands proposed. This would connect chat, board cards, and git into one traceable work record.

5. Layout persistence.

   Persist pane layout, right pane mode, terminal tray state, board split, active workspace, and selected tabs. A control center should reopen exactly where the user left it.

## Product Risks

1. Safety model can be misunderstood.

   The app intentionally enables `--dangerously-skip-permissions` when approval mode is on, because the app-level proposal card becomes the safety gate. That is reasonable, but the UI must make this explicit and auditable.

2. Agent-to-agent routing can create token churn.

   Mentions are useful, but uncontrolled chatter will spend tokens and produce noisy work. The current prompt discourages casual mentions; product UI should also add rate limits, routing previews, or mention budgets.

3. The board can look like task management but behave like messaging.

   Sending a card to agents is useful, but users will expect lifecycle state, blockers, review, and completion semantics. Without that, the board may feel decorative rather than authoritative.

4. Local tool failures are easy to miss.

   Missing CLI binaries, PowerShell policy issues, font glyph issues, ccusage failures, and sandbox-like process restrictions all need visible diagnostics. This is especially important on Windows.

5. Encoding and font issues reduce perceived quality.

   README/comments and some UI strings have mojibake artifacts. Terminal prompt glyphs require Nerd Font fallback. These do not block functionality, but they make the product feel less stable.

## UX Improvements

1. Replace empty states with setup-aware actions.

   Empty grid should offer "Spawn a team", "Open terminal", "Open workspace", and "Create board" based on what is already configured.

2. Add a compact "mission header".

   At the top of a workspace, show current project path, active team, active board/card, usage pressure, git status, and next recommended action.

3. Make statuses more semantic.

   Current statuses like idle/thinking/working/stopped are useful. Add user-facing task states: assigned, waiting for approval, blocked, needs review, done.

4. Improve terminal font setup.

   Keep the Nerd Font fallback stack, but also detect missing glyph support or provide a settings field for terminal font family.

5. Use progressive disclosure for advanced controls.

   Mention allowlists, raw skip-permissions, workflow rules, and plan calibration are power-user features. Keep them available, but make default flows simple.

## Technical Improvements

1. Normalize event handling.

   `AgentEvent` is the central integration point. Keep it stable and document each event's lifecycle. Consider versioning events before adding more vendor adapters.

2. Persist approval/proposal data.

   Add `proposal_events` table keyed by message id and proposal index. Store body, command/file paths, decision, reason, and timestamps.

3. Add structured command execution records.

   Tool-use messages currently store tool name and JSON input. Add derived fields for file paths, shell commands, cwd, exit status, and card id when relevant.

4. Add tests around mention routing.

   Unit-test `find_mentions`, allowlist behavior, self-mention behavior, duplicate target grouping, and blocked mention events.

5. Add migration tests for boards.

   Board schema has grown to include descriptions, criteria, and allowed transitions. Add tests that open older schemas and verify migrations are idempotent.

6. Clean encoding artifacts.

   Replace mojibake in README, comments, and UI strings. Add `.editorconfig` and `.gitattributes` are already present; keep all text files UTF-8.

## Documentation To Add

Recommended docs set:

- `docs/product-review.md`: this product review and roadmap.
- `docs/architecture.md`: frontend/backend/event/database architecture.
- `docs/safety-model.md`: approval flow, mention routing, skip-permissions behavior, and threat model.
- `docs/agent-workflows.md`: how to use teams, boards, review lanes, and slash commands.
- `docs/troubleshooting.md`: Windows setup, PowerShell policy, missing binaries, Nerd Fonts, ccusage, database path.
- `docs/adapter-guide.md`: how to add Gemini/Codex/Aider adapters.

## Knowledge Notes

### System Model

The app has three major loops:

1. Agent loop: React invokes Tauri commands, Rust spawns a CLI process, parses stream-json stdout, emits `agent://event`, and React updates Zustand.
2. Terminal loop: Rust spawns a PTY, streams base64 output over `pty://output`, and xterm renders it.
3. Board loop: React mutates board/card state through Tauri commands backed by SQLite, then links card assignments to live agents in memory.

### Current Safety Model

There are two distinct safety gates:

- Mention routing gate: `allow_mentions` and `mention_allowlist` decide whether one agent can forward a message to another.
- Action approval gate: the system prompt asks the agent to emit `<<PROPOSAL>>...<<END_PROPOSAL>>`; the frontend renders Approve/Deny cards and sends the decision back.

Important caveat: app-level approval is prompt/protocol based. It is useful, but not cryptographic or OS-level enforcement. Treat it as a product guardrail, not a complete sandbox.

### Best Next Product Slice

The best near-term slice is "reviewable board workflow":

1. Default board columns: Backlog, Doing, Review, Done.
2. Send card to assignee from Backlog/Doing.
3. Agent completion creates a suggested Review move.
4. Reviewer/QA gets auto-assigned in Review.
5. Done requires an explicit user click or reviewer approval.

This builds directly on the existing board, agent routing, approval cards, and usage telemetry without needing a new architecture.

## Suggested Roadmap

### Milestone 1: Trust And Polish

- Fix encoding artifacts.
- Add first-run readiness checklist.
- Add diagnostics panel.
- Persist proposal decisions.
- Add terminal font setting.

### Milestone 2: Workflow Operating System

- Add team templates.
- Add default Review lane workflow.
- Add card lifecycle states.
- Add mention inbox.
- Persist layout and workspace profile.

### Milestone 3: Agent Work Traceability

- Search history with SQLite FTS.
- Track files/commands/tests per agent and card.
- Add review summaries and completion reports.
- Add exportable run reports.

### Milestone 4: Multi-Vendor Platform

- Add capability metadata to adapters.
- Implement at least one non-Claude adapter.
- Add adapter developer docs.
- Add vendor-specific usage and resume behavior.

