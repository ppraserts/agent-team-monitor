//! Vendor-agnostic agent adapter trait.
//!
//! Each vendor (Claude, Gemini, MiniMax, …) implements `AgentAdapter` to
//! produce a child-process command, encode user messages onto stdin, and parse
//! event lines from stdout into a normalized `ParsedEvent`. The rest of
//! `manager.rs` is vendor-neutral.

use anyhow::Result;
use tokio::process::Command;

use crate::agent::{AgentSpec, AgentUsage, ResumeOptions};

/// Normalized event parsed from a vendor's stdout stream.
#[derive(Debug, Clone)]
pub enum ParsedEvent {
    /// Session/thread initialized — capture vendor session id.
    SessionInit { session_id: String },
    /// Final assistant text for this turn (or a streamed delta — adapter decides).
    AssistantText { text: String },
    /// A tool invocation by the assistant.
    ToolUse {
        tool: String,
        input: serde_json::Value,
    },
    /// End-of-turn result with token/cost accounting.
    Result {
        usage: AgentUsage,
        duration_ms: u64,
    },
    /// Anything we don't care about yet.
    Other,
}

pub trait AgentAdapter: Send + Sync + 'static {
    /// Vendor key used in `AgentSpec.vendor` (e.g. "claude", "gemini").
    fn vendor(&self) -> &'static str;

    /// Build a `Command` ready to spawn for this spec.
    /// Stdio piping + working dir are set by the manager — adapters only
    /// configure binary, args, and env. `resume` carries optional re-attach
    /// parameters (e.g. Claude `--resume <session_id>`).
    fn build_command(&self, spec: &AgentSpec, resume: &ResumeOptions) -> Result<Command>;

    /// Encode a user message into a single stdin line (must end with `\n`).
    fn encode_user_message(&self, msg: &str) -> String;

    /// Parse a single line of stdout into a `ParsedEvent`.
    /// Return `Other` for lines you don't recognize.
    fn parse_event(&self, line: &str) -> ParsedEvent;
}

// ---------------------------------------------------------------------------
// Claude (stream-json) adapter
// ---------------------------------------------------------------------------

pub struct ClaudeStreamJsonAdapter;

impl ClaudeStreamJsonAdapter {
    fn which() -> Result<String> {
        if let Ok(path) = std::env::var("CLAUDE_BIN") {
            return Ok(path);
        }
        #[cfg(windows)]
        let candidates: &[&str] = &["claude.cmd", "claude.exe", "claude"];
        #[cfg(not(windows))]
        let candidates: &[&str] = &["claude"];
        #[cfg(windows)]
        let finder = "where";
        #[cfg(not(windows))]
        let finder = "which";

        for c in candidates {
            if let Ok(out) = std::process::Command::new(finder).arg(c).output() {
                if out.status.success() {
                    if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                        let p = line.trim().to_string();
                        if !p.is_empty() {
                            return Ok(p);
                        }
                    }
                }
            }
        }
        Ok("claude".to_string())
    }
}

impl AgentAdapter for ClaudeStreamJsonAdapter {
    fn vendor(&self) -> &'static str {
        "claude"
    }

    fn build_command(&self, spec: &AgentSpec, resume: &ResumeOptions) -> Result<Command> {
        let bin = Self::which()?;
        let mut cmd = Command::new(bin);
        cmd.arg("--print")
            .arg("--output-format").arg("stream-json")
            .arg("--input-format").arg("stream-json")
            .arg("--verbose");

        if let Some(sid) = &resume.session_id {
            cmd.arg("--resume").arg(sid);
        }
        if spec.skip_permissions {
            cmd.arg("--dangerously-skip-permissions");
        }
        if let Some(model) = &spec.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(sp) = &spec.system_prompt {
            cmd.arg("--append-system-prompt").arg(sp);
        }
        Ok(cmd)
    }

    fn encode_user_message(&self, msg: &str) -> String {
        let payload = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": msg }
        });
        format!("{}\n", payload)
    }

    fn parse_event(&self, line: &str) -> ParsedEvent {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return ParsedEvent::Other,
        };
        let etype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match etype {
            "system" => {
                if v.get("subtype").and_then(|x| x.as_str()) == Some("init") {
                    if let Some(sid) = v.get("session_id").and_then(|x| x.as_str()) {
                        return ParsedEvent::SessionInit { session_id: sid.to_string() };
                    }
                }
                ParsedEvent::Other
            }
            "assistant" => {
                let mut text = String::new();
                if let Some(content) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in content {
                        let btype = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        match btype {
                            "text" => {
                                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                                    if !text.is_empty() {
                                        text.push('\n');
                                    }
                                    text.push_str(t);
                                }
                            }
                            "tool_use" => {
                                let tool = block
                                    .get("name").and_then(|x| x.as_str())
                                    .unwrap_or("?").to_string();
                                let input = block.get("input").cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                // We can only return one event per call; emit text first
                                // (if any) by NOT preserving multi-event output here.
                                // For tool_use we return ToolUse; if both text and tool_use
                                // exist in the same message, the manager will see one of them
                                // per stream line. In practice Claude usually emits them in
                                // separate "assistant" events; if not, prefer tool_use signal
                                // since text without trailing tool_use is uncommon.
                                if text.is_empty() {
                                    return ParsedEvent::ToolUse { tool, input };
                                }
                                // We have text already — fallthrough emits text;
                                // tool_use will arrive in the next "assistant" event
                                // in practice. (Adapters will be extended to emit
                                // multiple events per line in v2.)
                            }
                            _ => {}
                        }
                    }
                }
                // Trim leading/trailing blank lines + whitespace. Claude often
                // emits leading newlines when it's responding after a header /
                // system-style preamble (e.g. our roster injection), which
                // would otherwise show as a tall blank gap at the top of the
                // chat bubble.
                let cleaned = text.trim().to_string();
                if cleaned.is_empty() {
                    ParsedEvent::Other
                } else {
                    ParsedEvent::AssistantText { text: cleaned }
                }
            }
            "result" => {
                let mut usage = AgentUsage::default();
                if let Some(u) = v.get("usage") {
                    usage.input_tokens = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    usage.output_tokens = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    usage.cache_read_tokens = u.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    usage.cache_creation_tokens = u.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
                }
                usage.total_cost_usd = v.get("total_cost_usd").and_then(|x| x.as_f64()).unwrap_or(0.0);
                let duration_ms = v.get("duration_ms").and_then(|x| x.as_u64()).unwrap_or(0);
                ParsedEvent::Result { usage, duration_ms }
            }
            _ => ParsedEvent::Other,
        }
    }
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/// Resolve a vendor key to an adapter instance.
pub fn make_adapter(vendor: Option<&str>) -> Result<Box<dyn AgentAdapter>> {
    match vendor.unwrap_or("claude") {
        "claude" => Ok(Box::new(ClaudeStreamJsonAdapter)),
        other => anyhow::bail!("unknown vendor adapter: {}", other),
    }
}
