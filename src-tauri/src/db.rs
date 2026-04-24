//! Local SQLite store for agent history, messages, usage, and settings.
//!
//! - Single embedded file at `<data_dir>/claude-monitor/data.db`
//! - rusqlite is sync; we wrap a single connection in a Mutex.
//! - Writes are small (one row per message/usage event) — fine to do
//!   inline on the tokio executor thread for a desktop app.
//! - Schema migrations are forward-only and idempotent.

use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::agent::{AgentSpec, AgentUsage};

pub struct Db {
    conn: Mutex<Connection>,
    path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryAgent {
    pub id: String,
    pub spec: AgentSpec,
    pub session_id: Option<String>,
    pub message_count: u64,
    pub usage: AgentUsage,
    pub last_seen_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub from_agent_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub ts: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageStats {
    pub today_input_tokens: u64,
    pub today_output_tokens: u64,
    pub today_cost_usd: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost_usd: f64,
    pub total_turns: u64,
    pub total_agents: u64,
}

impl Db {
    pub fn open_default() -> Result<Self> {
        let dir = dirs::data_local_dir()
            .context("no local data dir")?
            .join("claude-monitor");
        std::fs::create_dir_all(&dir).context("create data dir")?;
        let path = dir.join("data.db");
        Self::open(path)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&path).with_context(|| format!("open {:?}", path))?;
        conn.pragma_update(None, "journal_mode", &"WAL")?;
        conn.pragma_update(None, "foreign_keys", &"ON")?;
        let db = Self {
            conn: Mutex::new(conn),
            path,
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Expose the underlying connection to other modules that need to run
    /// their own migrations + queries (e.g. boards). Holds the lock for the
    /// duration of the closure.
    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let conn = self.conn.lock();
        f(&conn)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        crate::boards::migrate(&conn)?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS agents (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                role            TEXT NOT NULL,
                cwd             TEXT NOT NULL,
                vendor          TEXT,
                model           TEXT,
                color           TEXT,
                system_prompt   TEXT,
                skip_permissions INTEGER NOT NULL DEFAULT 0,
                allow_mentions  INTEGER NOT NULL DEFAULT 1,
                mention_allowlist TEXT NOT NULL DEFAULT '[]',
                session_id      TEXT,
                created_at      TEXT NOT NULL,
                last_seen_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                role            TEXT NOT NULL,
                content         TEXT NOT NULL,
                from_agent_id   TEXT,
                tool_name       TEXT,
                tool_input_json TEXT,
                ts              TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_agent_ts
                ON messages(agent_id, ts);

            CREATE TABLE IF NOT EXISTS usage_events (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id                 TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                input_tokens             INTEGER NOT NULL,
                output_tokens            INTEGER NOT NULL,
                cache_read_tokens        INTEGER NOT NULL,
                cache_creation_tokens    INTEGER NOT NULL,
                cost_usd                 REAL NOT NULL,
                duration_ms              INTEGER NOT NULL,
                ts                       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_agent_ts
                ON usage_events(agent_id, ts);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS custom_presets (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL UNIQUE,
                role            TEXT NOT NULL,
                color           TEXT,
                group_name      TEXT NOT NULL DEFAULT 'Custom',
                system_prompt   TEXT,
                created_at      TEXT NOT NULL
            );
            "#,
        )
        .context("migrate schema")?;
        Ok(())
    }

    // ---------------- agents ----------------

    pub fn upsert_agent(&self, id: &str, spec: &AgentSpec) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let allowlist_json = serde_json::to_string(&spec.mention_allowlist)?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO agents (
                id, name, role, cwd, vendor, model, color, system_prompt,
                skip_permissions, allow_mentions, mention_allowlist,
                created_at, last_seen_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                role = excluded.role,
                cwd = excluded.cwd,
                vendor = excluded.vendor,
                model = excluded.model,
                color = excluded.color,
                system_prompt = excluded.system_prompt,
                skip_permissions = excluded.skip_permissions,
                allow_mentions = excluded.allow_mentions,
                mention_allowlist = excluded.mention_allowlist,
                last_seen_at = excluded.last_seen_at
            "#,
            params![
                id,
                spec.name,
                spec.role,
                spec.cwd.to_string_lossy().to_string(),
                spec.vendor,
                spec.model,
                spec.color,
                spec.system_prompt,
                spec.skip_permissions as i64,
                spec.allow_mentions as i64,
                allowlist_json,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn touch_agent_session(&self, id: &str, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agents SET session_id = ?1, last_seen_at = ?2 WHERE id = ?3",
            params![session_id, Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn touch_agent_seen(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agents SET last_seen_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn list_recent_agents(&self, limit: usize) -> Result<Vec<HistoryAgent>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                a.id, a.name, a.role, a.cwd, a.vendor, a.model, a.color,
                a.system_prompt, a.skip_permissions, a.allow_mentions,
                a.mention_allowlist, a.session_id, a.last_seen_at,
                COALESCE((SELECT COUNT(*) FROM messages WHERE agent_id = a.id), 0) AS msg_count,
                COALESCE((SELECT SUM(input_tokens) FROM usage_events WHERE agent_id = a.id), 0) AS in_tok,
                COALESCE((SELECT SUM(output_tokens) FROM usage_events WHERE agent_id = a.id), 0) AS out_tok,
                COALESCE((SELECT SUM(cache_read_tokens) FROM usage_events WHERE agent_id = a.id), 0) AS cr_tok,
                COALESCE((SELECT SUM(cache_creation_tokens) FROM usage_events WHERE agent_id = a.id), 0) AS cc_tok,
                COALESCE((SELECT SUM(cost_usd) FROM usage_events WHERE agent_id = a.id), 0.0) AS cost,
                COALESCE((SELECT COUNT(*) FROM usage_events WHERE agent_id = a.id), 0) AS turns
            FROM agents a
            ORDER BY a.last_seen_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            let cwd_str: String = row.get(3)?;
            let allowlist_json: String = row.get(10)?;
            let allowlist: Vec<String> =
                serde_json::from_str(&allowlist_json).unwrap_or_default();
            let last_seen_str: String = row.get(12)?;
            let spec = AgentSpec {
                name: row.get(1)?,
                role: row.get(2)?,
                cwd: PathBuf::from(cwd_str),
                vendor: row.get(4)?,
                model: row.get(5)?,
                color: row.get(6)?,
                system_prompt: row.get(7)?,
                skip_permissions: row.get::<_, i64>(8)? != 0,
                allow_mentions: row.get::<_, i64>(9)? != 0,
                mention_allowlist: allowlist,
            };
            let usage = AgentUsage {
                input_tokens: row.get::<_, i64>(14)? as u64,
                output_tokens: row.get::<_, i64>(15)? as u64,
                cache_read_tokens: row.get::<_, i64>(16)? as u64,
                cache_creation_tokens: row.get::<_, i64>(17)? as u64,
                total_cost_usd: row.get::<_, f64>(18)?,
                turns: row.get::<_, i64>(19)? as u64,
            };
            Ok(HistoryAgent {
                id: row.get(0)?,
                spec,
                session_id: row.get(11)?,
                last_seen_at: parse_ts(&last_seen_str),
                message_count: row.get::<_, i64>(13)? as u64,
                usage,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_agent(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---------------- messages ----------------

    pub fn save_message(
        &self,
        msg_id: &str,
        agent_id: &str,
        role: &str,
        content: &str,
        from_agent_id: Option<&str>,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, from_agent_id, ts)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![msg_id, agent_id, role, content, from_agent_id, ts.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn save_tool_use(
        &self,
        msg_id: &str,
        agent_id: &str,
        tool_name: &str,
        tool_input: &serde_json::Value,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR IGNORE INTO messages
                (id, agent_id, role, content, tool_name, tool_input_json, ts)
            VALUES (?1, ?2, 'tool', ?3, ?3, ?4, ?5)
            "#,
            params![
                msg_id,
                agent_id,
                tool_name,
                tool_input.to_string(),
                ts.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn load_messages(&self, agent_id: &str) -> Result<Vec<HistoryMessage>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, role, content, from_agent_id, tool_name, tool_input_json, ts \
             FROM messages WHERE agent_id = ?1 ORDER BY ts ASC",
        )?;
        let rows = stmt.query_map(params![agent_id], |row| {
            let ts_str: String = row.get(6)?;
            let tool_input_str: Option<String> = row.get(5)?;
            let tool_input = tool_input_str
                .as_deref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
            Ok(HistoryMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                from_agent_id: row.get(3)?,
                tool_name: row.get(4)?,
                tool_input,
                ts: parse_ts(&ts_str),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ---------------- usage ----------------

    pub fn save_usage(
        &self,
        agent_id: &str,
        delta: &AgentUsage,
        duration_ms: u64,
        ts: DateTime<Utc>,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO usage_events
                (agent_id, input_tokens, output_tokens, cache_read_tokens,
                 cache_creation_tokens, cost_usd, duration_ms, ts)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                agent_id,
                delta.input_tokens as i64,
                delta.output_tokens as i64,
                delta.cache_read_tokens as i64,
                delta.cache_creation_tokens as i64,
                delta.total_cost_usd,
                duration_ms as i64,
                ts.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn aggregate_stats(&self) -> Result<UsageStats> {
        let conn = self.conn.lock();
        let today = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
        let today_str = DateTime::<Utc>::from_naive_utc_and_offset(today, Utc).to_rfc3339();

        let (in_tok, out_tok, cost): (i64, i64, f64) = conn.query_row(
            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0.0) \
             FROM usage_events WHERE ts >= ?1",
            params![today_str],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let (t_in, t_out, t_cost, t_turns): (i64, i64, f64, i64) = conn.query_row(
            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), \
             COALESCE(SUM(cost_usd),0.0), COALESCE(COUNT(*),0) FROM usage_events",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let agent_count: i64 = conn.query_row("SELECT COUNT(*) FROM agents", [], |r| r.get(0))?;

        Ok(UsageStats {
            today_input_tokens: in_tok as u64,
            today_output_tokens: out_tok as u64,
            today_cost_usd: cost,
            total_input_tokens: t_in as u64,
            total_output_tokens: t_out as u64,
            total_cost_usd: t_cost,
            total_turns: t_turns as u64,
            total_agents: agent_count as u64,
        })
    }

    // ---------------- settings ----------------

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok();
        Ok(v)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn all_settings(&self) -> Result<std::collections::HashMap<String, String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = std::collections::HashMap::new();
        for r in rows {
            let (k, v) = r?;
            out.insert(k, v);
        }
        Ok(out)
    }

    // ---------------- presets ----------------

    pub fn save_preset(&self, p: &CustomPreset) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO custom_presets (name, role, color, group_name, system_prompt, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(name) DO UPDATE SET
                role = excluded.role,
                color = excluded.color,
                group_name = excluded.group_name,
                system_prompt = excluded.system_prompt
            "#,
            params![
                p.name,
                p.role,
                p.color,
                p.group_name,
                p.system_prompt,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_presets(&self) -> Result<Vec<CustomPreset>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT name, role, color, group_name, system_prompt FROM custom_presets ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CustomPreset {
                name: r.get(0)?,
                role: r.get(1)?,
                color: r.get(2)?,
                group_name: r.get(3)?,
                system_prompt: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_preset(&self, name: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM custom_presets WHERE name = ?1", params![name])?;
        Ok(())
    }

    // ---------------- destructive ----------------

    pub fn clear_all(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "DELETE FROM messages; DELETE FROM usage_events; DELETE FROM agents;",
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomPreset {
    pub name: String,
    pub role: String,
    pub color: Option<String>,
    pub group_name: String,
    pub system_prompt: Option<String>,
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
