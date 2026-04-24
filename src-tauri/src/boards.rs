//! Trello-style task boards.
//!
//! Schema:
//!   boards          (id, name, description, position, created_at, updated_at)
//!   board_columns   (id, board_id, title, color, position)
//!   board_cards     (id, column_id, title, description, assignees_json,
//!                    labels_json, position, created_at, updated_at)
//!
//! Cards reference the column directly (column_id). Moving a card across
//! boards goes through "set column to one in the other board" — no extra
//! board_id field needed.

use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub position: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardColumn {
    pub id: i64,
    pub board_id: i64,
    pub title: String,
    pub color: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardCard {
    pub id: i64,
    pub column_id: i64,
    pub title: String,
    pub description: Option<String>,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub position: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS boards (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            description     TEXT,
            position        INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS board_columns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id        INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
            title           TEXT NOT NULL,
            color           TEXT,
            position        INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_columns_board ON board_columns(board_id, position);

        CREATE TABLE IF NOT EXISTS board_cards (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            column_id       INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
            title           TEXT NOT NULL,
            description     TEXT,
            assignees_json  TEXT NOT NULL DEFAULT '[]',
            labels_json     TEXT NOT NULL DEFAULT '[]',
            position        INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cards_col ON board_cards(column_id, position);
        "#,
    )?;
    Ok(())
}

// ---------------- Boards ----------------

pub fn list_boards(conn: &Connection) -> Result<Vec<Board>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, position, created_at, updated_at \
         FROM boards ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Board {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            position: r.get(3)?,
            created_at: parse_ts(&r.get::<_, String>(4)?),
            updated_at: parse_ts(&r.get::<_, String>(5)?),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_board(conn: &Connection, name: &str, description: Option<&str>) -> Result<Board> {
    let now = Utc::now().to_rfc3339();
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM boards", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO boards (name, description, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![name, description, pos, now],
    )?;
    let id = conn.last_insert_rowid();

    // Auto-seed three sensible default columns so a fresh board isn't empty.
    let cols = [("Backlog", "#5ed3ff"), ("Doing", "#dab2ff"), ("Done", "#9ef0a3")];
    for (i, (title, color)) in cols.iter().enumerate() {
        conn.execute(
            "INSERT INTO board_columns (board_id, title, color, position) VALUES (?1, ?2, ?3, ?4)",
            params![id, title, color, i as i64],
        )?;
    }

    get_board(conn, id)
}

pub fn get_board(conn: &Connection, id: i64) -> Result<Board> {
    let board = conn.query_row(
        "SELECT id, name, description, position, created_at, updated_at FROM boards WHERE id = ?1",
        params![id],
        |r| {
            Ok(Board {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                position: r.get(3)?,
                created_at: parse_ts(&r.get::<_, String>(4)?),
                updated_at: parse_ts(&r.get::<_, String>(5)?),
            })
        },
    )?;
    Ok(board)
}

pub fn update_board(
    conn: &Connection,
    id: i64,
    name: &str,
    description: Option<&str>,
) -> Result<Board> {
    conn.execute(
        "UPDATE boards SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, description, Utc::now().to_rfc3339()],
    )?;
    get_board(conn, id)
}

pub fn delete_board(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM boards WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------- Columns ----------------

pub fn list_columns(conn: &Connection, board_id: i64) -> Result<Vec<BoardColumn>> {
    let mut stmt = conn.prepare(
        "SELECT id, board_id, title, color, position FROM board_columns \
         WHERE board_id = ?1 ORDER BY position ASC, id ASC",
    )?;
    let rows = stmt.query_map(params![board_id], |r| {
        Ok(BoardColumn {
            id: r.get(0)?,
            board_id: r.get(1)?,
            title: r.get(2)?,
            color: r.get(3)?,
            position: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_column(
    conn: &Connection,
    board_id: i64,
    title: &str,
    color: Option<&str>,
) -> Result<BoardColumn> {
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM board_columns WHERE board_id = ?1",
            params![board_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO board_columns (board_id, title, color, position) VALUES (?1, ?2, ?3, ?4)",
        params![board_id, title, color, pos],
    )?;
    let id = conn.last_insert_rowid();
    get_column(conn, id)
}

pub fn get_column(conn: &Connection, id: i64) -> Result<BoardColumn> {
    Ok(conn.query_row(
        "SELECT id, board_id, title, color, position FROM board_columns WHERE id = ?1",
        params![id],
        |r| {
            Ok(BoardColumn {
                id: r.get(0)?,
                board_id: r.get(1)?,
                title: r.get(2)?,
                color: r.get(3)?,
                position: r.get(4)?,
            })
        },
    )?)
}

pub fn update_column(
    conn: &Connection,
    id: i64,
    title: &str,
    color: Option<&str>,
) -> Result<BoardColumn> {
    conn.execute(
        "UPDATE board_columns SET title = ?2, color = ?3 WHERE id = ?1",
        params![id, title, color],
    )?;
    get_column(conn, id)
}

pub fn delete_column(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM board_columns WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn reorder_columns(conn: &Connection, board_id: i64, ordered_ids: &[i64]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (i, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE board_columns SET position = ?2 WHERE id = ?1 AND board_id = ?3",
            params![id, i as i64, board_id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

// ---------------- Cards ----------------

pub fn list_cards_for_board(conn: &Connection, board_id: i64) -> Result<Vec<BoardCard>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.column_id, c.title, c.description, c.assignees_json, c.labels_json, \
                c.position, c.created_at, c.updated_at \
         FROM board_cards c \
         JOIN board_columns col ON col.id = c.column_id \
         WHERE col.board_id = ?1 \
         ORDER BY c.column_id ASC, c.position ASC, c.id ASC",
    )?;
    let rows = stmt.query_map(params![board_id], |r| Ok(parse_card_row(r)))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r??);
    }
    Ok(out)
}

fn parse_card_row(r: &rusqlite::Row) -> Result<BoardCard, rusqlite::Error> {
    let assignees_json: String = r.get(4)?;
    let labels_json: String = r.get(5)?;
    let assignees: Vec<String> = serde_json::from_str(&assignees_json).unwrap_or_default();
    let labels: Vec<String> = serde_json::from_str(&labels_json).unwrap_or_default();
    Ok(BoardCard {
        id: r.get(0)?,
        column_id: r.get(1)?,
        title: r.get(2)?,
        description: r.get(3)?,
        assignees,
        labels,
        position: r.get(6)?,
        created_at: parse_ts(&r.get::<_, String>(7)?),
        updated_at: parse_ts(&r.get::<_, String>(8)?),
    })
}

#[derive(Debug, Clone, Deserialize)]
pub struct CardInput {
    pub title: String,
    pub description: Option<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
}

pub fn create_card(
    conn: &Connection,
    column_id: i64,
    input: &CardInput,
) -> Result<BoardCard> {
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM board_cards WHERE column_id = ?1",
            params![column_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let now = Utc::now().to_rfc3339();
    let assignees_json = serde_json::to_string(&input.assignees)?;
    let labels_json = serde_json::to_string(&input.labels)?;
    conn.execute(
        "INSERT INTO board_cards (column_id, title, description, assignees_json, labels_json, position, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![column_id, input.title, input.description, assignees_json, labels_json, pos, now],
    )?;
    get_card(conn, conn.last_insert_rowid())
}

pub fn get_card(conn: &Connection, id: i64) -> Result<BoardCard> {
    let card = conn.query_row(
        "SELECT id, column_id, title, description, assignees_json, labels_json, position, created_at, updated_at \
         FROM board_cards WHERE id = ?1",
        params![id],
        |r| Ok(parse_card_row(r)),
    )??;
    Ok(card)
}

pub fn update_card(conn: &Connection, id: i64, input: &CardInput) -> Result<BoardCard> {
    let assignees_json = serde_json::to_string(&input.assignees)?;
    let labels_json = serde_json::to_string(&input.labels)?;
    conn.execute(
        "UPDATE board_cards SET title = ?2, description = ?3, assignees_json = ?4, labels_json = ?5, updated_at = ?6 \
         WHERE id = ?1",
        params![id, input.title, input.description, assignees_json, labels_json, Utc::now().to_rfc3339()],
    )?;
    get_card(conn, id)
}

pub fn delete_card(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM board_cards WHERE id = ?1", params![id])?;
    Ok(())
}

/// Move a card to (column_id, position) and renumber siblings in BOTH the
/// source and destination columns so positions stay dense and stable.
pub fn move_card(
    conn: &Connection,
    card_id: i64,
    new_column_id: i64,
    new_position: usize,
) -> Result<BoardCard> {
    let tx = conn.unchecked_transaction()?;

    let old_col_id: i64 = tx.query_row(
        "SELECT column_id FROM board_cards WHERE id = ?1",
        params![card_id],
        |r| r.get(0),
    )?;

    // Pull dest column's ordered cards (excluding the moving one if it's
    // already there), insert at new_position, renumber 0..N.
    let mut dest_ids: Vec<i64> = {
        let mut stmt = tx.prepare(
            "SELECT id FROM board_cards WHERE column_id = ?1 AND id != ?2 ORDER BY position ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![new_column_id, card_id], |r| r.get::<_, i64>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    let insert_at = new_position.min(dest_ids.len());
    dest_ids.insert(insert_at, card_id);

    for (i, id) in dest_ids.iter().enumerate() {
        tx.execute(
            "UPDATE board_cards SET column_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, new_column_id, i as i64, Utc::now().to_rfc3339()],
        )?;
    }

    // Renumber the source column if it's different.
    if old_col_id != new_column_id {
        let src_ids: Vec<i64> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM board_cards WHERE column_id = ?1 ORDER BY position ASC, id ASC",
            )?;
            let rows = stmt.query_map(params![old_col_id], |r| r.get::<_, i64>(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        for (i, id) in src_ids.iter().enumerate() {
            tx.execute(
                "UPDATE board_cards SET position = ?2 WHERE id = ?1",
                params![id, i as i64],
            )?;
        }
    }

    tx.commit()?;
    get_card(conn, card_id)
}

fn parse_ts(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
