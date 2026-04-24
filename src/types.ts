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
  color?: string | null;
  vendor?: string | null;
  // Security toggles (defaults are safe — opt-in to relax).
  skip_permissions?: boolean;
  allow_mentions?: boolean;
  mention_allowlist?: string[];
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
  | { kind: "exit"; agent_id: string; code: number | null }
  | { kind: "stderr"; agent_id: string; line: string };

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
  cols: number;
  rows: number;
}

export interface VendorInfo {
  name: string;
  binary: string;
  version: string | null;
}

export interface ExternalSession {
  session_id: string;
  project_dir: string;
  project_path: string | null;
  jsonl_path: string;
  size_bytes: number;
  modified_at: string;
}
