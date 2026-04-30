mod adapter;
mod agent;
mod boards;
mod db;
mod manager;
mod pty;
mod sessions;
mod skills;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use base64::Engine;
use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::agent::{AgentSnapshot, AgentSpec, ResumeOptions};
use crate::boards::{Board, BoardCard, BoardColumn, CardInput};
use crate::db::{CustomPreset, Db, HistoryAgent, HistoryMessage, UsageStats};
use crate::manager::AgentManager;
use crate::pty::{PtyManager, PtySnapshot, PtySpec};
use crate::sessions::ExternalSession;
use crate::skills::{SkillEntry, SkillKind, SkillScope};

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

fn format_error(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Debug, Clone, Serialize)]
struct WorkspaceTool {
    id: String,
    name: String,
    kind: String,
    binary: Option<String>,
    available: bool,
}

#[derive(Debug, Clone, Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PastedImagePayload {
    cwd: String,
    data_b64: String,
    mime: String,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ImageAttachment {
    id: String,
    name: String,
    path: String,
    mime: String,
}

#[derive(Debug, Clone, Serialize)]
struct GitStatus {
    branch: Option<String>,
    changed_count: usize,
    summary: Vec<String>,
    is_repo: bool,
}

// ---------- Agent commands ----------

#[tauri::command]
async fn agent_spawn(spec: AgentSpec) -> Result<AgentSnapshot, String> {
    agent_mgr().spawn(spec).await.map_err(format_error)
}

#[tauri::command]
async fn agent_resume(
    spec: AgentSpec,
    session_id: Option<String>,
) -> Result<AgentSnapshot, String> {
    agent_mgr()
        .spawn_with_resume(spec, ResumeOptions { session_id })
        .await
        .map_err(format_error)
}

#[tauri::command]
async fn agent_send(agent_id: String, message: String) -> Result<(), String> {
    agent_mgr()
        .send(&agent_id, message)
        .await
        .map_err(format_error)
}

#[tauri::command]
async fn agent_kill(agent_id: String) -> Result<(), String> {
    agent_mgr().kill(&agent_id).await.map_err(format_error)
}

#[tauri::command]
fn agent_list() -> Vec<AgentSnapshot> {
    agent_mgr().list()
}

// ---------- PTY commands ----------

#[tauri::command]
fn pty_spawn(spec: PtySpec) -> Result<PtySnapshot, String> {
    pty_mgr().spawn(spec).map_err(format_error)
}

#[tauri::command]
fn pty_write(pty_id: String, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    pty_mgr().write(&pty_id, &bytes).map_err(format_error)
}

#[tauri::command]
fn pty_resize(pty_id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty_mgr().resize(&pty_id, cols, rows).map_err(format_error)
}

#[tauri::command]
fn pty_kill(pty_id: String) -> Result<(), String> {
    pty_mgr().kill(&pty_id).map_err(format_error)
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

#[tauri::command]
fn delete_external_session(jsonl_path: String) -> Result<(), String> {
    sessions::delete_external_session(jsonl_path.into()).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
struct VendorInfo {
    name: String,
    binary: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RuntimeCheck {
    name: String,
    binary: Option<String>,
    version: Option<String>,
    ok: bool,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct RuntimeDiagnostics {
    checks: Vec<RuntimeCheck>,
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
            out.push(VendorInfo {
                name: name.to_string(),
                binary: bin,
                version: ver,
            });
        }
    }
    out
}

#[tauri::command]
fn runtime_diagnostics() -> RuntimeDiagnostics {
    let checks = vec![
        runtime_check("node", &["--version"], false),
        runtime_check("npm", &["--version"], true),
        runtime_check("bun", &["--version"], false),
        runtime_check("cargo", &["--version"], false),
        runtime_check("rustc", &["--version"], false),
        runtime_check("claude", &["--version"], true),
        runtime_check("npx", &["--version"], true),
    ];
    RuntimeDiagnostics { checks }
}

fn runtime_check(name: &str, args: &[&str], required: bool) -> RuntimeCheck {
    match which_with_version(name, args) {
        Some((binary, version)) => RuntimeCheck {
            name: name.to_string(),
            binary: Some(binary),
            version,
            ok: true,
            message: None,
        },
        None => RuntimeCheck {
            name: name.to_string(),
            binary: None,
            version: None,
            ok: !required,
            message: Some(if required {
                "required runtime not found on PATH".to_string()
            } else {
                "optional runtime not found on PATH".to_string()
            }),
        },
    }
}

fn which_with_version(name: &str, args: &[&str]) -> Option<(String, Option<String>)> {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";

    let bins: Vec<String> = {
        #[cfg(windows)]
        {
            vec![
                format!("{}.cmd", name),
                format!("{}.exe", name),
                name.to_string(),
            ]
        }
        #[cfg(not(windows))]
        {
            vec![name.to_string()]
        }
    };

    for bin in &bins {
        if let Ok(out) = std::process::Command::new(finder).arg(bin).output() {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let path = line.trim().to_string();
                    if path.is_empty() {
                        continue;
                    }
                    let version = std::process::Command::new(&path)
                        .args(args)
                        .output()
                        .ok()
                        .and_then(|o| {
                            if o.status.success() {
                                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                            } else {
                                None
                            }
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

#[tauri::command]
fn workspace_dir() -> String {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .unwrap_or(manifest_dir.as_path())
        .display()
        .to_string()
}

#[tauri::command]
fn workspace_tools() -> Vec<WorkspaceTool> {
    vec![
        tool(
            "vscode",
            "VS Code",
            "editor",
            &["code.cmd", "code.exe", "code"],
            &[],
        ),
        tool(
            "cursor",
            "Cursor",
            "editor",
            &["cursor.cmd", "cursor.exe", "cursor"],
            &[],
        ),
        tool(
            "visual_studio",
            "Visual Studio",
            "editor",
            &["devenv.exe"],
            &[
                r"C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\devenv.exe",
                r"C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\IDE\devenv.exe",
                r"C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\devenv.exe",
            ],
        ),
        WorkspaceTool {
            id: "file_explorer".into(),
            name: "File Explorer".into(),
            kind: "file_explorer".into(),
            binary: Some("explorer.exe".into()),
            available: cfg!(windows),
        },
        WorkspaceTool {
            id: "terminal".into(),
            name: "Terminal".into(),
            kind: "terminal".into(),
            binary: Some("in-app".into()),
            available: true,
        },
        tool(
            "git_bash",
            "Git Bash",
            "shell",
            &[],
            &[
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
                r"C:\Program Files\Git\usr\bin\bash.exe",
                r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
            ],
        ),
        tool("wsl", "WSL", "shell", &["wsl.exe"], &[]),
    ]
}

#[tauri::command]
fn workspace_open_tool(tool_id: String, cwd: String) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    match tool_id.as_str() {
        "vscode" | "cursor" | "visual_studio" => {
            let tools = workspace_tools();
            let Some(t) = tools.into_iter().find(|t| t.id == tool_id && t.available) else {
                return Err(format!("tool '{}' is not available", tool_id));
            };
            let Some(bin) = t.binary else {
                return Err(format!("tool '{}' has no executable", tool_id));
            };
            Command::new(bin)
                .arg(&cwd)
                .spawn()
                .map_err(|e| format!("failed to open {}: {}", t.name, e))?;
            Ok(())
        }
        "file_explorer" => open_path(&cwd),
        "git_bash" => {
            let bin = workspace_tools()
                .into_iter()
                .find(|t| t.id == "git_bash" && t.available)
                .and_then(|t| t.binary)
                .ok_or_else(|| "Git Bash is not available".to_string())?;
            Command::new(bin)
                .arg("--cd")
                .arg(&cwd)
                .spawn()
                .map_err(|e| format!("failed to open Git Bash: {}", e))?;
            Ok(())
        }
        "wsl" => {
            Command::new("wsl.exe")
                .current_dir(&cwd)
                .spawn()
                .map_err(|e| format!("failed to open WSL: {}", e))?;
            Ok(())
        }
        "terminal" => Ok(()),
        other => Err(format!("unknown workspace tool '{}'", other)),
    }
}

#[tauri::command]
fn open_path_external(path: String) -> Result<(), String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    open_path(&path)
}

#[tauri::command]
fn fs_list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    let rd = std::fs::read_dir(&path).map_err(|e| format!("read_dir failed: {}", e))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }
        out.push(FsEntry {
            name,
            path: p.display().to_string(),
            is_dir: p.is_dir(),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn save_pasted_image(payload: PastedImagePayload) -> Result<ImageAttachment, String> {
    let cwd = validate_workspace_path(&payload.cwd).map_err(|e| e.to_string())?;
    let ext = match payload.mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        other => return Err(format!("unsupported image type '{}'", other)),
    };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.data_b64.as_bytes())
        .map_err(|e| format!("invalid image data: {}", e))?;
    let id = uuid::Uuid::new_v4().to_string();
    let safe_name = payload
        .name
        .as_deref()
        .map(sanitize_file_stem)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "screenshot".to_string());
    let dir = cwd.join(".agent-team-monitor").join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create attachment dir failed: {}", e))?;
    let file_name = format!("{}-{}.{}", safe_name, &id[..8], ext);
    let path = dir.join(file_name);
    std::fs::write(&path, bytes).map_err(|e| format!("write image failed: {}", e))?;
    Ok(ImageAttachment {
        id,
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("attachment.{}", ext)),
        path: path.display().to_string(),
        mime: payload.mime,
    })
}

#[tauri::command]
fn git_status(cwd: String) -> Result<GitStatus, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    let inside = Command::new("git")
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !inside.status.success() {
        return Ok(GitStatus {
            branch: None,
            changed_count: 0,
            summary: Vec::new(),
            is_repo: false,
        });
    }
    let branch_out = Command::new("git")
        .arg("branch")
        .arg("--show-current")
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to read git branch: {}", e))?;
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    let status_out = Command::new("git")
        .arg("status")
        .arg("--short")
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to read git status: {}", e))?;
    let summary: Vec<String> = String::from_utf8_lossy(&status_out.stdout)
        .lines()
        .take(30)
        .map(|s| s.to_string())
        .collect();
    Ok(GitStatus {
        branch: if branch.is_empty() {
            None
        } else {
            Some(branch)
        },
        changed_count: summary.len(),
        summary,
        is_repo: true,
    })
}

fn sanitize_file_stem(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(40)
        .collect()
}

fn tool(
    id: &str,
    name: &str,
    kind: &str,
    path_names: &[&str],
    common_paths: &[&str],
) -> WorkspaceTool {
    let binary = find_binary(path_names).or_else(|| {
        common_paths
            .iter()
            .find(|p| Path::new(*p).is_file())
            .map(|p| (*p).to_string())
    });
    WorkspaceTool {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        available: binary.is_some(),
        binary,
    }
}

fn find_binary(names: &[&str]) -> Option<String> {
    #[cfg(windows)]
    let finder = "where";
    #[cfg(not(windows))]
    let finder = "which";
    for name in names {
        if let Ok(out) = Command::new(finder).arg(name).output() {
            if out.status.success() {
                if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                    let p = line.trim();
                    if !p.is_empty() {
                        return Some(p.to_string());
                    }
                }
            }
        }
    }
    None
}

fn validate_workspace_path(path: &str) -> anyhow::Result<PathBuf> {
    let root = PathBuf::from(workspace_dir()).canonicalize()?;
    let candidate = PathBuf::from(path);
    let full = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
    .canonicalize()?;
    if !full.starts_with(&root) {
        anyhow::bail!("path is outside workspace");
    }
    Ok(full)
}

fn open_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to open File Explorer: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to open path: {}", e))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("failed to open path: {}", e))?;
    }
    Ok(())
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

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("spawn npx ccusage failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ccusage exit {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "parse ccusage json failed: {e}; raw={}",
            stdout.chars().take(200).collect::<String>()
        )
    })
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

// ---------- Skills + slash commands ----------

#[tauri::command]
fn skills_list(cwd: String) -> Result<Vec<SkillEntry>, String> {
    skills::list_for_cwd(std::path::Path::new(&cwd)).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Deserialize)]
struct SkillSavePayload {
    cwd: String,
    kind: SkillKind,
    scope: SkillScope,
    name: String,
    body: String,
}

#[tauri::command]
fn skills_save(payload: SkillSavePayload) -> Result<SkillEntry, String> {
    skills::save_entry(
        std::path::Path::new(&payload.cwd),
        payload.kind,
        payload.scope,
        &payload.name,
        &payload.body,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn skills_delete(path: String) -> Result<(), String> {
    skills::delete_entry(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn skills_default_body(kind: SkillKind, name: String) -> String {
    skills::default_body(kind, &name)
}

// ---------- Boards (Trello-style task boards) ----------

#[tauri::command]
fn boards_list() -> Result<Vec<Board>, String> {
    db().with_conn(|c| boards::list_boards(c))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn boards_create(name: String, description: Option<String>) -> Result<Board, String> {
    db().with_conn(|c| boards::create_board(c, &name, description.as_deref()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn boards_update(id: i64, name: String, description: Option<String>) -> Result<Board, String> {
    db().with_conn(|c| boards::update_board(c, id, &name, description.as_deref()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn boards_delete(id: i64) -> Result<(), String> {
    db().with_conn(|c| boards::delete_board(c, id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn columns_list(board_id: i64) -> Result<Vec<BoardColumn>, String> {
    db().with_conn(|c| boards::list_columns(c, board_id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn columns_create(
    board_id: i64,
    title: String,
    color: Option<String>,
) -> Result<BoardColumn, String> {
    db().with_conn(|c| boards::create_column(c, board_id, &title, color.as_deref()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn columns_update(
    id: i64,
    title: String,
    color: Option<String>,
    description: Option<String>,
    entry_criteria: Option<String>,
    exit_criteria: Option<String>,
    allowed_next_column_ids: Vec<i64>,
) -> Result<BoardColumn, String> {
    db().with_conn(|c| {
        boards::update_column(
            c,
            id,
            &title,
            color.as_deref(),
            description.as_deref(),
            entry_criteria.as_deref(),
            exit_criteria.as_deref(),
            &allowed_next_column_ids,
        )
    })
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn columns_delete(id: i64) -> Result<(), String> {
    db().with_conn(|c| boards::delete_column(c, id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn columns_reorder(board_id: i64, ordered_ids: Vec<i64>) -> Result<(), String> {
    db().with_conn(|c| boards::reorder_columns(c, board_id, &ordered_ids))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cards_list(board_id: i64) -> Result<Vec<BoardCard>, String> {
    db().with_conn(|c| boards::list_cards_for_board(c, board_id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn cards_create(column_id: i64, input: CardInput) -> Result<BoardCard, String> {
    db().with_conn(|c| boards::create_card(c, column_id, &input))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn cards_update(id: i64, input: CardInput) -> Result<BoardCard, String> {
    db().with_conn(|c| boards::update_card(c, id, &input))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn cards_delete(id: i64) -> Result<(), String> {
    db().with_conn(|c| boards::delete_card(c, id))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn cards_move(card_id: i64, new_column_id: i64, new_position: usize) -> Result<BoardCard, String> {
    db().with_conn(|c| boards::move_card(c, card_id, new_column_id, new_position))
        .map_err(|e| e.to_string())
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
            delete_external_session,
            list_available_vendors,
            runtime_diagnostics,
            home_dir,
            workspace_dir,
            workspace_tools,
            workspace_open_tool,
            open_path_external,
            fs_list_dir,
            save_pasted_image,
            git_status,
            ccusage_report,
            skills_list,
            skills_save,
            skills_delete,
            skills_default_body,
            boards_list,
            boards_create,
            boards_update,
            boards_delete,
            columns_list,
            columns_create,
            columns_update,
            columns_delete,
            columns_reorder,
            cards_list,
            cards_create,
            cards_update,
            cards_delete,
            cards_move,
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
