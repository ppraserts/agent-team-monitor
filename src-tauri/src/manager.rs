//! Vendor-agnostic agent process manager.
//!
//! - **Single owner of `Child`**: only the exit watcher task owns the spawned
//!   child. `kill()` signals the watcher via a oneshot — preventing the
//!   double-`take()` race where a zombie could be left behind.
//! - **Atomic registry update**: `inner` (id→handle) and `name_index`
//!   (name→id) are updated under a single critical section.
//! - **Cleanup on exit**: when the child exits (naturally or by kill), the
//!   watcher removes the agent from BOTH maps so a re-spawn under the same
//!   name works.
//! - **Mention security**: `@AgentName` routing is opt-in per-agent and
//!   honors a per-agent allowlist. Blocked routes still emit `MentionBlocked`
//!   so the UI can show the attempt.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use parking_lot::RwLock;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::adapter::{make_adapter, AgentAdapter, ParsedEvent};
use crate::agent::{AgentEvent, AgentSnapshot, AgentSpec, AgentStatus, AgentUsage, ResumeOptions};
use crate::boards::{self, BoardCard, CardInput};
use crate::db::Db;

const EVENT_CHANNEL: &str = "agent://event";

struct AgentHandle {
    id: String,
    spec: AgentSpec,
    status: Arc<RwLock<AgentStatus>>,
    session_id: Arc<RwLock<Option<String>>>,
    usage: Arc<RwLock<AgentUsage>>,
    message_count: Arc<RwLock<u64>>,
    /// Most recent turn's total input tokens (current context size).
    current_context: Arc<RwLock<u64>>,
    tool_calls: Arc<RwLock<u64>>,
    stdin_tx: mpsc::Sender<String>,
    /// Encoder for outbound user messages (vendor-specific).
    encode_user: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// Send `()` to ask the exit watcher to kill the child. Only one kill request
    /// is honored — the option is consumed on first use.
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
    last_activity: Arc<RwLock<chrono::DateTime<Utc>>>,
    started_at: chrono::DateTime<Utc>,
    stderr_tail: Arc<RwLock<Vec<String>>>,
}

#[derive(Clone)]
pub struct AgentManager {
    /// Single struct holds both maps to make updates atomic under one lock.
    registry: Arc<RwLock<Registry>>,
    app: AppHandle,
    db: Arc<Db>,
}

#[derive(Default)]
struct Registry {
    by_id: HashMap<String, Arc<AgentHandle>>,
    by_name: HashMap<String, String>, // name -> id
}

impl AgentManager {
    pub fn new(app: AppHandle, db: Arc<Db>) -> Self {
        Self {
            registry: Arc::new(RwLock::new(Registry::default())),
            app,
            db,
        }
    }

    pub fn list(&self) -> Vec<AgentSnapshot> {
        self.registry
            .read()
            .by_id
            .values()
            .map(|h| snapshot_of(h))
            .collect()
    }

    pub async fn spawn(&self, spec: AgentSpec) -> Result<AgentSnapshot> {
        self.spawn_with_resume(spec, ResumeOptions::default()).await
    }

    pub async fn spawn_with_resume(
        &self,
        spec: AgentSpec,
        resume: ResumeOptions,
    ) -> Result<AgentSnapshot> {
        // Reject duplicate name BEFORE spawning, atomically + capture live roster
        // so we can inject the ACTUAL team names (not hardcoded ones) into the
        // new agent's system prompt.
        let live_roster: Vec<String> = {
            let reg = self.registry.read();
            if reg.by_name.contains_key(&spec.name) {
                return Err(anyhow!("agent name '{}' already exists", spec.name));
            }
            reg.by_name.keys().cloned().collect()
        };

        let adapter = make_adapter(spec.vendor.as_deref())?;
        let id = uuid::Uuid::new_v4().to_string();

        if !spec.cwd.is_dir() {
            return Err(anyhow!(
                "working directory does not exist or is not a directory: {}",
                spec.cwd.display()
            ));
        }

        // Patch the spec so the agent sees the live roster, including its own
        // name. This lets users name agents anything (e.g. "PM1", "PM2") and
        // still have @mention routing work.
        let effective_spec = inject_team_roster(&spec, &live_roster);

        let mut cmd = adapter.build_command(&effective_spec, &resume)?;
        cmd.current_dir(&spec.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Hide console window on Windows. tokio::process::Command exposes
        // `creation_flags` directly (no CommandExt import needed).
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn vendor '{}'", adapter.vendor()))?;

        let stdin = child.stdin.take().context("child stdin missing")?;
        let stdout = child.stdout.take().context("child stdout missing")?;
        let stderr = child.stderr.take().context("child stderr missing")?;

        let (stdin_tx, stdin_rx) = mpsc::channel::<String>(64);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        // Capture the vendor's encoder before moving adapter into the parser task.
        let encode_user: Arc<dyn Fn(&str) -> String + Send + Sync> = {
            let adapter_for_encode = make_adapter(spec.vendor.as_deref())?;
            Arc::new(move |msg: &str| adapter_for_encode.encode_user_message(msg))
        };

        // Store the ORIGINAL spec (without injected roster) in the handle so the
        // sidebar / history panels show the user's clean prompt — the roster is
        // an internal detail.
        let handle = Arc::new(AgentHandle {
            id: id.clone(),
            spec: spec.clone(),
            status: Arc::new(RwLock::new(AgentStatus::Starting)),
            session_id: Arc::new(RwLock::new(None)),
            usage: Arc::new(RwLock::new(AgentUsage::default())),
            message_count: Arc::new(RwLock::new(0)),
            current_context: Arc::new(RwLock::new(0)),
            tool_calls: Arc::new(RwLock::new(0)),
            stdin_tx,
            encode_user,
            kill_tx: Mutex::new(Some(kill_tx)),
            last_activity: Arc::new(RwLock::new(Utc::now())),
            started_at: Utc::now(),
            stderr_tail: Arc::new(RwLock::new(Vec::new())),
        });

        // Atomic insert into both indexes.
        {
            let mut reg = self.registry.write();
            reg.by_id.insert(id.clone(), handle.clone());
            reg.by_name.insert(spec.name.clone(), id.clone());
        }

        // Persist agent metadata.
        if let Err(e) = self.db.upsert_agent(&id, &spec) {
            tracing::warn!("db upsert_agent failed: {}", e);
        }

        spawn_stdin_pump(stdin, stdin_rx);
        spawn_stdout_reader(self.clone(), id.clone(), stdout, adapter);
        spawn_stderr_reader(self.clone(), id.clone(), stderr, handle.stderr_tail.clone());
        spawn_exit_watcher(self.clone(), id.clone(), child, kill_rx);
        spawn_runtime_watchdog(self.clone(), id.clone());

        let snap = snapshot_of(&handle);
        self.emit(AgentEvent::Created {
            snapshot: snap.clone(),
        });
        self.set_status(&id, AgentStatus::Idle);

        // NOTE: we deliberately do NOT broadcast a chat message to existing
        // agents here. Doing so would force every existing agent to spend a
        // turn (and tokens) acknowledging — that's O(n²) cost on a busy team.
        // Instead, every user message piped to an agent gets the current
        // roster prepended silently — see `current_roster_line` below.

        Ok(snap)
    }

    /// Build a small "[TEAM ROSTER]" header that's invisibly prepended to
    /// every user message piped to an agent's stdin. The agent always sees
    /// the live team — without us spending an extra turn per spawn to tell
    /// it. The header is NOT shown in the UI (display_override keeps chat
    /// bubbles clean).
    fn current_roster_line(&self, viewer_id: &str) -> String {
        let reg = self.registry.read();
        let mut names: Vec<String> = reg
            .by_id
            .values()
            .map(|h| {
                if h.id == viewer_id {
                    format!("@{} (you)", h.spec.name)
                } else {
                    format!("@{}", h.spec.name)
                }
            })
            .collect();
        names.sort();
        if names.len() <= 1 {
            String::new()
        } else {
            format!(
                "[TEAM ROSTER NOW: {}] (silent system note; do not acknowledge — just use these exact names when addressing teammates)",
                names.join(", "),
            )
        }
    }

    fn current_workspace_line(&self, handle: &AgentHandle) -> String {
        let cwd = handle.spec.cwd.display().to_string();
        let project = handle
            .spec
            .cwd
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| cwd.clone());
        let branch = std::process::Command::new("git")
            .arg("branch")
            .arg("--show-current")
            .current_dir(&handle.spec.cwd)
            .output()
            .ok()
            .and_then(|out| {
                if !out.status.success() {
                    return None;
                }
                let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if branch.is_empty() {
                    None
                } else {
                    Some(branch)
                }
            })
            .unwrap_or_else(|| "not-a-git-repo-or-detached".to_string());
        format!(
            "[WORKSPACE NOW: project={project}; root={cwd}; git_branch={branch}] (silent system note; do not acknowledge unless asked. Treat all file paths, commands, board tasks, and reviews as belonging to this workspace unless the user explicitly says otherwise.)",
        )
    }

    fn current_mission_context(&self, workspace_id: Option<&str>) -> String {
        let Some(workspace_id) = workspace_id else {
            return String::new();
        };
        let Ok(Some(mission)) = self.db.active_mission_for_workspace(workspace_id) else {
            return String::new();
        };
        format!(
            "[ACTIVE MISSION]\nTitle: {}\nGoal: {}\nDefinition of done: {}\nConstraints: {}",
            mission.title,
            mission.goal,
            mission.definition_of_done.as_deref().unwrap_or("-"),
            mission.constraints.as_deref().unwrap_or("-"),
        )
    }

    fn current_board_context(&self, workspace_id: Option<&str>) -> String {
        let Ok(lines) = self.db.with_conn(|conn| {
            let board_list = boards::list_boards_for_workspace(conn, workspace_id)?;
            let mut out = Vec::new();
            for board in board_list.iter().take(3) {
                let cols = boards::list_columns(conn, board.id)?;
                let cards = boards::list_cards_for_board(conn, board.id)?;
                let col_lines = cols
                    .iter()
                    .map(|c| {
                        let next = if c.allowed_next_column_ids.is_empty() {
                            "any".to_string()
                        } else {
                            c.allowed_next_column_ids
                                .iter()
                                .filter_map(|id| cols.iter().find(|x| x.id == *id))
                                .map(|x| format!("{}#{}", x.title, x.id))
                                .collect::<Vec<_>>()
                                .join(", ")
                        };
                        format!(
                            "{}#{} next=[{}] purpose={}",
                            c.title,
                            c.id,
                            next,
                            c.description.as_deref().unwrap_or("-"),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" | ");
                let card_lines = cards
                    .iter()
                    .take(25)
                    .map(|card| {
                        let lane = cols
                            .iter()
                            .find(|c| c.id == card.column_id)
                            .map(|c| c.title.as_str())
                            .unwrap_or("unknown");
                        format!("{}#{} in {}#{}", card.title, card.id, lane, card.column_id)
                    })
                    .collect::<Vec<_>>()
                    .join(" | ");
                let cards_part = if card_lines.is_empty() {
                    "cards: none".to_string()
                } else {
                    format!("cards: {}", card_lines)
                };
                out.push(format!(
                    "board {}#{}: lanes: {} || {}",
                    board.name, board.id, col_lines, cards_part,
                ));
            }
            Ok(out)
        }) else {
            return String::new();
        };

        if lines.is_empty() {
            return String::new();
        }

        format!(
            "[BOARD CONTEXT NOW]\n{}\n\
             To change the board, include exactly one JSON object in <BOARD_ACTION>...</BOARD_ACTION>.\n\
             Supported actions:\n\
             create_card: {{\"action\":\"create_card\",\"board_id\":1,\"column_id\":2,\"title\":\"Short task\",\"description\":\"Useful context\",\"assignees\":[\"AgentName\"],\"labels\":[\"planning\"]}}\n\
             move_card: {{\"action\":\"move_card\",\"card_id\":1,\"new_column_id\":2,\"new_position\":0}}\n\
             update_card: {{\"action\":\"update_card\",\"card_id\":1,\"title\":\"New title\",\"description\":\"Updated context\",\"assignees\":[\"AgentName\"],\"labels\":[\"testing\"]}}\n\
             delete_card: {{\"action\":\"delete_card\",\"card_id\":1}}\n\
             Use existing ids from BOARD CONTEXT. The app validates lane rules and executes. Wait for [APP BOARD ACTION RESULT] before confirming what succeeded or failed.",
            lines.join("\n")
        )
    }

    pub async fn send(&self, agent_id: &str, message: String) -> Result<()> {
        self.send_internal(agent_id, message, None, None).await
    }

    async fn send_internal_note(&self, agent_id: &str, message: String) -> Result<()> {
        let handle = self
            .registry
            .read()
            .by_id
            .get(agent_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent {} not found", agent_id))?;

        let line = (handle.encode_user)(&message);
        handle
            .stdin_tx
            .send(line)
            .await
            .context("failed to send internal note to agent stdin")?;

        *handle.last_activity.write() = Utc::now();
        self.set_status(agent_id, AgentStatus::Thinking);
        Ok(())
    }

    /// Sends a message to an agent.
    /// - `stdin_message` is what gets piped to the child process.
    /// - `display_override` (optional) is what the UI + DB record as the user
    ///   message. When `None`, the stdin text is used as-is. This lets the
    ///   mention router show a clean "@PM1 asked: <question>" in chat bubbles
    ///   while still piping the full forwarded context to the agent.
    async fn send_internal(
        &self,
        agent_id: &str,
        stdin_message: String,
        display_override: Option<String>,
        from_agent_id: Option<String>,
    ) -> Result<()> {
        let handle = self
            .registry
            .read()
            .by_id
            .get(agent_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent {} not found", agent_id))?;

        // Prepend the current roster as a silent header so the agent always
        // knows who's on the team RIGHT NOW (covers teammates spawned after
        // this one — the system_prompt only had a snapshot at spawn time).
        let roster_header = self.current_roster_line(agent_id);
        let workspace_header = self.current_workspace_line(&handle);
        let mission_context = self.current_mission_context(handle.spec.workspace_id.as_deref());
        let board_context = self.current_board_context(handle.spec.workspace_id.as_deref());
        let mut silent_headers = Vec::new();
        silent_headers.push(workspace_header);
        if !roster_header.is_empty() {
            silent_headers.push(roster_header);
        }
        if !mission_context.is_empty() {
            silent_headers.push(mission_context);
        }
        if !board_context.is_empty() {
            silent_headers.push(board_context);
        }
        let stdin_full = if silent_headers.is_empty() {
            stdin_message.clone()
        } else {
            format!("{}\n\n{}", silent_headers.join("\n\n"), stdin_message)
        };

        let line = (handle.encode_user)(&stdin_full);
        handle
            .stdin_tx
            .send(line)
            .await
            .context("failed to send to agent stdin")?;

        let ts = Utc::now();
        *handle.last_activity.write() = ts;
        *handle.message_count.write() += 1;
        self.set_status(agent_id, AgentStatus::Thinking);

        let display = display_override.unwrap_or(stdin_message);

        let msg_id = uuid::Uuid::new_v4().to_string();
        if let Err(e) = self.db.save_message(
            &msg_id,
            agent_id,
            "user",
            &display,
            from_agent_id.as_deref(),
            ts,
        ) {
            tracing::warn!("db save_message failed: {}", e);
        }
        self.emit(AgentEvent::Message {
            agent_id: agent_id.to_string(),
            role: "user".into(),
            content: display,
            ts,
            from_agent_id,
        });
        Ok(())
    }

    pub async fn kill(&self, agent_id: &str) -> Result<()> {
        let handle = self
            .registry
            .read()
            .by_id
            .get(agent_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent {} not found", agent_id))?;

        // Send kill signal — do NOT take the child or remove from indexes here.
        // The exit watcher is the sole owner; it will do the cleanup.
        if let Some(tx) = handle.kill_tx.lock().await.take() {
            let _ = tx.send(());
        }
        Ok(())
    }

    pub fn id_by_name(&self, name: &str) -> Option<String> {
        self.registry.read().by_name.get(name).cloned()
    }

    fn set_status(&self, agent_id: &str, status: AgentStatus) {
        if let Some(h) = self.registry.read().by_id.get(agent_id) {
            *h.status.write() = status;
        }
        self.emit(AgentEvent::Status {
            agent_id: agent_id.to_string(),
            status,
        });
    }

    fn emit(&self, event: AgentEvent) {
        let _ = self.app.emit(EVENT_CHANNEL, &event);
    }

    /// Remove an agent from both indexes atomically. Returns the removed handle (if any).
    fn remove(&self, agent_id: &str) -> Option<Arc<AgentHandle>> {
        let mut reg = self.registry.write();
        let h = reg.by_id.remove(agent_id)?;
        reg.by_name.remove(&h.spec.name);
        Some(h)
    }
}

fn snapshot_of(h: &AgentHandle) -> AgentSnapshot {
    AgentSnapshot {
        id: h.id.clone(),
        spec: h.spec.clone(),
        status: *h.status.read(),
        session_id: h.session_id.read().clone(),
        last_activity: *h.last_activity.read(),
        usage: h.usage.read().clone(),
        message_count: *h.message_count.read(),
        current_context_tokens: *h.current_context.read(),
    }
}

fn spawn_stdin_pump(mut stdin: ChildStdin, mut rx: mpsc::Receiver<String>) {
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
    });
}

fn spawn_stdout_reader(
    mgr: AgentManager,
    agent_id: String,
    stdout: tokio::process::ChildStdout,
    adapter: Box<dyn AgentAdapter>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            for event in adapter.parse_events(&line) {
                handle_parsed_event(&mgr, &agent_id, event).await;
            }
        }
    });
}

fn spawn_stderr_reader(
    mgr: AgentManager,
    agent_id: String,
    stderr: tokio::process::ChildStderr,
    stderr_tail: Arc<RwLock<Vec<String>>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            {
                let mut tail = stderr_tail.write();
                tail.push(line.clone());
                if tail.len() > 30 {
                    let drop_count = tail.len() - 30;
                    tail.drain(0..drop_count);
                }
            }
            mgr.emit(AgentEvent::Stderr {
                agent_id: agent_id.clone(),
                line,
            });
        }
    });
}

/// Sole owner of the spawned `Child`. Listens for either:
/// - a kill signal (from `AgentManager::kill`) → start_kill + wait
/// - natural exit
/// In both cases performs cleanup: removes from registry, sets status, emits Exit.
fn spawn_exit_watcher(
    mgr: AgentManager,
    agent_id: String,
    mut child: tokio::process::Child,
    kill_rx: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let exit_code = tokio::select! {
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await.ok().and_then(|s| s.code())
            }
            status = child.wait() => {
                status.ok().and_then(|s| s.code())
            }
        };

        let (agent_name, stderr_tail) = mgr
            .registry
            .read()
            .by_id
            .get(&agent_id)
            .map(|h| (Some(h.spec.name.clone()), h.stderr_tail.read().clone()))
            .unwrap_or((None, Vec::new()));
        let severity = if exit_code == Some(0) { "info" } else { "warn" };
        let message = match exit_code {
            Some(0) => "agent process exited cleanly".to_string(),
            Some(code) => format!("agent process exited with code {}", code),
            None => "agent process was stopped or exited without a code".to_string(),
        };
        if let Err(e) = mgr.db.save_audit_event(
            Some(&agent_id),
            "process_exit",
            severity,
            &message,
            Some(&serde_json::json!({
                "agent_name": agent_name.clone(),
                "exit_code": exit_code,
                "stderr_tail": stderr_tail.clone(),
            })),
        ) {
            tracing::warn!("db save_audit_event(process_exit) failed: {}", e);
        }

        // Clean up registry atomically before notifying the UI so that
        // subsequent re-spawn under the same name succeeds.
        mgr.remove(&agent_id);

        // We can't use `set_status` after remove (handle is gone), so emit directly.
        mgr.emit(AgentEvent::Status {
            agent_id: agent_id.clone(),
            status: AgentStatus::Stopped,
        });
        mgr.emit(AgentEvent::Exit {
            agent_id,
            agent_name,
            code: exit_code,
            stderr_tail,
        });
    });
}

async fn handle_parsed_event(mgr: &AgentManager, agent_id: &str, event: ParsedEvent) {
    if let Some(h) = mgr.registry.read().by_id.get(agent_id).cloned() {
        *h.last_activity.write() = Utc::now();
    }

    match event {
        ParsedEvent::SessionInit { session_id } => {
            if let Some(h) = mgr.registry.read().by_id.get(agent_id).cloned() {
                *h.session_id.write() = Some(session_id.clone());
            }
            if let Err(e) = mgr.db.touch_agent_session(agent_id, &session_id) {
                tracing::warn!("db touch_agent_session failed: {}", e);
            }
        }
        ParsedEvent::AssistantText { text } => {
            mgr.set_status(agent_id, AgentStatus::Working);
            let ts = Utc::now();
            detect_and_route_mentions(mgr, agent_id, &text).await;
            detect_and_apply_board_actions(mgr, agent_id, &text).await;
            let display_text = strip_tagged_blocks(&text, "BOARD_ACTION")
                .trim()
                .to_string();
            if !display_text.is_empty() {
                let msg_id = uuid::Uuid::new_v4().to_string();
                if let Err(e) =
                    mgr.db
                        .save_message(&msg_id, agent_id, "assistant", &display_text, None, ts)
                {
                    tracing::warn!("db save_message(assistant) failed: {}", e);
                }
                mgr.emit(AgentEvent::Message {
                    agent_id: agent_id.to_string(),
                    role: "assistant".into(),
                    content: display_text,
                    ts,
                    from_agent_id: None,
                });
            }
        }
        ParsedEvent::ToolUse { tool, input } => {
            mgr.set_status(agent_id, AgentStatus::Working);
            let ts = Utc::now();
            if let Some(h) = mgr.registry.read().by_id.get(agent_id).cloned() {
                *h.tool_calls.write() += 1;
            }
            if let Some(action) = tool.strip_prefix("board.") {
                apply_board_tool_use(mgr, agent_id, action, &input, ts).await;
            }
            let msg_id = uuid::Uuid::new_v4().to_string();
            if let Err(e) = mgr.db.save_tool_use(&msg_id, agent_id, &tool, &input, ts) {
                tracing::warn!("db save_tool_use failed: {}", e);
            }
            mgr.emit(AgentEvent::ToolUse {
                agent_id: agent_id.to_string(),
                tool,
                input,
                ts,
            });
        }
        ParsedEvent::Result {
            usage: delta,
            duration_ms,
        } => {
            let ts = Utc::now();
            if let Err(e) = mgr.db.save_usage(agent_id, &delta, duration_ms, ts) {
                tracing::warn!("db save_usage failed: {}", e);
            }
            if let Some(h) = mgr.registry.read().by_id.get(agent_id).cloned() {
                let snapshot = {
                    let mut acc = h.usage.write();
                    acc.input_tokens += delta.input_tokens;
                    acc.output_tokens += delta.output_tokens;
                    acc.cache_read_tokens += delta.cache_read_tokens;
                    acc.cache_creation_tokens += delta.cache_creation_tokens;
                    acc.total_cost_usd += delta.total_cost_usd;
                    acc.turns += 1;
                    acc.clone()
                };
                // Current context size = this turn's total input tokens
                // (not cumulative). Each turn's input field reflects the
                // entire conversation length sent to the model.
                let ctx =
                    delta.input_tokens + delta.cache_read_tokens + delta.cache_creation_tokens;
                *h.current_context.write() = ctx;
                mgr.emit(AgentEvent::Result {
                    agent_id: agent_id.to_string(),
                    usage: snapshot,
                    duration_ms,
                });
            }
            enforce_reliability_policy(mgr, agent_id).await;
            mgr.set_status(agent_id, AgentStatus::Idle);
        }
    }

    // Update last_seen on any activity (cheap; only one row touched).
    let _ = mgr.db.touch_agent_seen(agent_id);
}

fn spawn_runtime_watchdog(mgr: AgentManager, agent_id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let h = {
                let reg = mgr.registry.read();
                reg.by_id.get(&agent_id).cloned()
            };
            let Some(h) = h else {
                break;
            };
            let max_runtime_ms = h.spec.max_runtime_ms;
            if max_runtime_ms == 0 {
                break;
            }
            let elapsed_ms = (Utc::now() - h.started_at).num_milliseconds().max(0) as u64;
            if elapsed_ms >= max_runtime_ms {
                emit_harness_alert(
                    &mgr,
                    &agent_id,
                    "error",
                    "latency_budget_exceeded",
                    &format!(
                        "runtime exceeded {} ms; stopping agent to avoid a runaway run",
                        max_runtime_ms
                    ),
                    Some(serde_json::json!({
                        "elapsed_ms": elapsed_ms,
                        "max_runtime_ms": max_runtime_ms,
                    })),
                );
                let _ = mgr.kill(&agent_id).await;
                break;
            }
        }
    });
}

async fn enforce_reliability_policy(mgr: &AgentManager, agent_id: &str) {
    let h = {
        let reg = mgr.registry.read();
        reg.by_id.get(agent_id).cloned()
    };
    let Some(h) = h else {
        return;
    };
    let usage = h.usage.read().clone();
    let tool_calls = *h.tool_calls.read();
    let ctx = *h.current_context.read();
    let mut breach: Option<(&str, String, serde_json::Value)> = None;

    if h.spec.max_turns > 0 && usage.turns >= h.spec.max_turns {
        breach = Some((
            "max_turns_exceeded",
            format!("turn budget reached ({}/{})", usage.turns, h.spec.max_turns),
            serde_json::json!({ "turns": usage.turns, "max_turns": h.spec.max_turns }),
        ));
    } else if h.spec.max_tool_calls > 0 && tool_calls >= h.spec.max_tool_calls {
        breach = Some((
            "tool_call_budget_exceeded",
            format!(
                "tool-call budget reached ({}/{})",
                tool_calls, h.spec.max_tool_calls
            ),
            serde_json::json!({ "tool_calls": tool_calls, "max_tool_calls": h.spec.max_tool_calls }),
        ));
    } else if h.spec.max_cost_usd > 0.0 && usage.total_cost_usd >= h.spec.max_cost_usd {
        breach = Some((
            "cost_budget_exceeded",
            format!(
                "cost budget reached (${:.4}/${:.4})",
                usage.total_cost_usd, h.spec.max_cost_usd
            ),
            serde_json::json!({ "cost_usd": usage.total_cost_usd, "max_cost_usd": h.spec.max_cost_usd }),
        ));
    } else if ctx >= 190_000 {
        breach = Some((
            "context_overflow_risk",
            format!("context is near hard limit ({} tokens)", ctx),
            serde_json::json!({ "current_context_tokens": ctx, "hard_context_warning": 190000 }),
        ));
    }

    if let Some((failure_mode, message, data)) = breach {
        emit_harness_alert(mgr, agent_id, "error", failure_mode, &message, Some(data));
        let _ = mgr.kill(agent_id).await;
    }
}

fn emit_harness_alert(
    mgr: &AgentManager,
    agent_id: &str,
    severity: &str,
    failure_mode: &str,
    message: &str,
    data: Option<serde_json::Value>,
) {
    if let Err(e) = mgr.db.save_audit_event(
        Some(agent_id),
        failure_mode,
        severity,
        message,
        data.as_ref(),
    ) {
        tracing::warn!("db save_audit_event failed: {}", e);
    }
    mgr.emit(AgentEvent::HarnessAlert {
        agent_id: agent_id.to_string(),
        severity: severity.to_string(),
        failure_mode: failure_mode.to_string(),
        message: message.to_string(),
        ts: Utc::now(),
    });
}

/// Append a live team-roster section to the agent's system prompt so it knows
/// the ACTUAL names of its teammates (which the user may have customized,
/// e.g. "PM1" / "PM2"). Includes the new agent's own name so it can refer to
/// itself accurately.
fn inject_team_roster(spec: &AgentSpec, live_roster: &[String]) -> AgentSpec {
    let mut all_names: Vec<String> = live_roster.to_vec();
    if !all_names.iter().any(|n| n == &spec.name) {
        all_names.push(spec.name.clone());
    }
    all_names.sort();

    let roster_line = if all_names.len() <= 1 {
        format!(
            "\n\n--- ACTIVE TEAM ROSTER (at your spawn time) ---\nYou are the first agent on the team — there are no other teammates yet. Ask the user to spawn additional roles when needed.\nYour own name: @{}\n",
            spec.name,
        )
    } else {
        let others: Vec<String> = all_names
            .iter()
            .filter(|n| **n != spec.name)
            .map(|n| format!("@{}", n))
            .collect();
        format!(
            "\n\n--- ACTIVE TEAM ROSTER (at your spawn time) ---\nYou are: @{}\nTeammates available right now: {}\n(More teammates may be spawned later — when in doubt, ask the user. To address a teammate, write `@TheirExactName <message>` on a new line.)\n",
            spec.name,
            others.join(" "),
        )
    };

    let collaboration_protocol = "\n\n--- COLLABORATION DISCIPLINE ---\nUse @mentions only when you need concrete work, a blocker answer, review feedback, or a handoff from that teammate. Do not @mention for greetings, thanks, jokes, food/social chat, status noise, or open-ended prompts like \"anything else?\". When your assigned work is done, or there is no concrete next action, report the result to the user once and stop. If the user asks an off-topic/social question, answer briefly without involving teammates.\n";

    let board_protocol = "\n\n--- BOARD ACTION PROTOCOL ---\nWhen you discover useful follow-up work, planning steps, bugs, subtasks, or status changes, you may ask the app to update the board. Use exactly one JSON object inside <BOARD_ACTION>...</BOARD_ACTION>. Supported: create_card, move_card, update_card, delete_card. Use board/card/column ids from BOARD CONTEXT. Keep card titles short and actionable. The app validates lane rules and will report success/failure.\n";

    let new_prompt = match &spec.system_prompt {
        Some(p) if !p.trim().is_empty() => Some(format!(
            "{}{}{}{}",
            p.trim_end(),
            roster_line,
            collaboration_protocol,
            board_protocol
        )),
        _ => Some(format!(
            "{}{}{}",
            roster_line.trim_start(),
            collaboration_protocol,
            board_protocol
        )),
    };

    AgentSpec {
        system_prompt: new_prompt,
        ..spec.clone()
    }
}

#[derive(Debug, Deserialize)]
struct BoardActionRequest {
    action: String,
    #[serde(default)]
    board_id: Option<i64>,
    #[serde(default)]
    board_name: Option<String>,
    #[serde(default)]
    column_id: Option<i64>,
    #[serde(default)]
    lane: Option<String>,
    #[serde(default)]
    column: Option<String>,
    #[serde(default)]
    card_id: Option<i64>,
    #[serde(default)]
    new_column_id: Option<i64>,
    #[serde(default)]
    to_lane: Option<String>,
    #[serde(default)]
    to_column: Option<String>,
    #[serde(default)]
    new_position: Option<usize>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    assignees: Vec<String>,
    #[serde(default)]
    labels: Vec<String>,
}

async fn detect_and_apply_board_actions(mgr: &AgentManager, agent_id: &str, text: &str) {
    for raw in extract_tagged_blocks(text, "BOARD_ACTION")
        .into_iter()
        .take(5)
    {
        let ts = Utc::now();
        let parsed = serde_json::from_str::<BoardActionRequest>(&raw);
        let (action, result) = match parsed {
            Ok(req) => {
                let action = req.action.clone();
                (action, apply_board_action(mgr, &req))
            }
            Err(e) => (
                "board_action".to_string(),
                Err(anyhow!("invalid BOARD_ACTION json: {}", e)),
            ),
        };

        match result {
            Ok(card) => {
                let msg = match action.as_str() {
                    "create_card" => format!("created card #{}: {}", card.id, card.title),
                    "move_card" => format!("moved card #{}: {}", card.id, card.title),
                    "update_card" => format!("updated card #{}: {}", card.id, card.title),
                    "delete_card" => format!("deleted card #{}: {}", card.id, card.title),
                    _ => format!("applied {} to card #{}: {}", action, card.id, card.title),
                };
                let _ = mgr.db.save_tool_use(
                    &uuid::Uuid::new_v4().to_string(),
                    agent_id,
                    &format!("board.{}", action),
                    &serde_json::json!({
                        "card_id": card.id,
                        "column_id": card.column_id,
                        "title": card.title,
                    }),
                    ts,
                );
                send_board_action_result(mgr, agent_id, &action, true, &msg, Some(&card)).await;
                mgr.emit(AgentEvent::BoardAction {
                    agent_id: agent_id.to_string(),
                    action,
                    ok: true,
                    message: msg,
                    card: Some(card),
                    ts,
                });
            }
            Err(e) => {
                let msg = e.to_string();
                send_board_action_result(mgr, agent_id, &action, false, &msg, None).await;
                mgr.emit(AgentEvent::BoardAction {
                    agent_id: agent_id.to_string(),
                    action,
                    ok: false,
                    message: msg,
                    card: None,
                    ts,
                });
            }
        }
    }
}

async fn apply_board_tool_use(
    mgr: &AgentManager,
    agent_id: &str,
    action: &str,
    input: &serde_json::Value,
    ts: chrono::DateTime<Utc>,
) {
    let req = board_action_from_tool_input(action, input);
    match apply_board_action(mgr, &req) {
        Ok(card) => {
            let msg = match action {
                "create_card" => format!("created card #{}: {}", card.id, card.title),
                "move_card" => format!("moved card #{}: {}", card.id, card.title),
                "update_card" => format!("updated card #{}: {}", card.id, card.title),
                "delete_card" => format!("deleted card #{}: {}", card.id, card.title),
                _ => format!(
                    "applied board.{} to card #{}: {}",
                    action, card.id, card.title
                ),
            };
            send_board_action_result(mgr, agent_id, action, true, &msg, Some(&card)).await;
            mgr.emit(AgentEvent::BoardAction {
                agent_id: agent_id.to_string(),
                action: action.to_string(),
                ok: true,
                message: msg,
                card: Some(card),
                ts,
            });
        }
        Err(e) => {
            let msg = e.to_string();
            send_board_action_result(mgr, agent_id, action, false, &msg, None).await;
            mgr.emit(AgentEvent::BoardAction {
                agent_id: agent_id.to_string(),
                action: action.to_string(),
                ok: false,
                message: msg,
                card: None,
                ts,
            });
        }
    }
}

async fn send_board_action_result(
    mgr: &AgentManager,
    agent_id: &str,
    action: &str,
    ok: bool,
    message: &str,
    card: Option<&BoardCard>,
) {
    let card_context = card
        .map(|card| {
            format!(
                "card_id={}\ncolumn_id={}\ntitle={}",
                card.id, card.column_id, card.title
            )
        })
        .unwrap_or_else(|| "card_id=unknown".to_string());
    let note = format!(
        "[APP BOARD ACTION RESULT]\n\
         action={}\n\
         status={}\n\
         {}\n\
         message={}\n\n\
         The app has already attempted this board action. When you reply to the user, confirm from this result: list what is done, what failed, and what remains unknown. Do not issue another board action because of this result unless the user asks for more.",
        action,
        if ok { "ok" } else { "failed" },
        card_context,
        message
    );

    if let Err(e) = mgr.send_internal_note(agent_id, note).await {
        tracing::warn!(
            "failed to send board action result to agent {}: {}",
            agent_id,
            e
        );
    }
}

fn board_action_from_tool_input(action: &str, input: &serde_json::Value) -> BoardActionRequest {
    let get_i64 = |keys: &[&str]| -> Option<i64> {
        keys.iter().find_map(|key| {
            input
                .get(*key)
                .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        })
    };
    let get_usize = |keys: &[&str]| -> Option<usize> {
        keys.iter().find_map(|key| {
            input.get(*key).and_then(|v| {
                v.as_u64()
                    .map(|n| n as usize)
                    .or_else(|| v.as_str()?.parse::<usize>().ok())
            })
        })
    };
    let get_string = |keys: &[&str]| -> Option<String> {
        keys.iter().find_map(|key| {
            input
                .get(*key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        })
    };
    let get_vec = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .find_map(|key| input.get(*key))
            .and_then(|v| {
                if let Some(arr) = v.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(|x| x.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(ToOwned::to_owned)
                            .collect(),
                    )
                } else {
                    v.as_str().map(|s| {
                        s.split(',')
                            .map(str::trim)
                            .filter(|x| !x.is_empty())
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                }
            })
            .unwrap_or_default()
    };

    BoardActionRequest {
        action: action.to_string(),
        board_id: get_i64(&["board_id", "boardId"]),
        board_name: get_string(&["board_name", "boardName", "board"]),
        column_id: get_i64(&["column_id", "columnId"]),
        lane: get_string(&["lane"]),
        column: get_string(&["column"]),
        card_id: get_i64(&["card_id", "cardId", "id"]),
        new_column_id: get_i64(&[
            "new_column_id",
            "newColumnId",
            "to_column_id",
            "toColumnId",
            "target_column_id",
            "targetColumnId",
        ]),
        to_lane: get_string(&["to_lane", "toLane", "target_lane", "targetLane"]),
        to_column: get_string(&["to_column", "toColumn", "target_column", "targetColumn"]),
        new_position: get_usize(&["new_position", "newPosition", "position"]),
        title: get_string(&["title", "name"]),
        description: get_string(&["description", "body", "notes"]),
        assignees: get_vec(&["assignees", "assignee"]),
        labels: get_vec(&["labels", "label"]),
    }
}

fn apply_board_action(mgr: &AgentManager, req: &BoardActionRequest) -> Result<BoardCard> {
    mgr.db.with_conn(|conn| match req.action.as_str() {
        "create_card" => {
            let title = req
                .title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow!("card title is required"))?;
            if title.chars().count() > 160 {
                return Err(anyhow!("card title is too long"));
            }
            let board_id = resolve_board_id(conn, req)?;
            let column_id = resolve_column_id(
                conn,
                req,
                board_id,
                req.column_id,
                req.lane
                    .as_deref()
                    .or(req.column.as_deref())
                    .or(Some("Backlog")),
            )?;
            let input = CardInput {
                title: title.to_string(),
                description: req.description.clone(),
                assignees: req.assignees.clone(),
                labels: req.labels.clone(),
            };
            boards::create_card(conn, column_id, &input)
        }
        "move_card" => {
            let card_id = req.card_id.ok_or_else(|| anyhow!("card_id is required"))?;
            let card = boards::get_card(conn, card_id)?;
            let from_col = boards::get_column(conn, card.column_id)?;
            let to_col_id = resolve_column_id(
                conn,
                req,
                from_col.board_id,
                req.new_column_id.or(req.column_id),
                req.to_lane
                    .as_deref()
                    .or(req.to_column.as_deref())
                    .or(req.lane.as_deref())
                    .or(req.column.as_deref()),
            )?;
            validate_card_transition(conn, card.column_id, to_col_id)?;
            boards::move_card(conn, card_id, to_col_id, req.new_position.unwrap_or(0))
        }
        "update_card" => {
            let card_id = req.card_id.ok_or_else(|| anyhow!("card_id is required"))?;
            let current = boards::get_card(conn, card_id)?;
            let title = req
                .title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&current.title);
            if title.chars().count() > 160 {
                return Err(anyhow!("card title is too long"));
            }
            let input = CardInput {
                title: title.to_string(),
                description: req.description.clone().or(current.description),
                assignees: if req.assignees.is_empty() {
                    current.assignees
                } else {
                    req.assignees.clone()
                },
                labels: if req.labels.is_empty() {
                    current.labels
                } else {
                    req.labels.clone()
                },
            };
            boards::update_card(conn, card_id, &input)
        }
        "delete_card" => {
            let card_id = req.card_id.ok_or_else(|| anyhow!("card_id is required"))?;
            let current = boards::get_card(conn, card_id)?;
            boards::delete_card(conn, card_id)?;
            Ok(current)
        }
        other => Err(anyhow!("unsupported board action '{}'", other)),
    })
}

fn resolve_board_id(conn: &rusqlite::Connection, req: &BoardActionRequest) -> Result<i64> {
    if let Some(id) = req.board_id {
        return Ok(id);
    }
    let board_list = boards::list_boards(conn)?;
    if let Some(name) = req.board_name.as_deref() {
        return board_list
            .iter()
            .find(|b| b.name.eq_ignore_ascii_case(name))
            .map(|b| b.id)
            .ok_or_else(|| anyhow!("board '{}' not found", name));
    }
    board_list
        .first()
        .map(|b| b.id)
        .ok_or_else(|| anyhow!("no boards exist yet"))
}

fn resolve_column_id(
    conn: &rusqlite::Connection,
    _req: &BoardActionRequest,
    board_id: i64,
    explicit_id: Option<i64>,
    lane_name: Option<&str>,
) -> Result<i64> {
    if let Some(id) = explicit_id {
        let col = boards::get_column(conn, id)?;
        if col.board_id != board_id {
            return Err(anyhow!("column #{} is not on board #{}", id, board_id));
        }
        return Ok(id);
    }
    let lane = lane_name.ok_or_else(|| anyhow!("target lane or column id is required"))?;
    boards::find_column_by_title(conn, board_id, lane)?
        .map(|c| c.id)
        .ok_or_else(|| anyhow!("lane '{}' not found on board #{}", lane, board_id))
}

fn validate_card_transition(
    conn: &rusqlite::Connection,
    from_col_id: i64,
    to_col_id: i64,
) -> Result<()> {
    if from_col_id == to_col_id {
        return Ok(());
    }
    let from = boards::get_column(conn, from_col_id)?;
    let to = boards::get_column(conn, to_col_id)?;
    if from.board_id != to.board_id {
        return Err(anyhow!("cannot move cards across boards"));
    }
    if !workflow_reaches(conn, from.board_id, from_col_id, to_col_id)? {
        return Err(anyhow!(
            "lane rule blocks moving from '{}' to '{}'",
            from.title,
            to.title,
        ));
    }
    Ok(())
}

fn workflow_reaches(
    conn: &rusqlite::Connection,
    board_id: i64,
    from_col_id: i64,
    to_col_id: i64,
) -> Result<bool> {
    use std::collections::{HashSet, VecDeque};

    let columns = boards::list_columns(conn, board_id)?;
    let by_id = columns
        .iter()
        .map(|c| (c.id, c))
        .collect::<std::collections::HashMap<_, _>>();
    if !by_id.contains_key(&from_col_id) || !by_id.contains_key(&to_col_id) {
        return Ok(false);
    }

    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([from_col_id]);
    while let Some(id) = queue.pop_front() {
        if id == to_col_id {
            return Ok(true);
        }
        if !seen.insert(id) {
            continue;
        }
        let Some(col) = by_id.get(&id) else {
            continue;
        };
        let next_ids: Vec<i64> = if col.allowed_next_column_ids.is_empty() {
            columns
                .iter()
                .filter(|c| c.id != id)
                .map(|c| c.id)
                .collect()
        } else {
            col.allowed_next_column_ids.clone()
        };
        for next in next_ids {
            if !seen.contains(&next) {
                queue.push_back(next);
            }
        }
    }
    Ok(false)
}

fn extract_tagged_blocks(text: &str, tag: &str) -> Vec<String> {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(&start_tag) {
        let after_start = &rest[start + start_tag.len()..];
        let Some(end) = after_start.find(&end_tag) else {
            break;
        };
        let body = after_start[..end].trim();
        if !body.is_empty() {
            out.push(body.to_string());
        }
        rest = &after_start[end + end_tag.len()..];
    }
    out
}

fn strip_tagged_blocks(text: &str, tag: &str) -> String {
    let start_tag = format!("<{}>", tag);
    let end_tag = format!("</{}>", tag);
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(&start_tag) {
        out.push_str(&rest[..start]);
        let after_start = &rest[start + start_tag.len()..];
        let Some(end) = after_start.find(&end_tag) else {
            rest = "";
            break;
        };
        rest = &after_start[end + end_tag.len()..];
    }
    out.push_str(rest);
    out
}

/// Look for `@AgentName` mentions in assistant text and route them to the
/// target agent(s). When forwarding, we include the SOURCE agent's full reply
/// as context so the target sees the conversation around the question, not
/// just the bare line — otherwise teammates only see decontextualized snippets
/// and have to ask "what are we talking about?".
async fn detect_and_route_mentions(mgr: &AgentManager, from_id: &str, text: &str) {
    if !text.contains('@') {
        return;
    }

    // Resolve source agent's mention policy + display name once.
    let (allow_mentions, allowlist, from_name) = match mgr.registry.read().by_id.get(from_id) {
        Some(h) => (
            h.spec.allow_mentions,
            h.spec.mention_allowlist.clone(),
            h.spec.name.clone(),
        ),
        None => return,
    };

    // Group all `@Name <msg>` lines by target so a single agent receives ONE
    // forwarded message even if it was addressed multiple times in the same
    // reply.
    let mut by_target: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (to_name, msg) in find_mentions(text) {
        // --- Policy enforcement ---
        if !allow_mentions {
            mgr.emit(AgentEvent::MentionBlocked {
                from_agent_id: from_id.to_string(),
                to_agent_name: to_name,
                reason: "source agent has allow_mentions=false".into(),
            });
            continue;
        }
        if !allowlist.is_empty() && !allowlist.iter().any(|n| n == &to_name) {
            mgr.emit(AgentEvent::MentionBlocked {
                from_agent_id: from_id.to_string(),
                to_agent_name: to_name.clone(),
                reason: format!("'{}' is not in source agent's mention allowlist", to_name),
            });
            continue;
        }
        if is_low_signal_mention(&msg) {
            mgr.emit(AgentEvent::MentionBlocked {
                from_agent_id: from_id.to_string(),
                to_agent_name: to_name.clone(),
                reason: "mention looks like social/off-task chatter".into(),
            });
            continue;
        }
        by_target.entry(to_name).or_default().push(msg);
    }

    if by_target.is_empty() {
        return;
    }

    // Strip the `@mention` lines from the assistant text to form the context
    // body (everything the source said EXCEPT the lines specifically directed
    // at someone). If that body is trivial we skip the wrapper and just
    // forward the bare question (keeps short chitchat snappy).
    let context_body = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('@'))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    let has_context = context_body.chars().count() > 30;

    for (to_name, msgs) in by_target {
        let to_id = match mgr.id_by_name(&to_name) {
            Some(id) if id != from_id => id,
            _ => continue,
        };

        let combined_q = msgs.join("\n\n");
        let forwarded = if has_context {
            format!(
                "[FORWARDED FROM @{from}]\n\n\
                 Earlier in @{from}'s reply (context for you):\n\
                 -----\n\
                 {ctx}\n\
                 -----\n\n\
                 @{from} addressed YOU (@{to}) directly with:\n\
                 {q}\n\n\
                 (Reply naturally. To talk back to @{from} or anyone else, write `@TheirName <message>` on a new line.)",
                from = from_name,
                to = to_name,
                ctx = context_body,
                q = combined_q,
            )
        } else {
            // Short/bare mention — keep it lightweight.
            combined_q.clone()
        };

        mgr.emit(AgentEvent::Mention {
            from_agent_id: from_id.to_string(),
            to_agent_name: to_name.clone(),
            to_agent_id: Some(to_id.clone()),
            message: combined_q.clone(),
        });
        // stdin gets the full contextual wrapper; UI bubble + DB record only
        // the bare question (the source's prior reply is already visible in
        // the source's own chat panel for anyone curious).
        let _ = mgr
            .send_internal(
                &to_id,
                forwarded,
                Some(combined_q),
                Some(from_id.to_string()),
            )
            .await;
    }
}

/// Parse `@Name <rest of line>` occurrences. Returns `(name, message)` per line.
fn find_mentions(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('@') {
            continue;
        }
        let rest = &trimmed[1..];
        let name_end = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(rest.len());
        if name_end == 0 {
            continue;
        }
        let to_name = rest[..name_end].to_string();
        let msg = rest[name_end..]
            .trim_start_matches([':', ' ', ','])
            .trim()
            .to_string();
        if msg.is_empty() {
            continue;
        }
        out.push((to_name, msg));
    }
    out
}

fn is_low_signal_mention(msg: &str) -> bool {
    let s = msg.trim().to_lowercase();
    if s.chars().count() <= 3 {
        return true;
    }

    // Conservative guard: block obvious chatter loops while keeping normal
    // task handoffs, blockers, and review requests routable.
    let exact_phrases = [
        "thanks",
        "thank you",
        "ok",
        "okay",
        "got it",
        "roger",
        "รับทราบ",
        "โอเค",
        "ขอบคุณ",
    ];
    if exact_phrases.iter().any(|p| s == *p) {
        return true;
    }

    let chatter_phrases = [
        "anything else",
        "anything more",
        "want to eat",
        "what do you want to eat",
        "what would you like to eat",
        "eat anything",
        "haha",
        "lol",
        "อยากกิน",
        "กินอะไร",
        "กินไร",
        "มีอะไรเพิ่ม",
        "มีอะไรอีก",
        "เพิ่มเติมไหม",
        "ต้องการอะไรเพิ่ม",
        "สวัสดี",
        "ฮ่า",
        "555",
    ];
    chatter_phrases.iter().any(|p| s.contains(p))
}
