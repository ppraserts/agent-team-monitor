use chrono::{DateTime, Utc};
use crate::boards::BoardCard;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpec {
    pub name: String,
    pub role: String,
    pub cwd: PathBuf,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Vendor key — selects the AgentAdapter (default: "claude").
    #[serde(default)]
    pub vendor: Option<String>,
    #[serde(default)]
    pub vendor_binary: Option<String>,

    // ----- Security -----
    /// If true, pass `--dangerously-skip-permissions` to the CLI.
    /// Default: false (safer — user must opt in per-agent).
    #[serde(default)]
    pub skip_permissions: bool,
    /// If true, this agent is allowed to mention other agents via `@AgentName`.
    /// Default: false (safer — explicit opt-in for cross-agent routing).
    #[serde(default)]
    pub allow_mentions: bool,
    /// Optional allowlist of agent names this agent may mention.
    /// Empty list with `allow_mentions=true` means "any agent".
    #[serde(default)]
    pub mention_allowlist: Vec<String>,
}

/// Optional resume parameters when re-spawning an agent from history.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResumeOptions {
    /// Past Claude session id to resume (passed as `--resume <id>`).
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Idle,
    Thinking,
    Working,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub total_cost_usd: f64,
    pub turns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSnapshot {
    pub id: String,
    pub spec: AgentSpec,
    pub status: AgentStatus,
    pub session_id: Option<String>,
    pub last_activity: DateTime<Utc>,
    pub usage: AgentUsage,
    pub message_count: u64,
    /// Most recent turn's TOTAL input tokens (= input_tokens + cache_read +
    /// cache_creation). Approximates the agent's current context size; used
    /// for the context indicator + auto-compact threshold.
    pub current_context_tokens: u64,
}

/// Events emitted to the frontend on the `agent://event` channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    Created { snapshot: AgentSnapshot },
    Status { agent_id: String, status: AgentStatus },
    Message {
        agent_id: String,
        role: String,
        content: String,
        ts: DateTime<Utc>,
        from_agent_id: Option<String>,
    },
    ToolUse {
        agent_id: String,
        tool: String,
        input: serde_json::Value,
        ts: DateTime<Utc>,
    },
    Result {
        agent_id: String,
        usage: AgentUsage,
        duration_ms: u64,
    },
    Mention {
        from_agent_id: String,
        to_agent_name: String,
        /// Resolved id of the target agent (None if no agent with that name exists).
        to_agent_id: Option<String>,
        message: String,
    },
    /// Fired when a mention was detected but blocked by policy.
    MentionBlocked {
        from_agent_id: String,
        to_agent_name: String,
        reason: String,
    },
    BoardAction {
        agent_id: String,
        action: String,
        ok: bool,
        message: String,
        card: Option<BoardCard>,
        ts: DateTime<Utc>,
    },
    Exit { agent_id: String, code: Option<i32> },
    Stderr { agent_id: String, line: String },
}
