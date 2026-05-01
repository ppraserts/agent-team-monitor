# Workspace Model

Date: 2026-05-01

## Product Rule

Global views are for monitoring. Work happens inside a workspace.

The app can support many projects, but every work object should have a clear workspace context:

- Agent
- Terminal
- Board
- Card
- File tree
- Git status
- Activity
- Usage interpretation

## Current Implementation

Workspace is now a real product entity, while still preserving the low-friction POC workflow.

Current behavior:

- The app bootstraps a workspace from the Tauri workspace directory on launch.
- Workspaces are stored in SQLite and can be switched from the top toolbar.
- Additional workspaces can be added by root path from the workspace menu.
- Missions are stored per workspace and can be created/activated from the toolbar.
- The top toolbar shows workspace name, path, and git branch.
- Spawn defaults to the active workspace root.
- Agents and PTY terminals carry `workspace_id` when spawned from the UI.
- Boards carry `workspace_id`; the board panel lists boards for the active workspace.
- Agent panes show a workspace badge and shortened cwd.
- Terminal tabs and tray show the terminal workspace.
- Every user message sent to an agent gets an invisible backend-injected `[WORKSPACE NOW]` header containing project name, root, and git branch.
- If a workspace has an active mission, agent messages also get an invisible `[ACTIVE MISSION]` header.
- Board task messages include card id, labels, lane rules, and expected output.

On first bootstrap, legacy boards without a workspace id are attached to the bootstrapped workspace; legacy agents are attached when their cwd is inside the workspace root.

## Target Model

The current database model:

```text
workspaces
  id
  name
  root_path
  created_at
  last_opened_at

agents.workspace_id
ptys.workspace_id
boards.workspace_id
cards inferred through boards
settings optionally scoped by workspace_id
```

Mission is the shared "what are we trying to do?" layer:

```text
missions
  id
  workspace_id
  title
  goal
  definition_of_done
  constraints
  status
  created_at
  updated_at
```

The user should be able to:

- Open multiple workspaces.
- Switch between workspace-specific views.
- See an All Workspaces overview.
- Spawn agents into the selected workspace.
- Open terminals in the selected workspace.
- Keep boards separate per workspace.
- Copy or move a task across workspaces intentionally.

## Context Contract

Every agent assignment should carry these facts, either visibly in the message or invisibly through the backend header:

```text
[WORKSPACE]
Project:
Root:
Git branch:

[MISSION OR CARD]
Goal:
Definition of done:
Current lane:
Expected output:

[ROLE]
Agent name:
Agent role:
Allowed collaborators:
```

The current backend guarantees the `[WORKSPACE]` part for normal `agent_send` calls.

## UX Contract

The UI should always answer these questions without making the user inspect hidden state:

- Which project am I looking at?
- Which project is this agent working in?
- Which project is this terminal running in?
- Which board/card owns this task?
- Is this object outside the active workspace?

## Migration Plan

### Phase 1: Clarity Without Data Migration

Done:

- Active workspace derived from root path.
- Workspace badges in toolbar, agent pane, terminal tray, and spawn dialog.
- Invisible workspace context injection for agent messages.
- More explicit board task contract.
- Product docs for the model.

### Phase 2: Real Workspace Ownership

Done:

- Create `workspaces`.
- Add nullable `workspace_id` to `agents` and `boards`.
- Infer legacy workspace ownership from `cwd` where possible.
- Add workspace switcher.
- Filter agents, terminals, boards, and activity by active workspace.
- Add workspace add flow by root path.

### Phase 3: Mission Layer

Done:

- `missions` table scoped to workspace.
- Active mission shown in workspace header.
- Mission injected into agent messages with workspace context.
- Mission creation and activation from the toolbar.

Still recommended:

- Cards can link directly to a mission.
- Team templates can spawn against a mission.
- All Workspaces overview.
- Activity and usage filtering by workspace.

## Open Questions

- Should terminal cwd be allowed outside workspace root if the user explicitly chooses it?
- Should boards be strictly workspace-scoped or allow cross-workspace boards?
- Should agent mentions be blocked across workspaces by default?
- Should usage be aggregated globally only, or split by workspace using cwd/session metadata?
