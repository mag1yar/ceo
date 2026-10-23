//! Token use per session, kept after the session row is gone, and where each transcript was read up to.

use super::{NOW_MS, Res, Store, err};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Totals of one session over all its transcripts (a `/clear` starts a new one).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub session_id: String,
    pub project_id: String,
    pub node_id: String,
    pub role: String,
    /// The node's title when it was first recorded.
    pub task: String,
    #[ts(type = "number")]
    pub input: i64,
    #[ts(type = "number")]
    pub output: i64,
    #[ts(type = "number")]
    pub cache_read: i64,
    #[ts(type = "number")]
    pub cache_write_1h: i64,
    #[ts(type = "number")]
    pub cache_write_5m: i64,
    /// The first turn's prompt: input, cache read and cache write.
    #[ts(type = "number | null")]
    pub first_prompt: Option<i64>,
    /// Turns that came after an idle gap longer than the cache TTL and read next to nothing from it.
    #[ts(type = "Array<{ gap: string, ttl: string, tokens: number }>")]
    pub idle_misses: Vec<Value>,
    #[ts(type = "number")]
    pub compactions: i64,
    /// The last turn's prompt size, the context the session holds now.
    #[ts(type = "number | null")]
    pub context: Option<i64>,
    /// The CEO's context at each wave boundary, just before the app cleared it.
    #[ts(type = "Array<number>")]
    pub wave_contexts: Vec<i64>,
    #[serde(skip)]
    #[ts(skip)]
    pub transcript: Option<String>,
}

const COLS: &str = "session_id, project_id, node_id, role, task, input, output, cache_read, cache_write_1h, \
    cache_write_5m, first_prompt, idle_misses, compactions, context, wave_contexts, transcript";

fn json<T: serde::de::DeserializeOwned>(s: String) -> rusqlite::Result<T> {
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Usage> {
    Ok(Usage {
        session_id: r.get(0)?,
        project_id: r.get(1)?,
        node_id: r.get(2)?,
        role: r.get(3)?,
        task: r.get(4)?,
        input: r.get(5)?,
        output: r.get(6)?,
        cache_read: r.get(7)?,
        cache_write_1h: r.get(8)?,
        cache_write_5m: r.get(9)?,
        first_prompt: r.get(10)?,
        idle_misses: json(r.get(11)?)?,
        compactions: r.get(12)?,
        context: r.get(13)?,
        wave_contexts: json(r.get(14)?)?,
        transcript: r.get(15)?,
    })
}

fn get(conn: &rusqlite::Connection, session_id: &str) -> Res<Option<Usage>> {
    conn.query_row(
        &format!("SELECT {COLS} FROM usage WHERE session_id = ?1"),
        [session_id],
        row,
    )
    .optional()
    .map_err(err)
}

fn put(conn: &rusqlite::Connection, u: &Usage) -> Res<()> {
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO usage ({COLS}, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, {NOW_MS})"
        ),
        params![
            u.session_id,
            u.project_id,
            u.node_id,
            u.role,
            u.task,
            u.input,
            u.output,
            u.cache_read,
            u.cache_write_1h,
            u.cache_write_5m,
            u.first_prompt,
            Value::from(u.idle_misses.clone()).to_string(),
            u.compactions,
            u.context,
            Value::from(u.wave_contexts.clone()).to_string(),
            u.transcript,
        ],
    )
    .map_err(err)?;
    Ok(())
}

impl Store {
    pub fn usage(&self, session_id: &str) -> Res<Option<Usage>> {
        get(&*self.conn()?, session_id)
    }

    pub fn usage_list(&self, project_id: &str) -> Res<Vec<Usage>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM usage WHERE project_id = ?1 ORDER BY updated_at, session_id"
            ))
            .map_err(err)?;
        stmt.query_map([project_id], row)
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }

    pub fn transcript_cursor(&self, path: &str) -> Res<Option<String>> {
        self.conn()?
            .query_row(
                "SELECT cursor FROM transcript_cursors WHERE path = ?1",
                [path],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    /// Adds what one read of a transcript found and moves its cursor, in one transaction so nothing counts twice.
    pub fn usage_add(
        &self,
        base: Usage,
        add: impl FnOnce(&mut Usage),
        path: &str,
        cursor: &str,
    ) -> Res<Usage> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(err)?;
        let mut u = get(&tx, &base.session_id)?.unwrap_or(base);
        add(&mut u);
        u.transcript = Some(path.into());
        put(&tx, &u)?;
        tx.execute(
            "INSERT OR REPLACE INTO transcript_cursors (path, cursor) VALUES (?1, ?2)",
            params![path, cursor],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(u)
    }

    pub fn usage_wave_context(&self, session_id: &str, context: i64) -> Res<()> {
        let conn = self.conn()?;
        if let Some(mut u) = get(&conn, session_id)? {
            u.wave_contexts.push(context);
            put(&conn, &u)?;
        }
        Ok(())
    }

    /// After `/clear` claude runs under a new session id, which a later `--resume` must use.
    pub fn set_claude_session_id(&self, id: &str, claude_session_id: &str) -> Res<()> {
        self.conn()?
            .execute(
                &format!("UPDATE sessions SET claude_session_id = ?2, updated_at = {NOW_MS} WHERE id = ?1"),
                params![id, claude_session_id],
            )
            .map_err(err)?;
        Ok(())
    }
}

#[tauri::command(async)]
pub fn usage_list(s: tauri::State<Store>, project_id: String) -> Res<Vec<Usage>> {
    s.usage_list(&project_id)
}
