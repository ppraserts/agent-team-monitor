//! Browse + edit Claude Code skills and slash commands.
//!
//! Layout (auto-discovered by `claude` CLI at startup):
//!
//!   ~/.claude/skills/<name>/SKILL.md         global skill
//!   ~/.claude/commands/<name>.md             global slash command
//!   <cwd>/.claude/skills/<name>/SKILL.md     project skill
//!   <cwd>/.claude/commands/<name>.md         project slash command
//!
//! After any write here, the agent must be restarted to pick up changes
//! (skills/commands are loaded once at process start).

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillKind {
    Skill,
    Command,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Global,  // ~/.claude/...
    Project, // <cwd>/.claude/...
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillEntry {
    pub kind: SkillKind,
    pub scope: SkillScope,
    /// Skill folder name OR command file basename (without `.md`).
    pub name: String,
    /// `description` extracted from YAML frontmatter, if any.
    pub description: Option<String>,
    /// Absolute path to the markdown file.
    pub path: PathBuf,
    /// Full file contents (frontmatter + body).
    pub body: String,
}

/// List every skill + command visible to an agent rooted at `cwd`.
/// Global entries are listed first, then project-scoped.
pub fn list_for_cwd(cwd: &Path) -> Result<Vec<SkillEntry>> {
    let mut out = Vec::new();

    if let Some(home) = dirs::home_dir() {
        scan_dir(&home.join(".claude"), SkillScope::Global, &mut out);
    }
    scan_dir(&cwd.join(".claude"), SkillScope::Project, &mut out);

    Ok(out)
}

fn scan_dir(claude_dir: &Path, scope: SkillScope, out: &mut Vec<SkillEntry>) {
    // Skills
    let skills_dir = claude_dir.join("skills");
    if skills_dir.is_dir() {
        if let Ok(rd) = fs::read_dir(&skills_dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let skill_md = p.join("SKILL.md");
                if !skill_md.exists() {
                    continue;
                }
                if let Some(name) = p.file_name().and_then(|s| s.to_str()).map(String::from) {
                    if let Some(e) = read_entry_at(&skill_md, SkillKind::Skill, scope, name) {
                        out.push(e);
                    }
                }
            }
        }
    }

    // Commands
    let cmd_dir = claude_dir.join("commands");
    if cmd_dir.is_dir() {
        scan_commands_recursive(&cmd_dir, &cmd_dir, scope, out);
    }
}

/// Commands can be nested in subfolders (e.g. `commands/git/commit.md` →
/// `/git:commit`). Walk the tree and record each `.md` as a command.
fn scan_commands_recursive(
    root: &Path,
    dir: &Path,
    scope: SkillScope,
    out: &mut Vec<SkillEntry>,
) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_commands_recursive(root, &p, scope, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
            // Name = relative path without `.md`, with `/` replaced by `:`
            // (matching how Claude Code displays nested commands).
            let rel = p.strip_prefix(root).unwrap_or(&p);
            let stem = rel.with_extension("");
            let name = stem
                .to_string_lossy()
                .replace(['\\', '/'], ":");
            if let Some(e) = read_entry_at(&p, SkillKind::Command, scope, name) {
                out.push(e);
            }
        }
    }
}

fn read_entry_at(
    path: &Path,
    kind: SkillKind,
    scope: SkillScope,
    name: String,
) -> Option<SkillEntry> {
    let body = fs::read_to_string(path).ok()?;
    let description = parse_description(&body);
    Some(SkillEntry {
        kind,
        scope,
        name,
        description,
        path: path.to_path_buf(),
        body,
    })
}

/// Pull the `description` field from a YAML-style frontmatter block at the
/// top of the file. Cheap line-based parser — good enough for skill/command
/// frontmatter which is always a few flat keys.
fn parse_description(body: &str) -> Option<String> {
    let mut lines = body.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let l = line.trim();
        if l == "---" {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("description") {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Persist a new or updated skill/command. Returns the resulting entry.
pub fn save_entry(
    cwd: &Path,
    kind: SkillKind,
    scope: SkillScope,
    name: &str,
    body: &str,
) -> Result<SkillEntry> {
    let name = sanitize_name(name)?;
    let path = path_for(cwd, kind, scope, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {:?}", parent))?;
    }
    fs::write(&path, body).with_context(|| format!("write {:?}", path))?;

    Ok(SkillEntry {
        kind,
        scope,
        name,
        description: parse_description(body),
        path,
        body: body.to_string(),
    })
}

pub fn delete_entry(path: &Path) -> Result<()> {
    if !path.exists() {
        return Err(anyhow!("path does not exist: {:?}", path));
    }
    // For SKILL.md, we want to remove the parent directory if it's empty
    // afterwards (skill folder cleanup). For commands we just remove the file.
    let is_skill_md = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("SKILL.md"))
        .unwrap_or(false);

    fs::remove_file(path).with_context(|| format!("rm {:?}", path))?;

    if is_skill_md {
        if let Some(parent) = path.parent() {
            // Only remove if empty.
            if let Ok(mut iter) = fs::read_dir(parent) {
                if iter.next().is_none() {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
    }
    Ok(())
}

fn sanitize_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("name cannot be empty"));
    }
    // Allow letters, digits, dash, underscore, dot, and ":" (for nested cmds — we'll convert).
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err(anyhow!(
            "name may only contain letters, digits, '-', '_', '.', ':'; got '{}'",
            trimmed
        ));
    }
    Ok(trimmed.to_string())
}

fn path_for(
    cwd: &Path,
    kind: SkillKind,
    scope: SkillScope,
    name: &str,
) -> Result<PathBuf> {
    let claude_root = match scope {
        SkillScope::Global => dirs::home_dir()
            .ok_or_else(|| anyhow!("no home dir"))?
            .join(".claude"),
        SkillScope::Project => cwd.join(".claude"),
    };
    Ok(match kind {
        SkillKind::Skill => claude_root.join("skills").join(name).join("SKILL.md"),
        SkillKind::Command => {
            // Convert "git:commit" → "git/commit.md"
            let rel = name.replace(':', "/");
            claude_root.join("commands").join(format!("{}.md", rel))
        }
    })
}

/// Default body for a brand-new entry — sets up a usable frontmatter +
/// placeholder body so the user can edit immediately.
pub fn default_body(kind: SkillKind, name: &str) -> String {
    match kind {
        SkillKind::Skill => format!(
            "---\nname: {name}\ndescription: Briefly describe when this skill should be used.\n---\n\n# {name}\n\nWrite the skill instructions here. Claude reads this file when it decides to invoke this skill.\n",
            name = name
        ),
        SkillKind::Command => format!(
            "---\ndescription: One-line description shown in /help.\nargument-hint: <optional argument hint>\n---\n\n# /{name}\n\nWrite what this slash command should do. The body becomes the prompt sent to the model when the user runs `/{name}`.\n\nUse $ARGUMENTS to reference the arguments the user typed.\n",
            name = name
        ),
    }
}
