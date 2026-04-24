//! Discover existing Claude Code sessions from `~/.claude/projects/<project>/<session>.jsonl`.

use std::path::PathBuf;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::Serialize;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
pub struct ExternalSession {
    pub session_id: String,
    pub project_dir: String, // encoded folder name as it sits on disk
    pub project_path: Option<String>, // best-effort decode back to original path
    pub jsonl_path: PathBuf,
    pub size_bytes: u64,
    pub modified_at: DateTime<Utc>,
}

pub fn list_external_sessions() -> Result<Vec<ExternalSession>> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let projects_root = home.join(".claude").join("projects");
    if !projects_root.exists() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in WalkDir::new(&projects_root)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let project_dir = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let project_path = decode_project_dir(&project_dir);
        let meta = entry.metadata().ok();
        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_at = meta
            .and_then(|m| m.modified().ok())
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(Utc::now);

        out.push(ExternalSession {
            session_id,
            project_dir,
            project_path,
            jsonl_path: path.to_path_buf(),
            size_bytes,
            modified_at,
        });
    }

    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

/// Claude Code encodes project paths by replacing path separators and `:` with `-`.
/// This is a best-effort inverse — works for most Windows/Unix paths.
fn decode_project_dir(encoded: &str) -> Option<String> {
    if encoded.is_empty() {
        return None;
    }
    // Heuristic: leading "C--" → "C:\", "-Users-..." → "/Users/..."
    #[cfg(windows)]
    {
        if encoded.len() >= 3 && encoded.as_bytes()[1..3] == *b"--" {
            let drive = &encoded[..1];
            let rest = encoded[3..].replace('-', "\\");
            return Some(format!("{}:\\{}", drive, rest));
        }
    }
    Some(format!("/{}", encoded.replace('-', "/")))
}
