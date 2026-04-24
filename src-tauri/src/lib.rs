mod adapter;
mod agent;
mod manager;
mod pty;
mod sessions;

use base64::Engine;
use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::agent::{AgentSnapshot, AgentSpec};
use crate::manager::AgentManager;
use crate::pty::{PtyManager, PtySnapshot, PtySpec};
use crate::sessions::ExternalSession;

static AGENT_MGR: OnceCell<AgentManager> = OnceCell::new();
static PTY_MGR: OnceCell<PtyManager> = OnceCell::new();

fn agent_mgr() -> &'static AgentManager {
    AGENT_MGR.get().expect("AgentManager not initialized")
}
fn pty_mgr() -> &'static PtyManager {
    PTY_MGR.get().expect("PtyManager not initialized")
}

// ---------- Agent commands ----------

#[tauri::command]
async fn agent_spawn(spec: AgentSpec) -> Result<AgentSnapshot, String> {
    agent_mgr().spawn(spec).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_send(agent_id: String, message: String) -> Result<(), String> {
    agent_mgr().send(&agent_id, message).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_kill(agent_id: String) -> Result<(), String> {
    agent_mgr().kill(&agent_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_list() -> Vec<AgentSnapshot> {
    agent_mgr().list()
}

// ---------- PTY commands ----------

#[tauri::command]
fn pty_spawn(spec: PtySpec) -> Result<PtySnapshot, String> {
    pty_mgr().spawn(spec).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(pty_id: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    pty_mgr().write(&pty_id, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(pty_id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty_mgr().resize(&pty_id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(pty_id: String) -> Result<(), String> {
    pty_mgr().kill(&pty_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_list() -> Vec<PtySnapshot> {
    pty_mgr().list()
}

// ---------- Session discovery + system info ----------

#[tauri::command]
fn list_external_sessions() -> Result<Vec<ExternalSession>, String> {
    sessions::list_external_sessions().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct VendorInfo {
    name: String,    // "claude", "gemini", "codex", "aider"
    binary: String,  // resolved path
    version: Option<String>,
}

#[tauri::command]
fn list_available_vendors() -> Vec<VendorInfo> {
    let candidates = [
        ("claude", &["--version"][..]),
        ("gemini", &["--version"][..]),
        ("codex", &["--version"][..]),
        ("aider", &["--version"][..]),
    ];
    let mut out = Vec::new();
    for (name, vargs) in candidates {
        if let Some((bin, ver)) = which_with_version(name, vargs) {
            out.push(VendorInfo { name: name.to_string(), binary: bin, version: ver });
        }
    }
    out
}

fn which_with_version(name: &str, args: &[&str]) -> Option<(String, Option<String>)> {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";

    let bins: Vec<String> = {
        #[cfg(windows)]
        { vec![format!("{}.cmd", name), format!("{}.exe", name), name.to_string()] }
        #[cfg(not(windows))]
        { vec![name.to_string()] }
    };

    for bin in &bins {
        if let Ok(out) = std::process::Command::new(finder).arg(bin).output() {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let path = line.trim().to_string();
                    if path.is_empty() { continue; }
                    let version = std::process::Command::new(&path)
                        .args(args)
                        .output()
                        .ok()
                        .and_then(|o| {
                            if o.status.success() {
                                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                            } else { None }
                        });
                    return Some((path, version));
                }
            }
        }
    }
    None
}

#[tauri::command]
fn home_dir() -> Option<String> {
    dirs::home_dir().and_then(|p| p.to_str().map(|s| s.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,tauri_app_lib=debug")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            AGENT_MGR.set(AgentManager::new(handle.clone())).ok();
            PTY_MGR.set(PtyManager::new(handle)).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_spawn,
            agent_send,
            agent_kill,
            agent_list,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list,
            list_external_sessions,
            list_available_vendors,
            home_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
