mod adapter;
mod agent;
mod db;
mod manager;
mod pty;
mod sessions;

use std::sync::Arc;

use base64::Engine;
use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::agent::{AgentSnapshot, AgentSpec, ResumeOptions};
use crate::db::{CustomPreset, Db, HistoryAgent, HistoryMessage, UsageStats};
use crate::manager::AgentManager;
use crate::pty::{PtyManager, PtySnapshot, PtySpec};
use crate::sessions::ExternalSession;

static AGENT_MGR: OnceCell<AgentManager> = OnceCell::new();
static PTY_MGR: OnceCell<PtyManager> = OnceCell::new();
static DB: OnceCell<Arc<Db>> = OnceCell::new();

fn agent_mgr() -> &'static AgentManager {
    AGENT_MGR.get().expect("AgentManager not initialized")
}
fn pty_mgr() -> &'static PtyManager {
    PTY_MGR.get().expect("PtyManager not initialized")
}
fn db() -> &'static Arc<Db> {
    DB.get().expect("Db not initialized")
}

// ---------- Agent commands ----------

#[tauri::command]
async fn agent_spawn(spec: AgentSpec) -> Result<AgentSnapshot, String> {
    agent_mgr().spawn(spec).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn agent_resume(spec: AgentSpec, session_id: Option<String>) -> Result<AgentSnapshot, String> {
    agent_mgr()
        .spawn_with_resume(spec, ResumeOptions { session_id })
        .await
        .map_err(|e| e.to_string())
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
    name: String,
    binary: String,
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

// ---------- ccusage: parse ~/.claude/projects/*.jsonl for global Claude usage ----------

#[derive(Debug, Clone, Serialize)]
struct CcusageReport {
    /// Raw JSON from `npx ccusage <kind> --json`. Frontend renders specifics.
    daily: Option<serde_json::Value>,
    weekly: Option<serde_json::Value>,
    monthly: Option<serde_json::Value>,
    blocks: Option<serde_json::Value>,
    error: Option<String>,
}

#[tauri::command]
async fn ccusage_report() -> Result<CcusageReport, String> {
    let daily = run_ccusage(&["daily", "--json"]).await;
    let weekly = run_ccusage(&["weekly", "--json"]).await;
    let monthly = run_ccusage(&["monthly", "--json"]).await;
    let blocks = run_ccusage(&["blocks", "--json"]).await;

    let any_err = [&daily, &weekly, &monthly, &blocks]
        .iter()
        .find_map(|r| r.as_ref().err().cloned());

    Ok(CcusageReport {
        daily: daily.ok(),
        weekly: weekly.ok(),
        monthly: monthly.ok(),
        blocks: blocks.ok(),
        error: any_err,
    })
}

async fn run_ccusage(args: &[&str]) -> Result<serde_json::Value, String> {
    use tokio::process::Command;
    #[cfg(windows)]
    let program = "npx.cmd";
    #[cfg(not(windows))]
    let program = "npx";

    let mut cmd = Command::new(program);
    cmd.arg("--yes").arg("ccusage");
    for a in args {
        cmd.arg(a);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd.output().await.map_err(|e| format!("spawn npx ccusage failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ccusage exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("parse ccusage json failed: {e}; raw={}", stdout.chars().take(200).collect::<String>()))
}

// ---------- History / persistence commands ----------

#[tauri::command]
fn history_list_agents(limit: Option<usize>) -> Result<Vec<HistoryAgent>, String> {
    db().list_recent_agents(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn history_load_messages(agent_id: String) -> Result<Vec<HistoryMessage>, String> {
    db().load_messages(&agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn history_delete_agent(agent_id: String) -> Result<(), String> {
    db().delete_agent(&agent_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn usage_stats() -> Result<UsageStats, String> {
    db().aggregate_stats().map_err(|e| e.to_string())
}

// ---------- Settings commands ----------

#[tauri::command]
fn settings_get_all() -> Result<std::collections::HashMap<String, String>, String> {
    db().all_settings().map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(key: String, value: String) -> Result<(), String> {
    db().set_setting(&key, &value).map_err(|e| e.to_string())
}

// ---------- Custom preset commands ----------

#[tauri::command]
fn presets_list() -> Result<Vec<CustomPreset>, String> {
    db().list_presets().map_err(|e| e.to_string())
}

#[tauri::command]
fn presets_save(preset: CustomPreset) -> Result<(), String> {
    db().save_preset(&preset).map_err(|e| e.to_string())
}

#[tauri::command]
fn presets_delete(name: String) -> Result<(), String> {
    db().delete_preset(&name).map_err(|e| e.to_string())
}

// ---------- Destructive ----------

#[tauri::command]
fn data_clear_all() -> Result<(), String> {
    db().clear_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn data_path() -> String {
    db().path().to_string_lossy().to_string()
}

// ---------- Run ----------

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
            let db = Arc::new(Db::open_default().expect("open db"));
            DB.set(db.clone()).ok();
            AGENT_MGR.set(AgentManager::new(handle.clone(), db)).ok();
            PTY_MGR.set(PtyManager::new(handle)).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_spawn,
            agent_resume,
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
            ccusage_report,
            history_list_agents,
            history_load_messages,
            history_delete_agent,
            usage_stats,
            settings_get_all,
            settings_set,
            presets_list,
            presets_save,
            presets_delete,
            data_clear_all,
            data_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
