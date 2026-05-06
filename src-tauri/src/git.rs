//! Thin wrapper around the `git` CLI for the Source Control panel.
//!
//! We shell out to `git` rather than linking libgit2 — it matches the existing
//! `git_status` command and keeps the dependency surface small. The shape of
//! every payload is what the frontend renders directly.

use std::path::Path;
use std::process::{Command, Output};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct GitFileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// Raw two-letter porcelain code, e.g. " M", "MM", "??", "A ", "UU".
    pub xy: String,
    /// Human label for the staged side.
    pub index_status: String,
    /// Human label for the worktree side.
    pub work_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub is_untracked: bool,
    pub is_conflicted: bool,
    pub is_ignored: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitChanges {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub has_remote: bool,
    pub files: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStash {
    pub index: usize,
    pub name: String,
    pub message: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitPayload {
    pub message: String,
    #[serde(default)]
    pub amend: bool,
    #[serde(default)]
    pub sign_off: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffRequest {
    pub path: String,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub untracked: bool,
}

// ---------------- low-level helpers ----------------

fn run(cwd: &Path, args: &[&str]) -> Result<Output> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("failed to run git {}", args.join(" ")))?;
    Ok(out)
}

fn run_ok(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = run(cwd, args)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(if stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            format!("git {}: {}", args.join(" "), stderr)
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn is_repo(cwd: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(cwd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn current_branch(cwd: &Path) -> Option<String> {
    let out = run(cwd, &["branch", "--show-current"]).ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn upstream_for(cwd: &Path, branch: &str) -> Option<String> {
    let out = run(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn ahead_behind(cwd: &Path, branch: &str, upstream: &str) -> (u32, u32) {
    // git rev-list --left-right --count upstream...branch  →  "behind\tahead"
    let Ok(out) = run(
        cwd,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{upstream}...{branch}"),
        ],
    ) else {
        return (0, 0);
    };
    if !out.status.success() {
        return (0, 0);
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let mut it = s.split_whitespace();
    let behind: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    let ahead: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn has_any_remote(cwd: &Path) -> bool {
    run(cwd, &["remote"])
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn label_for(code: char) -> &'static str {
    match code {
        'M' => "Modified",
        'A' => "Added",
        'D' => "Deleted",
        'R' => "Renamed",
        'C' => "Copied",
        'U' => "Conflict",
        'T' => "Type changed",
        '?' => "Untracked",
        '!' => "Ignored",
        ' ' => "",
        _ => "Changed",
    }
}

// ---------------- public API ----------------

pub fn changes(cwd: &Path) -> Result<GitChanges> {
    if !is_repo(cwd) {
        return Ok(GitChanges {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            has_remote: false,
            files: Vec::new(),
        });
    }
    let branch = current_branch(cwd);
    let upstream = branch.as_deref().and_then(|b| upstream_for(cwd, b));
    let (ahead, behind) = match (&branch, &upstream) {
        (Some(b), Some(u)) => ahead_behind(cwd, b, u),
        _ => (0, 0),
    };

    // -z gives NUL-separated entries which we MUST use because rename entries
    // contain two NUL-separated paths and untracked file names can have spaces.
    let raw = run_ok(cwd, &["status", "--porcelain=v1", "-z", "-uall"])?;
    let bytes = raw.as_bytes();
    let mut files: Vec<GitFileChange> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        // Each entry: XY <space> path \0   (renames append \0 oldPath \0)
        if bytes.len() - i < 3 {
            break;
        }
        let x = bytes[i] as char;
        let y = bytes[i + 1] as char;
        // bytes[i+2] is a space
        i += 3;

        let start = i;
        while i < bytes.len() && bytes[i] != 0 {
            i += 1;
        }
        let path = String::from_utf8_lossy(&bytes[start..i]).into_owned();
        if i < bytes.len() {
            i += 1; // skip NUL
        }
        let mut old_path: Option<String> = None;
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            let s2 = i;
            while i < bytes.len() && bytes[i] != 0 {
                i += 1;
            }
            old_path = Some(String::from_utf8_lossy(&bytes[s2..i]).into_owned());
            if i < bytes.len() {
                i += 1;
            }
        }

        let xy = format!("{x}{y}");
        let is_untracked = x == '?' && y == '?';
        let is_ignored = x == '!' && y == '!';
        let is_conflicted =
            x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
        let staged = !is_untracked && !is_ignored && x != ' ' && x != '?';
        let unstaged = is_untracked || (y != ' ' && y != '?');

        files.push(GitFileChange {
            path,
            old_path,
            xy,
            index_status: label_for(x).to_string(),
            work_status: label_for(y).to_string(),
            staged,
            unstaged,
            is_untracked,
            is_conflicted,
            is_ignored,
        });
    }

    Ok(GitChanges {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        has_remote: has_any_remote(cwd),
        files,
    })
}

pub fn diff(cwd: &Path, req: &GitDiffRequest) -> Result<String> {
    if !is_repo(cwd) {
        bail!("not a git repository");
    }
    if req.untracked {
        // For untracked files there's no committed baseline; fabricate one by
        // diffing against /dev/null so the panel can still render additions.
        let out = Command::new("git")
            .args([
                "diff",
                "--no-color",
                "--no-index",
                "--",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
                &req.path,
            ])
            .current_dir(cwd)
            .output()
            .context("failed to run git diff --no-index")?;
        // git diff --no-index returns 1 when files differ — that's expected.
        if out.status.code() == Some(0) || out.status.code() == Some(1) {
            return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!(if stderr.is_empty() {
            "git diff failed".to_string()
        } else {
            format!("git diff: {stderr}")
        });
    }
    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if req.staged {
        args.push("--cached");
    }
    args.push("--");
    args.push(&req.path);
    run_ok(cwd, &args)
}

pub fn stage(cwd: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in paths {
        args.push(p.as_str());
    }
    run_ok(cwd, &args).map(|_| ())
}

pub fn stage_all(cwd: &Path) -> Result<()> {
    run_ok(cwd, &["add", "-A"]).map(|_| ())
}

pub fn unstage(cwd: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
    for p in paths {
        args.push(p.as_str());
    }
    run_ok(cwd, &args).map(|_| ())
}

pub fn unstage_all(cwd: &Path) -> Result<()> {
    run_ok(cwd, &["reset", "HEAD"]).map(|_| ())
}

/// Discard worktree edits. For untracked files, deletes them (`git clean`).
pub fn discard(cwd: &Path, paths: &[String], untracked: bool) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    if untracked {
        let mut args: Vec<&str> = vec!["clean", "-f", "--"];
        for p in paths {
            args.push(p.as_str());
        }
        run_ok(cwd, &args).map(|_| ())
    } else {
        let mut args: Vec<&str> = vec!["checkout", "HEAD", "--"];
        for p in paths {
            args.push(p.as_str());
        }
        run_ok(cwd, &args).map(|_| ())
    }
}

pub fn commit(cwd: &Path, payload: &GitCommitPayload) -> Result<String> {
    if payload.message.trim().is_empty() && !payload.amend {
        bail!("commit message is required");
    }
    let mut args: Vec<&str> = vec!["commit"];
    if payload.amend {
        args.push("--amend");
    }
    if payload.sign_off {
        args.push("--signoff");
    }
    if !payload.message.trim().is_empty() {
        args.push("-m");
        args.push(payload.message.as_str());
    } else {
        args.push("--no-edit");
    }
    run_ok(cwd, &args)
}

pub fn push(cwd: &Path, set_upstream: bool) -> Result<String> {
    let branch = if set_upstream {
        Some(current_branch(cwd).context("no current branch")?)
    } else {
        None
    };
    let mut args: Vec<&str> = vec!["push"];
    if let Some(b) = branch.as_deref() {
        args.extend(["-u", "origin", b]);
    }
    run_ok(cwd, &args)
}

pub fn pull(cwd: &Path) -> Result<String> {
    run_ok(cwd, &["pull", "--ff-only"])
}

pub fn fetch(cwd: &Path) -> Result<String> {
    run_ok(cwd, &["fetch", "--all", "--prune"])
}

pub fn branches(cwd: &Path) -> Result<Vec<GitBranch>> {
    if !is_repo(cwd) {
        return Ok(Vec::new());
    }
    let raw = run_ok(
        cwd,
        &[
            "branch",
            "--all",
            "--format=%(HEAD)\t%(refname:short)\t%(refname)\t%(upstream:short)",
        ],
    )?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(4, '\t');
        let head = parts.next().unwrap_or("");
        let short = parts.next().unwrap_or("").to_string();
        let refname = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("");
        if short.is_empty() {
            continue;
        }
        out.push(GitBranch {
            name: short,
            is_current: head == "*",
            is_remote: refname.starts_with("refs/remotes/"),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
        });
    }
    Ok(out)
}

pub fn checkout(cwd: &Path, branch: &str, create: bool) -> Result<()> {
    let mut args: Vec<&str> = vec!["checkout"];
    if create {
        args.push("-b");
    }
    args.push(branch);
    run_ok(cwd, &args).map(|_| ())
}

pub fn log(cwd: &Path, limit: usize) -> Result<Vec<GitCommit>> {
    if !is_repo(cwd) {
        return Ok(Vec::new());
    }
    // %x1f = unit separator, %x1e = record separator
    let format = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s";
    let n = limit.max(1).min(500).to_string();
    let raw = run_ok(
        cwd,
        &["log", "-n", &n, &format!("--pretty=format:{format}")],
    )?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut p = line.splitn(6, '\x1f');
        let hash = p.next().unwrap_or("").to_string();
        let short_hash = p.next().unwrap_or("").to_string();
        let author = p.next().unwrap_or("").to_string();
        let email = p.next().unwrap_or("").to_string();
        let date = p.next().unwrap_or("").to_string();
        let subject = p.next().unwrap_or("").to_string();
        if hash.is_empty() {
            continue;
        }
        out.push(GitCommit {
            hash,
            short_hash,
            author,
            email,
            date,
            subject,
        });
    }
    Ok(out)
}

pub fn stash_list(cwd: &Path) -> Result<Vec<GitStash>> {
    if !is_repo(cwd) {
        return Ok(Vec::new());
    }
    let raw = run_ok(cwd, &["stash", "list", "--pretty=format:%gd%x1f%gs%x1f%s"])?;
    let mut out = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let mut p = line.splitn(3, '\x1f');
        let name = p.next().unwrap_or("").to_string();
        let raw_msg = p.next().unwrap_or("").to_string();
        let subject = p.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        // raw_msg looks like "WIP on main: 1234abc subject" — extract branch.
        let branch = raw_msg
            .strip_prefix("WIP on ")
            .or_else(|| raw_msg.strip_prefix("On "))
            .and_then(|rest| rest.split(':').next())
            .map(|s| s.to_string());
        out.push(GitStash {
            index: idx,
            name,
            message: subject,
            branch,
        });
    }
    Ok(out)
}

pub fn stash_save(cwd: &Path, message: &str, include_untracked: bool) -> Result<()> {
    let mut args: Vec<&str> = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if !message.trim().is_empty() {
        args.push("-m");
        args.push(message);
    }
    run_ok(cwd, &args).map(|_| ())
}

pub fn stash_pop(cwd: &Path, index: usize) -> Result<()> {
    let r = format!("stash@{{{index}}}");
    run_ok(cwd, &["stash", "pop", &r]).map(|_| ())
}

pub fn stash_drop(cwd: &Path, index: usize) -> Result<()> {
    let r = format!("stash@{{{index}}}");
    run_ok(cwd, &["stash", "drop", &r]).map(|_| ())
}
