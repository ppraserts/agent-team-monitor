export type AgentStatus =
  | "starting"
  | "idle"
  | "thinking"
  | "working"
  | "error"
  | "stopped";

export interface AgentSpec {
  name: string;
  role: string;
  cwd: string;
  system_prompt?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  color?: string | null;
  vendor?: string | null;
  vendor_binary?: string | null;
  workspace_id?: string | null;
  // Security toggles (defaults are safe — opt-in to relax).
  skip_permissions?: boolean;
  allow_mentions?: boolean;
  mention_allowlist?: string[];
  max_turns?: number;
  max_tool_calls?: number;
  max_cost_usd?: number;
  max_runtime_ms?: number;
}

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  turns: number;
}

export interface AgentSnapshot {
  id: string;
  spec: AgentSpec;
  status: AgentStatus;
  session_id: string | null;
  last_activity: string;
  usage: AgentUsage;
  message_count: number;
  /// Most recent turn's total input tokens (input + cache_read + cache_creation).
  /// Used for the context indicator + auto-compact threshold.
  current_context_tokens: number;
}

export type AgentEvent =
  | { kind: "created"; snapshot: AgentSnapshot }
  | { kind: "status"; agent_id: string; status: AgentStatus }
  | {
      kind: "message";
      agent_id: string;
      role: string;
      content: string;
      ts: string;
      from_agent_id: string | null;
    }
  | {
      kind: "tool_use";
      agent_id: string;
      tool: string;
      input: unknown;
      ts: string;
    }
  | {
      kind: "result";
      agent_id: string;
      usage: AgentUsage;
      duration_ms: number;
    }
  | {
      kind: "mention";
      from_agent_id: string;
      to_agent_name: string;
      to_agent_id: string | null;
      message: string;
    }
  | {
      kind: "mention_blocked";
      from_agent_id: string;
      to_agent_name: string;
      reason: string;
    }
  | {
      kind: "board_action";
      agent_id: string;
      action: string;
      ok: boolean;
      message: string;
      card: BoardCard | null;
      ts: string;
    }
  | {
      kind: "exit";
      agent_id: string;
      agent_name: string | null;
      code: number | null;
      stderr_tail: string[];
    }
  | { kind: "stderr"; agent_id: string; line: string }
  | {
      kind: "harness_alert";
      agent_id: string;
      severity: string;
      failure_mode: string;
      message: string;
      ts: string;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  ts: string;
  from_agent_id?: string | null;
  tool_name?: string;
  tool_input?: unknown;
}

export interface PtySnapshot {
  id: string;
  title: string;
  cwd: string;
  workspace_id?: string | null;
  cols: number;
  rows: number;
}

export interface VendorInfo {
  name: string;
  binary: string;
  version: string | null;
}

export type WorkspaceToolKind =
  | "editor"
  | "file_explorer"
  | "terminal"
  | "shell";

export interface WorkspaceTool {
  id: string;
  name: string;
  kind: WorkspaceToolKind;
  binary: string | null;
  available: boolean;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ImageAttachment {
  id: string;
  name: string;
  path: string;
  mime: string;
}

export interface BitbucketPrInfo {
  workspace: string;
  repo: string;
  prId: number;
  url: string;
  title: string;
  state: string;
  author: string;
  sourceBranch: string;
  destinationBranch: string;
  sourceCommit?: string | null;
  changedFiles: string[];
  hasMoreFiles: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  is_binary: boolean;
  size_bytes: number;
  mtime_ms: number;
}

export interface GitStatus {
  branch: string | null;
  changed_count: number;
  summary: string[];
  is_repo: boolean;
}

export interface GitFileChange {
  path: string;
  old_path: string | null;
  xy: string;
  index_status: string;
  work_status: string;
  staged: boolean;
  unstaged: boolean;
  is_untracked: boolean;
  is_conflicted: boolean;
  is_ignored: boolean;
}

export interface GitChanges {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  has_remote: boolean;
  files: GitFileChange[];
}

export interface GitBranch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
}

export interface GitStash {
  index: number;
  name: string;
  message: string;
  branch: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  root_path: string;
  active_mission_id: string | null;
  created_at: string;
  last_opened_at: string;
}

export interface Mission {
  id: string;
  workspace_id: string;
  title: string;
  goal: string;
  definition_of_done: string | null;
  constraints: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceContext {
  id: string;
  name: string;
  root: string;
  active_mission_id?: string | null;
}

export interface RuntimeCheck {
  name: string;
  binary: string | null;
  version: string | null;
  ok: boolean;
  message: string | null;
}

export interface RuntimeDiagnostics {
  checks: RuntimeCheck[];
}

export interface ExternalSession {
  session_id: string;
  project_dir: string;
  project_path: string | null;
  jsonl_path: string;
  size_bytes: number;
  modified_at: string;
}

export interface HistoryAgent {
  id: string;
  spec: AgentSpec;
  session_id: string | null;
  message_count: number;
  usage: AgentUsage;
  last_seen_at: string;
}

export interface HistoryMessage {
  id: string;
  role: string;
  content: string;
  from_agent_id: string | null;
  tool_name: string | null;
  tool_input: unknown | null;
  ts: string;
}

export interface UsageStats {
  today_input_tokens: number;
  today_output_tokens: number;
  today_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  total_turns: number;
  total_agents: number;
}

export interface CustomPreset {
  name: string;
  role: string;
  color: string | null;
  group_name: string;
  system_prompt: string | null;
}

// ccusage JSON shapes (raw from `npx ccusage <kind> --json`).
// Daily uses `date` (YYYY-MM-DD), weekly uses `week` (YYYY-MM-DD of week start),
// monthly uses `month` (YYYY-MM).
export interface CcusagePeriodEntry {
  date?: string;
  week?: string;
  month?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: {
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
  }[];
}

export interface CcusageBlockEntry {
  startTime?: string;
  endTime?: string;
  isActive?: boolean;
  totalTokens?: number;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  modelsUsed?: string[];
  // ccusage may include other fields; we accept anything.
  [key: string]: unknown;
}

export interface CcusageReport {
  daily: { daily: CcusagePeriodEntry[] } | null;
  weekly: { weekly: CcusagePeriodEntry[] } | null;
  monthly: { monthly: CcusagePeriodEntry[] } | null;
  blocks: { blocks: CcusageBlockEntry[] } | null;
  error: string | null;
}

export type SkillKind = "skill" | "command";
export type SkillScope = "global" | "project";

export interface SkillEntry {
  kind: SkillKind;
  scope: SkillScope;
  name: string;
  description: string | null;
  path: string;
  body: string;
}

// ---------------- Boards (Trello-style task boards) ----------------

export interface Board {
  id: number;
  workspace_id: string | null;
  name: string;
  description: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface BoardColumn {
  id: number;
  board_id: number;
  title: string;
  color: string | null;
  description: string | null;
  entry_criteria: string | null;
  exit_criteria: string | null;
  allowed_next_column_ids: number[];
  position: number;
}

export interface BoardCard {
  id: number;
  column_id: number;
  title: string;
  description: string | null;
  assignees: string[];
  labels: string[];
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CardInput {
  title: string;
  description?: string | null;
  assignees?: string[];
  labels?: string[];
}
