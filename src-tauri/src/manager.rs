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
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::adapter::{make_adapter, AgentAdapter, ParsedEvent};
use crate::agent::{AgentEvent, AgentSnapshot, AgentSpec, AgentStatus, AgentUsage, ResumeOptions};
use crate::db::Db;

const EVENT_CHANNEL: &str = "agent://event";

struct AgentHandle {
    id: String,
    spec: AgentSpec,
    status: Arc<RwLock<AgentStatus>>,
    session_id: Arc<RwLock<Option<String>>>,
    usage: Arc<RwLock<AgentUsage>>,
    message_count: Arc<RwLock<u64>>,
    stdin_tx: mpsc::Sender<String>,
    /// Encoder for outbound user messages (vendor-specific).
    encode_user: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// Send `()` to ask the exit watcher to kill the child. Only one kill request
    /// is honored — the option is consumed on first use.
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
    last_activity: Arc<RwLock<chrono::DateTime<Utc>>>,
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
            stdin_tx,
            encode_user,
            kill_tx: Mutex::new(Some(kill_tx)),
            last_activity: Arc::new(RwLock::new(Utc::now())),
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
        spawn_stderr_reader(self.clone(), id.clone(), stderr);
        spawn_exit_watcher(self.clone(), id.clone(), child, kill_rx);

        let snap = snapshot_of(&handle);
        self.emit(AgentEvent::Created { snapshot: snap.clone() });
        self.set_status(&id, AgentStatus::Idle);

        // Broadcast a brief roster update to every existing teammate so they
        // learn about the new arrival even though their initial system prompt
        // was a snapshot from before this spawn.
        if !live_roster.is_empty() {
            self.broadcast_team_update(&live_roster, &spec.name, &spec.role).await;
        }

        Ok(snap)
    }

    async fn broadcast_team_update(
        &self,
        existing_names: &[String],
        new_name: &str,
        new_role: &str,
    ) {
        let notice = format!(
            "[TEAM ROSTER UPDATE] A new teammate has joined: @{} — {}. \
             You can now address them with @{}. \
             (Acknowledge briefly only if you have something useful to say; \
             otherwise just note it and wait for the user.)",
            new_name, new_role, new_name,
        );
        for name in existing_names {
            if let Some(id) = self.id_by_name(name) {
                if let Err(e) = self.send_internal(&id, notice.clone(), None).await {
                    tracing::warn!("team update broadcast to {} failed: {}", name, e);
                }
            }
        }
    }

    pub async fn send(&self, agent_id: &str, message: String) -> Result<()> {
        self.send_internal(agent_id, message, None).await
    }

    async fn send_internal(
        &self,
        agent_id: &str,
        message: String,
        from_agent_id: Option<String>,
    ) -> Result<()> {
        let handle = self
            .registry
            .read()
            .by_id
            .get(agent_id)
            .cloned()
            .ok_or_else(|| anyhow!("agent {} not found", agent_id))?;

        let line = (handle.encode_user)(&message);
        handle.stdin_tx.send(line).await
            .context("failed to send to agent stdin")?;

        let ts = Utc::now();
        *handle.last_activity.write() = ts;
        *handle.message_count.write() += 1;
        self.set_status(agent_id, AgentStatus::Thinking);

        // Persist + emit with same id.
        let msg_id = uuid::Uuid::new_v4().to_string();
        if let Err(e) = self.db.save_message(
            &msg_id,
            agent_id,
            "user",
            &message,
            from_agent_id.as_deref(),
            ts,
        ) {
            tracing::warn!("db save_message failed: {}", e);
        }
        self.emit(AgentEvent::Message {
            agent_id: agent_id.to_string(),
            role: "user".into(),
            content: message,
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
    }
}

fn spawn_stdin_pump(mut stdin: ChildStdin, mut rx: mpsc::Receiver<String>) {
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() { break; }
            if stdin.flush().await.is_err() { break; }
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
            handle_parsed_event(&mgr, &agent_id, adapter.parse_event(&line)).await;
        }
    });
}

fn spawn_stderr_reader(mgr: AgentManager, agent_id: String, stderr: tokio::process::ChildStderr) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            mgr.emit(AgentEvent::Stderr { agent_id: agent_id.clone(), line });
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

        // Clean up registry atomically before notifying the UI so that
        // subsequent re-spawn under the same name succeeds.
        mgr.remove(&agent_id);

        // We can't use `set_status` after remove (handle is gone), so emit directly.
        mgr.emit(AgentEvent::Status {
            agent_id: agent_id.clone(),
            status: AgentStatus::Stopped,
        });
        mgr.emit(AgentEvent::Exit { agent_id, code: exit_code });
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

            let msg_id = uuid::Uuid::new_v4().to_string();
            if let Err(e) = mgr.db.save_message(&msg_id, agent_id, "assistant", &text, None, ts) {
                tracing::warn!("db save_message(assistant) failed: {}", e);
            }
            mgr.emit(AgentEvent::Message {
                agent_id: agent_id.to_string(),
                role: "assistant".into(),
                content: text,
                ts,
                from_agent_id: None,
            });
        }
        ParsedEvent::ToolUse { tool, input } => {
            mgr.set_status(agent_id, AgentStatus::Working);
            let ts = Utc::now();
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
        ParsedEvent::Result { usage: delta, duration_ms } => {
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
                mgr.emit(AgentEvent::Result {
                    agent_id: agent_id.to_string(),
                    usage: snapshot,
                    duration_ms,
                });
            }
            mgr.set_status(agent_id, AgentStatus::Idle);
        }
        ParsedEvent::Other => {}
    }

    // Update last_seen on any activity (cheap; only one row touched).
    let _ = mgr.db.touch_agent_seen(agent_id);
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

    let new_prompt = match &spec.system_prompt {
        Some(p) if !p.trim().is_empty() => Some(format!("{}{}", p.trim_end(), roster_line)),
        _ => Some(roster_line.trim_start().to_string()),
    };

    AgentSpec {
        system_prompt: new_prompt,
        ..spec.clone()
    }
}

/// Look for `@AgentName` mentions in assistant text and route the trailing
/// message segment to that agent — but only if the SOURCE agent is permitted
/// to mention others, and the TARGET is in the allowlist (if any).
async fn detect_and_route_mentions(mgr: &AgentManager, from_id: &str, text: &str) {
    if !text.contains('@') {
        return;
    }

    // Resolve source agent's mention policy snapshot once.
    let (allow_mentions, allowlist) = match mgr.registry.read().by_id.get(from_id) {
        Some(h) => (h.spec.allow_mentions, h.spec.mention_allowlist.clone()),
        None => return,
    };

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
        let to_name = &rest[..name_end];
        let msg = rest[name_end..].trim_start_matches([':', ' ', ',']).trim();
        if msg.is_empty() {
            continue;
        }

        // --- Policy enforcement ---
        if !allow_mentions {
            mgr.emit(AgentEvent::MentionBlocked {
                from_agent_id: from_id.to_string(),
                to_agent_name: to_name.to_string(),
                reason: "source agent has allow_mentions=false".into(),
            });
            continue;
        }
        if !allowlist.is_empty() && !allowlist.iter().any(|n| n == to_name) {
            mgr.emit(AgentEvent::MentionBlocked {
                from_agent_id: from_id.to_string(),
                to_agent_name: to_name.to_string(),
                reason: format!("'{}' is not in source agent's mention allowlist", to_name),
            });
            continue;
        }

        let to_id = match mgr.id_by_name(to_name) {
            Some(id) if id != from_id => id,
            _ => continue,
        };

        mgr.emit(AgentEvent::Mention {
            from_agent_id: from_id.to_string(),
            to_agent_name: to_name.to_string(),
            to_agent_id: Some(to_id.clone()),
            message: msg.to_string(),
        });
        let _ = mgr
            .send_internal(&to_id, msg.to_string(), Some(from_id.to_string()))
            .await;
    }
}
