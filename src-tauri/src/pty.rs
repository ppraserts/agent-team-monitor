//! PTY pane manager.
//!
//! - Single owner of the spawned `Child` is the exit watcher thread.
//! - `kill()` requests termination via a `Child::killer()` from `portable-pty`,
//!   which works on Windows ConPTY (where dropping the master alone is NOT
//!   guaranteed to terminate the child).
//! - Cleanup (registry remove + frontend `pty://exit` event) always fires
//!   from the exit watcher — whether the child died naturally or was killed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::adapter::ClaudeStreamJsonAdapter;

const PTY_OUTPUT: &str = "pty://output";
const PTY_EXIT: &str = "pty://exit";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySpec {
    pub title: String,
    pub cwd: PathBuf,
    #[serde(default)]
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

#[derive(Debug, Clone, Serialize)]
pub struct PtySnapshot {
    pub id: String,
    pub title: String,
    pub cwd: PathBuf,
    pub workspace_id: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

struct PtyHandle {
    snapshot: PtySnapshot,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// `ChildKiller` from portable-pty — works on Windows ConPTY too.
    /// Wrapped in Mutex<Option<…>> so kill() can take it once.
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
}

#[derive(Clone)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, Arc<PtyHandle>>>>,
    app: AppHandle,
}

#[derive(Debug, Clone, Serialize)]
struct PtyOutputEvent {
    pty_id: String,
    data_b64: String,
}

#[derive(Debug, Clone, Serialize)]
struct PtyExitEvent {
    pty_id: String,
    code: Option<i32>,
}

impl PtyManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            app,
        }
    }

    pub fn list(&self) -> Vec<PtySnapshot> {
        self.inner
            .lock()
            .values()
            .map(|h| h.snapshot.clone())
            .collect()
    }

    pub fn spawn(&self, spec: PtySpec) -> Result<PtySnapshot> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let program = spec.program.clone().unwrap_or_else(|| {
            ClaudeStreamJsonAdapter::which().unwrap_or_else(|_| "claude".to_string())
        });

        let mut cmd = CommandBuilder::new(&program);
        for a in &spec.args {
            cmd.arg(a);
        }
        cmd.cwd(&spec.cwd);
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawn {} failed", program))?;
        drop(pair.slave);

        let killer = child.clone_killer();

        let id = uuid::Uuid::new_v4().to_string();
        let snapshot = PtySnapshot {
            id: id.clone(),
            title: spec.title.clone(),
            cwd: spec.cwd.clone(),
            workspace_id: spec.workspace_id.clone(),
            cols: spec.cols,
            rows: spec.rows,
        };

        let writer = pair
            .master
            .take_writer()
            .context("take_writer on master pty failed")?;
        let master = Arc::new(Mutex::new(pair.master));

        let handle = Arc::new(PtyHandle {
            snapshot: snapshot.clone(),
            master: master.clone(),
            writer: Arc::new(Mutex::new(writer)),
            killer: Mutex::new(Some(killer)),
        });

        self.inner.lock().insert(id.clone(), handle.clone());

        // Reader thread (blocking I/O).
        let app = self.app.clone();
        let id_for_reader = id.clone();
        let master_for_reader = master.clone();
        std::thread::spawn(move || {
            let reader_result = master_for_reader.lock().try_clone_reader();
            let mut reader = match reader_result {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("clone_reader failed: {}", e);
                    return;
                }
            };
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        use base64::Engine;
                        let data_b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit(
                            PTY_OUTPUT,
                            PtyOutputEvent {
                                pty_id: id_for_reader.clone(),
                                data_b64,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        // Exit watcher: sole owner of `child`. Cleans registry + emits exit on either
        // natural exit or kill().
        let app2 = self.app.clone();
        let id_for_exit = id.clone();
        let inner_map = self.inner.clone();
        std::thread::spawn(move || {
            let status = child.wait().ok();
            let code = status.map(|s| s.exit_code() as i32);
            inner_map.lock().remove(&id_for_exit);
            let _ = app2.emit(
                PTY_EXIT,
                PtyExitEvent {
                    pty_id: id_for_exit,
                    code,
                },
            );
        });

        Ok(snapshot)
    }

    pub fn write(&self, pty_id: &str, data: &[u8]) -> Result<()> {
        let handle = self
            .inner
            .lock()
            .get(pty_id)
            .cloned()
            .ok_or_else(|| anyhow!("pty {} not found", pty_id))?;
        let mut w = handle.writer.lock();
        w.write_all(data).context("pty write failed")?;
        w.flush().ok();
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<()> {
        let handle = self
            .inner
            .lock()
            .get(pty_id)
            .cloned()
            .ok_or_else(|| anyhow!("pty {} not found", pty_id))?;
        handle
            .master
            .lock()
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("pty resize failed")?;
        Ok(())
    }

    pub fn kill(&self, pty_id: &str) -> Result<()> {
        // Don't remove from `inner` here — let the exit watcher do that.
        // We just signal the child to die. The watcher will then `wait()`,
        // remove from the map, and emit `pty://exit` so the frontend updates.
        let handle = self
            .inner
            .lock()
            .get(pty_id)
            .cloned()
            .ok_or_else(|| anyhow!("pty {} not found", pty_id))?;
        if let Some(mut killer) = handle.killer.lock().take() {
            let _ = killer.kill();
        }
        Ok(())
    }
}
