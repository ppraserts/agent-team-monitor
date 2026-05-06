mod adapter;
mod agent;
mod boards;
mod db;
mod git;
mod manager;
mod pty;
mod sessions;
mod skills;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use base64::Engine;
use once_cell::sync::OnceCell;
use serde::Serialize;

use crate::agent::{AgentSnapshot, AgentSpec, ResumeOptions};
use crate::boards::{Board, BoardCard, BoardColumn, CardInput};
use crate::db::{CustomPreset, Db, HistoryAgent, HistoryMessage, Mission, UsageStats, Workspace};
use crate::git::{GitBranch, GitChanges, GitCommit, GitCommitPayload, GitDiffRequest, GitStash};
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

#[derive(Debug, Clone, Serialize)]
struct FileContent {
    path: String,
    content: String,
    is_binary: bool,
    size_bytes: u64,
    mtime_ms: i64,
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MissionSavePayload {
    workspace_id: String,
    id: Option<String>,
    title: String,
    goal: String,
    definition_of_done: Option<String>,
    constraints: Option<String>,
    set_active: bool,
}

#[derive(Debug, Clone)]
struct BitbucketPrParts {
    workspace: String,
    repo: String,
    pr_id: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BitbucketPrInfo {
    workspace: String,
    repo: String,
    pr_id: u64,
    url: String,
    title: String,
    state: String,
    author: String,
    source_branch: String,
    destination_branch: String,
    source_commit: Option<String>,
    changed_files: Vec<String>,
    has_more_files: bool,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketUserRef {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketBranchRef {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketCommitRef {
    #[serde(default)]
    hash: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketEndpointRef {
    #[serde(default)]
    branch: Option<BitbucketBranchRef>,
    #[serde(default)]
    commit: Option<BitbucketCommitRef>,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketPrResponse {
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    author: Option<BitbucketUserRef>,
    #[serde(default)]
    source: Option<BitbucketEndpointRef>,
    #[serde(default)]
    destination: Option<BitbucketEndpointRef>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct BitbucketDiffPath {
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct BitbucketDiffStatEntry {
    #[serde(default)]
    new: Option<BitbucketDiffPath>,
    #[serde(default)]
    old: Option<BitbucketDiffPath>,
}

#[derive(Debug, serde::Deserialize)]
struct BitbucketPage<T> {
    #[serde(default)]
    values: Vec<T>,
    #[serde(default)]
    next: Option<String>,
}

enum BitbucketAuth {
    Bearer(String),
    Basic { username: String, password: String },
}

// ---------- Agent commands ----------

#[tauri::command]
async fn agent_spawn(mut spec: AgentSpec) -> Result<AgentSnapshot, String> {
    spec.cwd = normalize_spawn_cwd(&spec.cwd)?;
    agent_mgr().spawn(spec).await.map_err(format_error)
}

#[tauri::command]
async fn agent_resume(
    mut spec: AgentSpec,
    session_id: Option<String>,
) -> Result<AgentSnapshot, String> {
    spec.cwd = normalize_spawn_cwd(&spec.cwd)?;
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
fn pty_spawn(mut spec: PtySpec) -> Result<PtySnapshot, String> {
    spec.cwd = normalize_spawn_cwd(&spec.cwd)?;
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

fn workspace_name_from_path(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

fn workspace_key(path: &str) -> String {
    let normalized = normalize_windows_path_str(path).replace('/', r"\");
    normalized.trim_end_matches('\\').to_ascii_lowercase()
}

fn dedupe_workspaces(target_root: Option<&str>) -> Result<(), String> {
    let mut buckets: HashMap<String, Vec<Workspace>> = HashMap::new();
    for mut workspace in db().list_workspaces().map_err(|e| e.to_string())? {
        workspace.root_path = normalize_windows_path_str(&workspace.root_path);
        buckets
            .entry(workspace_key(&workspace.root_path))
            .or_default()
            .push(workspace);
    }

    let target_key = target_root.map(workspace_key);
    for (key, mut items) in buckets {
        if target_key.as_ref().is_some_and(|target| target != &key) {
            continue;
        }
        if items.len() < 2 {
            continue;
        }
        items.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        let keep = items.remove(0);
        for duplicate in items {
            let keep_id = keep.id.clone();
            let duplicate_id = duplicate.id.clone();
            let keep_root = keep.root_path.clone();
            db().with_conn(|conn| {
                conn.execute(
                    "UPDATE agents SET workspace_id = ?1 WHERE workspace_id = ?2",
                    rusqlite::params![keep_id, duplicate_id],
                )?;
                conn.execute(
                    "UPDATE boards SET workspace_id = ?1 WHERE workspace_id = ?2",
                    rusqlite::params![keep_id, duplicate_id],
                )?;
                conn.execute(
                    "UPDATE missions SET workspace_id = ?1 WHERE workspace_id = ?2",
                    rusqlite::params![keep_id, duplicate_id],
                )?;
                if keep.active_mission_id.is_none() && duplicate.active_mission_id.is_some() {
                    conn.execute(
                        "UPDATE workspaces SET active_mission_id = ?2 WHERE id = ?1",
                        rusqlite::params![keep_id, duplicate.active_mission_id],
                    )?;
                }
                conn.execute(
                    "DELETE FROM workspaces WHERE id = ?1",
                    rusqlite::params![duplicate_id],
                )?;
                conn.execute(
                    "UPDATE workspaces SET root_path = ?2 WHERE id = ?1",
                    rusqlite::params![keep.id, keep_root],
                )?;
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn workspaces_bootstrap(root_path: String) -> Result<Workspace, String> {
    let root = canonical_existing_dir(&root_path).map_err(|e| e.to_string())?;
    let name = workspace_name_from_path(&root);
    let root_str = root.display().to_string();
    dedupe_workspaces(Some(&root_str))?;
    let workspace = db()
        .ensure_workspace(&name, &root_str)
        .map_err(|e| e.to_string())?;
    let like = format!("{}%", root_str);
    let _ = db().with_conn(|conn| {
        conn.execute(
            "UPDATE workspaces SET root_path = ?2 WHERE id = ?1",
            rusqlite::params![workspace.id, root_str],
        )?;
        conn.execute(
            "UPDATE boards SET workspace_id = ?1 WHERE workspace_id IS NULL",
            rusqlite::params![workspace.id],
        )?;
        conn.execute(
            "UPDATE agents SET workspace_id = ?1 WHERE workspace_id IS NULL AND cwd LIKE ?2",
            rusqlite::params![workspace.id, like],
        )?;
        Ok(())
    });
    Ok(workspace)
}

#[tauri::command]
fn workspaces_list() -> Result<Vec<Workspace>, String> {
    dedupe_workspaces(None)?;
    let items = db().list_workspaces().map_err(|e| e.to_string())?;
    let normalized = items
        .into_iter()
        .map(|mut workspace| {
            let fixed = normalize_windows_path_str(&workspace.root_path);
            if fixed != workspace.root_path {
                let id = workspace.id.clone();
                let fixed_for_db = fixed.clone();
                let _ = db().with_conn(|conn| {
                    conn.execute(
                        "UPDATE workspaces SET root_path = ?2 WHERE id = ?1",
                        rusqlite::params![id, fixed_for_db],
                    )?;
                    Ok(())
                });
                workspace.root_path = fixed;
            }
            workspace
        })
        .collect();
    Ok(normalized)
}

#[tauri::command]
fn workspaces_touch(id: String) -> Result<(), String> {
    db().touch_workspace(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn workspaces_remove(id: String) -> Result<(), String> {
    db().remove_workspace(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn pick_workspace_folder(initial_path: Option<String>) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let initial = initial_path.unwrap_or_else(workspace_dir);
        let initial = initial.replace('\'', "''");
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select workspace folder'
$initial = '{initial}'
if ($initial -and (Test-Path -LiteralPath $initial)) {{
  $dialog.SelectedPath = $initial
}}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  Write-Output $dialog.SelectedPath
}}
"#
        );
        let out = Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-STA")
            .arg("-Command")
            .arg(script)
            .output()
            .map_err(|e| format!("failed to open folder picker: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "folder picker failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = initial_path;
        Err("folder picker is currently implemented for Windows only".to_string())
    }
}

#[tauri::command]
fn missions_list(workspace_id: String) -> Result<Vec<Mission>, String> {
    db().list_missions(&workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn missions_save(payload: MissionSavePayload) -> Result<Mission, String> {
    db().save_mission(
        &payload.workspace_id,
        payload.id.as_deref(),
        &payload.title,
        &payload.goal,
        payload.definition_of_done.as_deref(),
        payload.constraints.as_deref(),
        payload.set_active,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn missions_set_active(workspace_id: String, mission_id: Option<String>) -> Result<(), String> {
    db().set_active_mission(&workspace_id, mission_id.as_deref())
        .map_err(|e| e.to_string())
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
fn fs_read_file(path: String) -> Result<FileContent, String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {}", e))?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat failed: {}", e))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Detect binary by scanning for NUL bytes in the first 8KB. Real editors do
    // similar heuristics; if it looks binary, refuse rather than mangle UTF-8.
    let head = &bytes[..bytes.len().min(8192)];
    let is_binary = head.contains(&0u8);
    if is_binary {
        return Ok(FileContent {
            path: path.display().to_string(),
            content: String::new(),
            is_binary: true,
            size_bytes: bytes.len() as u64,
            mtime_ms,
        });
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContent {
        path: path.display().to_string(),
        content,
        is_binary: false,
        size_bytes: bytes.len() as u64,
        mtime_ms,
    })
}

#[tauri::command]
fn fs_create_file(path: String) -> Result<String, String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    if path.exists() {
        return Err(format!("file already exists: {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
    }
    std::fs::write(&path, b"").map_err(|e| format!("create failed: {}", e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn fs_create_dir(path: String) -> Result<String, String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    if path.exists() {
        return Err(format!("directory already exists: {}", path.display()));
    }
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir failed: {}", e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn fs_rename(from: String, to: String) -> Result<String, String> {
    let from = validate_workspace_path(&from).map_err(|e| e.to_string())?;
    // `to` may not yet exist — resolve its parent for sandbox check, then join.
    let to_buf = std::path::PathBuf::from(&to);
    let to_abs = if to_buf.is_absolute() {
        to_buf
    } else {
        from.parent().map(|p| p.join(&to_buf)).unwrap_or(to_buf)
    };
    if let Some(parent) = to_abs.parent() {
        // Validates that the destination is inside the workspace.
        validate_workspace_path(&parent.display().to_string()).map_err(|e| e.to_string())?;
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
    }
    if to_abs.exists() {
        return Err(format!("destination exists: {}", to_abs.display()));
    }
    std::fs::rename(&from, &to_abs).map_err(|e| format!("rename failed: {}", e))?;
    Ok(to_abs.display().to_string())
}

#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    let workspace_root = std::path::PathBuf::from(workspace_dir());
    // Defense in depth: never delete the workspace root or anything outside it.
    if path == workspace_root {
        return Err("refusing to delete the workspace root".to_string());
    }
    let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("stat failed: {}", e))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("delete failed: {}", e))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("delete failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn fs_write_file(path: String, content: String) -> Result<i64, String> {
    let path = validate_workspace_path(&path).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
    }
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("write failed: {}", e))?;
    let mtime_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(mtime_ms)
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

// ---------- Source Control commands ----------

#[tauri::command]
fn git_changes(cwd: String) -> Result<GitChanges, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::changes(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_diff(cwd: String, payload: GitDiffRequest) -> Result<String, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::diff(&cwd, &payload).map_err(format_error)
}

#[tauri::command]
fn git_stage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stage(&cwd, &paths).map_err(format_error)
}

#[tauri::command]
fn git_stage_all(cwd: String) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stage_all(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_unstage(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::unstage(&cwd, &paths).map_err(format_error)
}

#[tauri::command]
fn git_unstage_all(cwd: String) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::unstage_all(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_discard(cwd: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::discard(&cwd, &paths, untracked).map_err(format_error)
}

#[tauri::command]
fn git_commit(cwd: String, payload: GitCommitPayload) -> Result<String, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::commit(&cwd, &payload).map_err(format_error)
}

#[tauri::command]
fn git_push(cwd: String, set_upstream: bool) -> Result<String, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::push(&cwd, set_upstream).map_err(format_error)
}

#[tauri::command]
fn git_pull(cwd: String) -> Result<String, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::pull(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_fetch(cwd: String) -> Result<String, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::fetch(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_branches(cwd: String) -> Result<Vec<GitBranch>, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::branches(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_checkout(cwd: String, branch: String, create: bool) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::checkout(&cwd, &branch, create).map_err(format_error)
}

#[tauri::command]
fn git_log(cwd: String, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::log(&cwd, limit.unwrap_or(50)).map_err(format_error)
}

#[tauri::command]
fn git_stash_list(cwd: String) -> Result<Vec<GitStash>, String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stash_list(&cwd).map_err(format_error)
}

#[tauri::command]
fn git_stash_save(cwd: String, message: String, include_untracked: bool) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stash_save(&cwd, &message, include_untracked).map_err(format_error)
}

#[tauri::command]
fn git_stash_pop(cwd: String, index: usize) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stash_pop(&cwd, index).map_err(format_error)
}

#[tauri::command]
fn git_stash_drop(cwd: String, index: usize) -> Result<(), String> {
    let cwd = validate_workspace_path(&cwd).map_err(|e| e.to_string())?;
    git::stash_drop(&cwd, index).map_err(format_error)
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

fn parse_bitbucket_pr_url(url: &str) -> Result<BitbucketPrParts, String> {
    let marker = "bitbucket.org/";
    let after_host = url
        .split_once(marker)
        .map(|(_, rest)| rest)
        .ok_or_else(|| "not a Bitbucket pull request URL".to_string())?;
    let segments: Vec<&str> = after_host
        .split(['/', '?', '#'])
        .filter(|part| !part.is_empty())
        .collect();
    if segments.len() < 4 || segments[2] != "pull-requests" {
        return Err(
            "expected https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}".to_string(),
        );
    }
    let pr_id = segments[3]
        .parse::<u64>()
        .map_err(|_| "pull request id is not a number".to_string())?;
    Ok(BitbucketPrParts {
        workspace: segments[0].to_string(),
        repo: segments[1].to_string(),
        pr_id,
    })
}

fn bitbucket_auth() -> Result<BitbucketAuth, String> {
    let settings = db().all_settings().map_err(|e| e.to_string())?;
    let username = settings
        .get("bitbucket_username")
        .cloned()
        .or_else(|| std::env::var("BITBUCKET_USERNAME").ok())
        .unwrap_or_default();
    let secret = settings
        .get("bitbucket_access_token")
        .cloned()
        .or_else(|| std::env::var("BITBUCKET_ACCESS_TOKEN").ok())
        .or_else(|| settings.get("bitbucket_app_password").cloned())
        .or_else(|| std::env::var("BITBUCKET_APP_PASSWORD").ok())
        .unwrap_or_default();
    let auth_mode = settings
        .get("bitbucket_auth_mode")
        .cloned()
        .or_else(|| std::env::var("BITBUCKET_AUTH_MODE").ok())
        .unwrap_or_else(|| "bearer".to_string());

    if secret.trim().is_empty() {
        return Err(
            "Bitbucket token is missing. Set bitbucket_access_token in Settings.".to_string(),
        );
    }
    if auth_mode.trim().eq_ignore_ascii_case("basic") {
        if username.trim().is_empty() {
            return Err(
                "Bitbucket username is missing. Set bitbucket_username in Settings.".to_string(),
            );
        }
        return Ok(BitbucketAuth::Basic {
            username: username.trim().to_string(),
            password: secret.trim().to_string(),
        });
    }
    Ok(BitbucketAuth::Bearer(secret.trim().to_string()))
}

fn apply_bitbucket_auth(
    request: reqwest::RequestBuilder,
    auth: &BitbucketAuth,
) -> reqwest::RequestBuilder {
    match auth {
        BitbucketAuth::Bearer(token) => request.bearer_auth(token),
        BitbucketAuth::Basic { username, password } => request.basic_auth(username, Some(password)),
    }
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
    let candidate = PathBuf::from(path);
    let base = PathBuf::from(workspace_dir());
    let full = if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    }
    .canonicalize()?;
    Ok(normalize_windows_path_buf(full))
}

fn normalize_spawn_cwd(path: &Path) -> Result<PathBuf, String> {
    validate_workspace_path(&path.display().to_string()).map_err(|e| e.to_string())
}

fn canonical_existing_dir(path: &str) -> anyhow::Result<PathBuf> {
    let full = validate_workspace_path(path)?;
    if !full.is_dir() {
        anyhow::bail!("workspace path is not a directory");
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

fn normalize_windows_path_buf(path: PathBuf) -> PathBuf {
    PathBuf::from(normalize_windows_path_str(&path.display().to_string()))
}

fn normalize_windows_path_str(path: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{}", rest);
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path.to_string()
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalDecisionPayload {
    key: String,
    agent_id: String,
    message_id: String,
    proposal_index: i64,
    body: String,
    decision: String,
    reason: Option<String>,
}

#[tauri::command]
fn proposal_decision_record(payload: ProposalDecisionPayload) -> Result<(), String> {
    db().save_proposal_decision(
        &payload.key,
        &payload.agent_id,
        &payload.message_id,
        payload.proposal_index,
        &payload.body,
        &payload.decision,
        payload.reason.as_deref(),
    )
    .map_err(|e| e.to_string())
}

// ---------- Bitbucket review commands ----------

#[tauri::command]
async fn bitbucket_pr_fetch(url: String) -> Result<BitbucketPrInfo, String> {
    let parts = parse_bitbucket_pr_url(&url)?;
    let auth = bitbucket_auth()?;
    let client = reqwest::Client::new();
    let api_base = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests/{}",
        parts.workspace, parts.repo, parts.pr_id
    );

    let pr: BitbucketPrResponse = apply_bitbucket_auth(client.get(&api_base), &auth)
        .send()
        .await
        .map_err(|e| format!("Bitbucket PR request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Bitbucket PR request rejected: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Bitbucket PR response parse failed: {e}"))?;

    let mut changed_files = Vec::new();
    let mut next = Some(format!("{api_base}/diffstat?pagelen=100"));
    let mut pages = 0usize;
    while let Some(page_url) = next.take() {
        pages += 1;
        if pages > 10 {
            next = Some(page_url);
            break;
        }
        let page: BitbucketPage<BitbucketDiffStatEntry> =
            apply_bitbucket_auth(client.get(&page_url), &auth)
                .send()
                .await
                .map_err(|e| format!("Bitbucket diffstat request failed: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Bitbucket diffstat request rejected: {e}"))?
                .json()
                .await
                .map_err(|e| format!("Bitbucket diffstat response parse failed: {e}"))?;
        for item in page.values {
            let path = item
                .new
                .and_then(|p| p.path)
                .or_else(|| item.old.and_then(|p| p.path));
            if let Some(path) = path {
                if !changed_files.contains(&path) {
                    changed_files.push(path);
                }
            }
        }
        next = page.next;
    }

    let author = pr
        .author
        .and_then(|a| a.display_name.or(a.nickname))
        .unwrap_or_else(|| "unknown".to_string());
    let source_branch = pr
        .source
        .as_ref()
        .and_then(|s| s.branch.as_ref())
        .and_then(|b| b.name.clone())
        .unwrap_or_default();
    let destination_branch = pr
        .destination
        .as_ref()
        .and_then(|d| d.branch.as_ref())
        .and_then(|b| b.name.clone())
        .unwrap_or_default();
    let source_commit = pr.source.and_then(|s| s.commit).and_then(|c| c.hash);

    Ok(BitbucketPrInfo {
        workspace: parts.workspace,
        repo: parts.repo,
        pr_id: parts.pr_id,
        url,
        title: pr.title,
        state: pr.state,
        author,
        source_branch,
        destination_branch,
        source_commit,
        changed_files,
        has_more_files: next.is_some(),
    })
}

#[tauri::command]
async fn bitbucket_pr_approve(url: String) -> Result<(), String> {
    let parts = parse_bitbucket_pr_url(&url)?;
    let auth = bitbucket_auth()?;
    let endpoint = format!(
        "https://api.bitbucket.org/2.0/repositories/{}/{}/pullrequests/{}/approve",
        parts.workspace, parts.repo, parts.pr_id
    );
    let client = reqwest::Client::new();
    apply_bitbucket_auth(client.post(endpoint), &auth)
        .send()
        .await
        .map_err(|e| format!("Bitbucket approve request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Bitbucket approve request rejected: {e}"))?;
    Ok(())
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
fn boards_list(workspace_id: Option<String>) -> Result<Vec<Board>, String> {
    db().with_conn(|c| boards::list_boards_for_workspace(c, workspace_id.as_deref()))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn boards_create(
    workspace_id: Option<String>,
    name: String,
    description: Option<String>,
) -> Result<Board, String> {
    db().with_conn(|c| {
        boards::create_board(c, workspace_id.as_deref(), &name, description.as_deref())
    })
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
            workspaces_bootstrap,
            workspaces_list,
            workspaces_touch,
            workspaces_remove,
            pick_workspace_folder,
            missions_list,
            missions_save,
            missions_set_active,
            workspace_tools,
            workspace_open_tool,
            open_path_external,
            fs_list_dir,
            fs_read_file,
            fs_write_file,
            fs_create_file,
            fs_create_dir,
            fs_rename,
            fs_delete,
            save_pasted_image,
            git_status,
            git_changes,
            git_diff,
            git_stage,
            git_stage_all,
            git_unstage,
            git_unstage_all,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_branches,
            git_checkout,
            git_log,
            git_stash_list,
            git_stash_save,
            git_stash_pop,
            git_stash_drop,
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
            proposal_decision_record,
            bitbucket_pr_fetch,
            bitbucket_pr_approve,
            presets_list,
            presets_save,
            presets_delete,
            data_clear_all,
            data_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
