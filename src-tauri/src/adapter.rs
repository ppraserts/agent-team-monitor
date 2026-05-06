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
        which_cli(
            "CLAUDE_BIN",
            &windows_or_unix(&["claude.cmd", "claude.exe", "claude"], &["claude"]),
            "Claude CLI was not found. Install Claude Code and make sure `claude.cmd` is on PATH, or set CLAUDE_BIN / the agent runtime binary path to the full claude.cmd path.",
        )
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
// Codex (exec --json) adapter
// ---------------------------------------------------------------------------

pub struct CodexExecJsonAdapter;

impl CodexExecJsonAdapter {
    pub fn which() -> Result<String> {
        which_cli(
            "CODEX_BIN",
            &windows_or_unix(&["codex.exe", "codex.cmd", "codex"], &["codex"]),
            "Codex CLI was not found. Install Codex CLI and make sure `codex` is on PATH, or set CODEX_BIN / the agent runtime binary path to the full codex executable path.",
        )
    }
}

impl AgentAdapter for CodexExecJsonAdapter {
    fn vendor(&self) -> &'static str {
        "codex"
    }

    fn build_command(&self, spec: &AgentSpec, _resume: &ResumeOptions) -> Result<Command> {
        let bin = spec
            .vendor_binary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
            .map(Ok)
            .unwrap_or_else(Self::which)?;

        let model_arg = spec
            .model
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("");
        let reasoning_effort = spec
            .reasoning_effort
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("");
        let system_prompt = spec
            .system_prompt
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("");
        let cwd = spec.cwd.display().to_string();

        #[cfg(windows)]
        {
            let mut cmd = Command::new("node.exe");
            cmd.arg("-e")
                .arg(codex_windows_node_bridge_script())
                .env("AGENT_CODEX_BIN", &bin)
                .env("AGENT_CODEX_CWD", &cwd)
                .env("AGENT_CODEX_MODEL", model_arg)
                .env("AGENT_CODEX_REASONING_EFFORT", reasoning_effort)
                .env("AGENT_CODEX_SYSTEM_PROMPT_B64", b64(system_prompt))
                .env(
                    "AGENT_CODEX_BYPASS",
                    if spec.skip_permissions { "1" } else { "0" },
                );
            Ok(cmd)
        }

        #[cfg(not(windows))]
        {
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(codex_unix_bridge_script(
                &bin,
                &cwd,
                model_arg,
                system_prompt,
                spec.skip_permissions,
            ));
            Ok(cmd)
        }
    }

    fn encode_user_message(&self, msg: &str) -> String {
        use base64::Engine;
        format!(
            "{}\n",
            base64::engine::general_purpose::STANDARD.encode(msg.as_bytes())
        )
    }

    fn parse_events(&self, line: &str) -> Vec<ParsedEvent> {
        parse_codex_event(line)
    }
}

#[cfg(windows)]
fn codex_windows_node_bridge_script() -> &'static str {
    r#"
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const cp = require('child_process');

const cwd = process.env.AGENT_CODEX_CWD || process.cwd();
const model = process.env.AGENT_CODEX_MODEL || '';
const reasoningEffort = process.env.AGENT_CODEX_REASONING_EFFORT || '';
const bypass = process.env.AGENT_CODEX_BYPASS === '1';
const systemPrompt = process.env.AGENT_CODEX_SYSTEM_PROMPT_B64
  ? Buffer.from(process.env.AGENT_CODEX_SYSTEM_PROMPT_B64, 'base64').toString('utf8')
  : '';
let sessionId = null;

function unique(items) {
  return [...new Set(items.filter(Boolean).map(String))];
}

function candidates() {
  const out = [];
  out.push(process.env.AGENT_CODEX_BIN);
  out.push(process.env.CODEX_BIN);
  const roots = [process.env.LOCALAPPDATA, process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local')];
  for (const root of roots) out.push(root && path.join(root, 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  if (process.env.LOCALAPPDATA) {
    const packagesRoot = path.join(process.env.LOCALAPPDATA, 'Packages');
    try {
      for (const name of fs.readdirSync(packagesRoot)) {
        if (name.startsWith('OpenAI.Codex_')) {
          out.push(path.join(packagesRoot, name, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
        }
      }
    } catch {}
  }
  try {
    const where = cp.spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
    if (where.stdout) out.push(...where.stdout.split(/\r?\n/).map(s => s.trim()));
  } catch {}
  out.push('codex.exe', 'codex.cmd', 'codex');
  return unique(out);
}

function probe(cmd) {
  try {
    const r = cp.spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const candidateBins = candidates();
let codexBin = candidateBins.find(probe) || null;
if (!codexBin) {
  process.stderr.write('Codex CLI not directly resolved by Node bridge; trying shell fallback.\n');
  process.stderr.write('USERPROFILE=' + (process.env.USERPROFILE || '') + '\n');
  process.stderr.write('LOCALAPPDATA=' + (process.env.LOCALAPPDATA || '') + '\n');
  process.stderr.write('PATH=' + (process.env.PATH || '') + '\n');
  process.stderr.write('Checked: ' + candidateBins.join('; ') + '\n');
  codexBin = 'codex';
}

function noteSession(line) {
  try {
    const obj = JSON.parse(line);
    for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) {
      if (obj[key]) sessionId = String(obj[key]);
    }
    for (const parent of ['session', 'conversation', 'thread']) {
      if (obj[parent]) {
        for (const key of ['id', 'session_id', 'sessionId']) {
          if (obj[parent][key]) sessionId = String(obj[parent][key]);
        }
      }
    }
  } catch {}
}

function runCodex(prompt) {
  const args = sessionId
    ? ['exec', 'resume', sessionId, '--json']
    : ['exec', '--json', '-C', cwd];
  if (model) args.push('-m', model);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  if (bypass) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push('-');

  const useShell = codexBin === 'codex' || codexBin === 'codex.exe' || codexBin === 'codex.cmd';
  const child = cp.spawn(codexBin, args, { cwd, windowsHide: true, shell: useShell });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      process.stdout.write(line + '\n');
      noteSession(line);
    }
  });
  child.stderr.on('data', chunk => {
    stderrBuf += chunk;
    const lines = stderrBuf.split(/\r?\n/);
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line) process.stderr.write(line + '\n');
    }
  });
  child.on('error', err => process.stderr.write('spawn codex failed: ' + err.message + '\n'));
  child.on('close', code => {
    if (stdoutBuf.trim()) {
      process.stdout.write(stdoutBuf.trimEnd() + '\n');
      noteSession(stdoutBuf.trim());
    }
    if (stderrBuf.trim()) process.stderr.write(stderrBuf.trimEnd() + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', duration_ms: 0, usage: {} }) + '\n');
  });
  child.stdin.end(prompt);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  const userPrompt = Buffer.from(line.trim(), 'base64').toString('utf8');
  const prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
  runCodex(prompt);
});
"#
}

#[cfg(not(windows))]
fn codex_unix_bridge_script(
    bin: &str,
    cwd: &str,
    model: &str,
    system_prompt: &str,
    bypass_sandbox: bool,
) -> String {
    let bypass = if bypass_sandbox {
        " --dangerously-bypass-approvals-and-sandbox"
    } else {
        ""
    };
    format!(
        r#"
bin={bin}
cwd={cwd}
model={model}
system_prompt_b64={system_prompt_b64}
session_id=
while IFS= read -r line; do
  [ -z "$line" ] && continue
  prompt="$(printf '%s' "$line" | base64 -d)"
  if [ -n "$system_prompt_b64" ]; then
    sp="$(printf '%s' "$system_prompt_b64" | base64 -d)"
    prompt="$sp

$prompt"
  fi
  tmp="$(mktemp)"
  printf '%s' "$prompt" > "$tmp"
  if [ -n "$session_id" ]; then
    "$bin" exec resume "$session_id" --json ${model:+-m "$model"}{bypass} - < "$tmp"
  else
    "$bin" exec --json -C "$cwd" ${model:+-m "$model"}{bypass} - < "$tmp"
  fi
  rm -f "$tmp"
done
"#,
        bin = sh_quote(bin),
        cwd = sh_quote(cwd),
        model = sh_quote(model),
        system_prompt_b64 = sh_quote(&b64(system_prompt)),
        bypass = bypass,
    )
}

fn parse_codex_event(line: &str) -> Vec<ParsedEvent> {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let event_type = first_str(&v, &["type", "event", "kind", "msg.type"]).unwrap_or("");

    let mut out = Vec::new();
    if let Some(session_id) = first_str(
        &v,
        &[
            "session_id",
            "sessionId",
            "conversation_id",
            "conversationId",
            "thread_id",
            "threadId",
            "session.id",
            "conversation.id",
            "thread.id",
        ],
    ) {
        out.push(ParsedEvent::SessionInit {
            session_id: session_id.to_string(),
        });
    }

    if event_type.contains("tool")
        || event_type.contains("exec")
        || event_type.contains("command")
        || first_value(&v, &["tool", "tool_call", "toolCall", "call"]).is_some()
    {
        if let Some(tool) = first_str(
            &v,
            &[
                "tool",
                "tool_name",
                "toolName",
                "name",
                "call.name",
                "tool_call.name",
                "toolCall.name",
            ],
        ) {
            let input = first_value(
                &v,
                &[
                    "input",
                    "arguments",
                    "args",
                    "call.input",
                    "tool_call.input",
                    "toolCall.input",
                ],
            )
            .cloned()
            .unwrap_or(serde_json::Value::Null);
            out.push(ParsedEvent::ToolUse {
                tool: normalize_codex_tool_name(tool),
                input,
            });
        }
    }

    if event_type.contains("result")
        || event_type == "turn.completed"
        || event_type == "response.completed"
        || first_value(&v, &["usage", "token_usage", "tokenUsage"]).is_some()
    {
        out.push(parse_codex_result_event(&v));
    }

    if let Some(text) = first_str(
        &v,
        &[
            "text",
            "message",
            "content",
            "delta",
            "response",
            "output",
            "item.text",
            "item.content",
            "msg.text",
            "msg.message",
            "msg.content",
        ],
    ) {
        if should_emit_codex_text(&v, event_type, text) {
            out.push(ParsedEvent::AssistantText {
                text: text.trim().to_string(),
            });
        }
    }

    out
}

fn parse_codex_result_event(v: &serde_json::Value) -> ParsedEvent {
    let mut usage = AgentUsage::default();
    let usage_v = first_value(v, &["usage", "token_usage", "tokenUsage"]).unwrap_or(v);
    usage.input_tokens = first_u64(
        usage_v,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "input",
        ],
    )
    .unwrap_or(0);
    usage.output_tokens = first_u64(
        usage_v,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
            "output",
        ],
    )
    .unwrap_or(0);
    usage.cache_read_tokens = first_u64(
        usage_v,
        &[
            "cache_read_tokens",
            "cacheReadTokens",
            "cached_input_tokens",
        ],
    )
    .unwrap_or(0);
    usage.cache_creation_tokens = first_u64(
        usage_v,
        &[
            "cache_creation_tokens",
            "cacheCreationTokens",
            "cache_write_tokens",
        ],
    )
    .unwrap_or(0);
    usage.total_cost_usd = first_f64(
        v,
        &["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"],
    )
    .unwrap_or(0.0);
    let duration_ms =
        first_u64(v, &["duration_ms", "durationMs", "elapsed_ms", "elapsedMs"]).unwrap_or(0);
    ParsedEvent::Result { usage, duration_ms }
}

fn should_emit_codex_text(v: &serde_json::Value, event_type: &str, text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if first_str(v, &["item.type", "msg.type"]) == Some("agent_message") {
        return true;
    }
    let t = event_type.to_ascii_lowercase();
    t.is_empty()
        || t.contains("assistant")
        || t.contains("message")
        || t.contains("response")
        || t.contains("output")
        || t.contains("final")
}

fn normalize_codex_tool_name(tool: &str) -> String {
    match tool {
        "shell" | "exec" | "command" => "shell".to_string(),
        other => other.to_string(),
    }
}

fn first_value<'a>(v: &'a serde_json::Value, paths: &[&str]) -> Option<&'a serde_json::Value> {
    paths.iter().find_map(|path| value_at_path(v, path))
}

fn first_str<'a>(v: &'a serde_json::Value, paths: &[&str]) -> Option<&'a str> {
    first_value(v, paths).and_then(|x| x.as_str())
}

fn first_u64(v: &serde_json::Value, paths: &[&str]) -> Option<u64> {
    first_value(v, paths).and_then(|x| x.as_u64().or_else(|| x.as_str()?.parse::<u64>().ok()))
}

fn first_f64(v: &serde_json::Value, paths: &[&str]) -> Option<f64> {
    first_value(v, paths).and_then(|x| x.as_f64().or_else(|| x.as_str()?.parse::<f64>().ok()))
}

fn value_at_path<'a>(v: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = v;
    for part in path.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn which_cli(env_var: &str, candidates: &[&str], error: &str) -> Result<String> {
    if let Ok(path) = std::env::var(env_var) {
        if !path.trim().is_empty() {
            return Ok(path);
        }
    }
    for path in well_known_cli_paths(env_var) {
        if path.is_file() {
            return Ok(path.display().to_string());
        }
    }
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
    Err(anyhow!(error.to_string()))
}

fn well_known_cli_paths(env_var: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        if env_var == "CODEX_BIN" {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                out.push(
                    std::path::PathBuf::from(&local)
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin")
                        .join("codex.exe"),
                );
                let packages = std::path::PathBuf::from(&local).join("Packages");
                if let Ok(entries) = std::fs::read_dir(packages) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with("OpenAI.Codex_") {
                            out.push(
                                entry
                                    .path()
                                    .join("LocalCache")
                                    .join("Local")
                                    .join("OpenAI")
                                    .join("Codex")
                                    .join("bin")
                                    .join("codex.exe"),
                            );
                        }
                    }
                }
            }
            if let Ok(profile) = std::env::var("USERPROFILE") {
                out.push(
                    std::path::PathBuf::from(profile)
                        .join("AppData")
                        .join("Local")
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin")
                        .join("codex.exe"),
                );
            }
            if let Some(home) = dirs::home_dir() {
                out.push(
                    home.join("AppData")
                        .join("Local")
                        .join("OpenAI")
                        .join("Codex")
                        .join("bin")
                        .join("codex.exe"),
                );
            }
        }
    }
    out
}

fn windows_or_unix<'a>(_windows: &'a [&'a str], _unix: &'a [&'a str]) -> Vec<&'a str> {
    #[cfg(windows)]
    {
        _windows.to_vec()
    }
    #[cfg(not(windows))]
    {
        _unix.to_vec()
    }
}

fn b64(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
}

#[cfg(not(windows))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/// Resolve a vendor key to an adapter instance.
pub fn make_adapter(vendor: Option<&str>) -> Result<Box<dyn AgentAdapter>> {
    match vendor.unwrap_or("claude") {
        "claude" => Ok(Box::new(ClaudeStreamJsonAdapter)),
        "codex" => Ok(Box::new(CodexExecJsonAdapter)),
        other => anyhow::bail!("unknown vendor adapter: {}", other),
    }
}
