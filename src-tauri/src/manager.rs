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
use crate::agent::{AgentEvent, AgentSnapshot, AgentSpec, AgentStatus, AgentUsage};

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
}

#[derive(Default)]
struct Registry {
    by_id: HashMap<String, Arc<AgentHandle>>,
    by_name: HashMap<String, String>, // name -> id
}

impl AgentManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            registry: Arc::new(RwLock::new(Registry::default())),
            app,
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
        // Reject duplicate name BEFORE spawning, atomically.
        {
            let reg = self.registry.read();
            if reg.by_name.contains_key(&spec.name) {
                return Err(anyhow!("agent name '{}' already exists", spec.name));
            }
        }

        let adapter = make_adapter(spec.vendor.as_deref())?;
        let id = uuid::Uuid::new_v4().to_string();

        let mut cmd = adapter.build_command(&spec)?;
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

        spawn_stdin_pump(stdin, stdin_rx);
        spawn_stdout_reader(self.clone(), id.clone(), stdout, adapter);
        spawn_stderr_reader(self.clone(), id.clone(), stderr);
        spawn_exit_watcher(self.clone(), id.clone(), child, kill_rx);

        let snap = snapshot_of(&handle);
        self.emit(AgentEvent::Created { snapshot: snap.clone() });
        self.set_status(&id, AgentStatus::Idle);
        Ok(snap)
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

        *handle.last_activity.write() = Utc::now();
        *handle.message_count.write() += 1;
        self.set_status(agent_id, AgentStatus::Thinking);

        self.emit(AgentEvent::Message {
            agent_id: agent_id.to_string(),
            role: "user".into(),
            content: message,
            ts: Utc::now(),
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
                *h.session_id.write() = Some(session_id);
            }
        }
        ParsedEvent::AssistantText { text } => {
            mgr.set_status(agent_id, AgentStatus::Working);
            detect_and_route_mentions(mgr, agent_id, &text).await;
            mgr.emit(AgentEvent::Message {
                agent_id: agent_id.to_string(),
                role: "assistant".into(),
                content: text,
                ts: Utc::now(),
                from_agent_id: None,
            });
        }
        ParsedEvent::ToolUse { tool, input } => {
            mgr.set_status(agent_id, AgentStatus::Working);
            mgr.emit(AgentEvent::ToolUse {
                agent_id: agent_id.to_string(),
                tool,
                input,
                ts: Utc::now(),
            });
        }
        ParsedEvent::Result { usage: delta, duration_ms } => {
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
