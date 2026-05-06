//! Vendor-agnostic agent adapter trait.
//!
//! Each vendor implements `AgentAdapter` to produce a child-process command,
//! encode user messages onto stdin, and parse stdout lines into normalized
//! `ParsedEvent`s. The rest of `manager.rs` stays vendor-neutral.

use anyhow::{anyhow, Result};
use tokio::process::Command;

use crate::agent::{AgentSpec, AgentUsage, ResumeOptions};

/// Normalized event parsed from a vendor's stdout stream.
#[derive(Debug, Clone)]
pub enum ParsedEvent {
    /// Session/thread initialized; capture vendor session id.
    SessionInit { session_id: String },
    /// Final assistant text for this turn, or a streamed delta if an adapter chooses.
    AssistantText { text: String },
    /// A tool invocation by the assistant.
    ToolUse {
        tool: String,
        input: serde_json::Value,
    },
    /// End-of-turn result with token/cost accounting.
    Result { usage: AgentUsage, duration_ms: u64 },
}

pub trait AgentAdapter: Send + Sync + 'static {
    /// Vendor key used in `AgentSpec.vendor`, e.g. "claude".
    fn vendor(&self) -> &'static str;

    /// Build a `Command` ready to spawn for this spec.
    /// Stdio piping + working dir are set by the manager; adapters only
    /// configure binary, args, and env.
    fn build_command(&self, spec: &AgentSpec, resume: &ResumeOptions) -> Result<Command>;

    /// Encode a user message into a single stdin line (must end with `\n`).
    fn encode_user_message(&self, msg: &str) -> String;

    /// Parse a single stdout line into zero or more normalized events.
    fn parse_events(&self, line: &str) -> Vec<ParsedEvent>;
}

// ---------------------------------------------------------------------------
// Claude (stream-json) adapter
// ---------------------------------------------------------------------------

pub struct ClaudeStreamJsonAdapter;

impl ClaudeStreamJsonAdapter {
    pub fn which() -> Result<String> {
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
        Err(anyhow!(
            "Claude CLI was not found. Install Claude Code and make sure `claude.cmd` is on PATH, or set CLAUDE_BIN / the agent runtime binary path to the full claude.cmd path."
        ))
    }
}

impl AgentAdapter for ClaudeStreamJsonAdapter {
    fn vendor(&self) -> &'static str {
        "claude"
    }

    fn build_command(&self, spec: &AgentSpec, resume: &ResumeOptions) -> Result<Command> {
        let bin = spec
            .vendor_binary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .map(Ok)
            .unwrap_or_else(Self::which)?;
        let mut cmd = Command::new(bin);
        cmd.arg("--print")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--input-format")
            .arg("stream-json")
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
            cmd.arg("--append-system-prompt")
                .arg(prompt_arg_for_process(sp));
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

    fn parse_events(&self, line: &str) -> Vec<ParsedEvent> {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let etype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match etype {
            "system" => {
                if v.get("subtype").and_then(|x| x.as_str()) == Some("init") {
                    if let Some(sid) = v.get("session_id").and_then(|x| x.as_str()) {
                        return vec![ParsedEvent::SessionInit {
                            session_id: sid.to_string(),
                        }];
                    }
                }
                Vec::new()
            }
            "assistant" => parse_assistant_events(&v),
            "result" => vec![parse_result_event(&v)],
            _ => Vec::new(),
        }
    }
}

fn parse_assistant_events(v: &serde_json::Value) -> Vec<ParsedEvent> {
    let mut text = String::new();
    let mut events = Vec::new();

    let Some(content) = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return events;
    };

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
                push_text_event(&mut events, &mut text);
                let tool = block
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("?")
                    .to_string();
                let input = block
                    .get("input")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                events.push(ParsedEvent::ToolUse { tool, input });
            }
            _ => {}
        }
    }

    push_text_event(&mut events, &mut text);
    events
}

fn push_text_event(events: &mut Vec<ParsedEvent>, text: &mut String) {
    let cleaned = text.trim().to_string();
    if !cleaned.is_empty() {
        events.push(ParsedEvent::AssistantText { text: cleaned });
        text.clear();
    }
}

fn parse_result_event(v: &serde_json::Value) -> ParsedEvent {
    let mut usage = AgentUsage::default();
    if let Some(u) = v.get("usage") {
        usage.input_tokens = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        usage.output_tokens = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        usage.cache_read_tokens = u
            .get("cache_read_input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        usage.cache_creation_tokens = u
            .get("cache_creation_input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
    }
    usage.total_cost_usd = v
        .get("total_cost_usd")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    let duration_ms = v.get("duration_ms").and_then(|x| x.as_u64()).unwrap_or(0);
    ParsedEvent::Result { usage, duration_ms }
}

fn prompt_arg_for_process(prompt: &str) -> String {
    #[cfg(windows)]
    {
        // npm-installed CLIs are often .cmd batch shims. Passing multiline
        // strings with shell metacharacters like < and > through a batch file
        // can fail before the real node CLI starts ("batch file arguments are
        // invalid"). Keep the prompt semantically readable but make it a
        // single command-line argument that the Windows batch layer accepts.
        prompt
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .replace("<<", "[[")
            .replace(">>", "]]")
            // The Windows npm `.cmd` shim can split a long prompt in ways that
            // let examples like `git reset --hard` escape as real CLI flags.
            // Keep the meaning readable for the model without leaving literal
            // double-dash tokens in the process argument.
            .replace("--", "dashdash ")
    }
    #[cfg(not(windows))]
    {
        prompt.to_string()
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
