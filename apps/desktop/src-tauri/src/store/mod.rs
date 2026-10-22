mod migrations;
mod types;

use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};
pub use types::*;

pub struct Store(Mutex<Connection>);

const NOW_MS: &str = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const PROJECT_COLS: &str = "id, name, path, position, created_at, last_opened_at";

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        migrations::migrate(&mut conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    fn conn(&self) -> Res<std::sync::MutexGuard<'_, Connection>> {
        // SQLite rolls back an open transaction itself, so a poisoned lock is safe to reuse.
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }

    pub fn list_projects(&self) -> Res<Vec<Project>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {PROJECT_COLS} FROM projects ORDER BY position, created_at"
            ))
            .map_err(err)?;
        stmt.query_map([], project_row)
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }

    fn get_project(conn: &Connection, id: &str) -> Res<Project> {
        conn.query_row(
            &format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"),
            [id],
            project_row,
        )
        .map_err(err)
    }

    pub fn create_project(&self, name: &str, path: &str) -> Res<Project> {
        let conn = self.conn()?;
        conn.execute(
            &format!(
                "INSERT INTO projects (id, name, path, position, created_at)
                 VALUES (lower(hex(randomblob(16))), ?1, ?2,
                         (SELECT COALESCE(MAX(position) + 1, 0) FROM projects), {NOW_MS})"
            ),
            params![name, path],
        )
        .map_err(err)?;
        let id: String = conn
            .query_row(
                "SELECT id FROM projects WHERE rowid = last_insert_rowid()",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        Self::get_project(&conn, &id)
    }

    pub fn update_project(&self, id: &str, name: &str, path: &str) -> Res<Project> {
        let conn = self.conn()?;
        conn.execute(
            "UPDATE projects SET name = ?2, path = ?3 WHERE id = ?1",
            params![id, name, path],
        )
        .map_err(err)?;
        Self::get_project(&conn, id)
    }

    pub fn touch_project(&self, id: &str) -> Res<Project> {
        let conn = self.conn()?;
        conn.execute(
            &format!("UPDATE projects SET last_opened_at = {NOW_MS} WHERE id = ?1"),
            [id],
        )
        .map_err(err)?;
        Self::get_project(&conn, id)
    }

    // Removes database rows only; the project folder on disk is never touched.
    pub fn delete_project(&self, id: &str) -> Res<()> {
        self.conn()?
            .execute("DELETE FROM projects WHERE id = ?1", [id])
            .map_err(err)?;
        Ok(())
    }

    pub fn reorder_projects(&self, ids: &[String]) -> Res<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(err)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE projects SET position = ?2 WHERE id = ?1",
                params![id, i as i64],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    pub fn load_board(&self, project_id: &str) -> Res<Board> {
        let conn = self.conn()?;
        let viewport: Option<String> = conn
            .query_row(
                "SELECT viewport FROM boards WHERE project_id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        let viewport = viewport
            .map_or(Ok(serde_json::json!({})), |s| serde_json::from_str(&s))
            .map_err(err)?;
        let nodes = conn
            .prepare("SELECT id, type, x, y, width, height, data, z FROM board_nodes WHERE project_id = ?1 ORDER BY z, id")
            .map_err(err)?
            .query_map([project_id], |r| {
                Ok(BoardNode {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    x: r.get(2)?,
                    y: r.get(3)?,
                    width: r.get(4)?,
                    height: r.get(5)?,
                    data: json_col(r.get(6)?)?,
                    z: r.get(7)?,
                })
            })
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        let edges = conn
            .prepare("SELECT id, source, target, data FROM board_edges WHERE project_id = ?1 ORDER BY id")
            .map_err(err)?
            .query_map([project_id], |r| {
                Ok(BoardEdge { id: r.get(0)?, source: r.get(1)?, target: r.get(2)?, data: json_col(r.get(3)?)? })
            })
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        Ok(Board {
            viewport,
            nodes,
            edges,
        })
    }

    pub fn save_board(&self, project_id: &str, c: &BoardChanges) -> Res<()> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(err)?;
        if let Some(v) = &c.viewport {
            tx.execute(
                "INSERT INTO boards (project_id, viewport) VALUES (?1, ?2)
                 ON CONFLICT(project_id) DO UPDATE SET viewport = excluded.viewport",
                params![project_id, v.to_string()],
            )
            .map_err(err)?;
        }
        // Deletes run before upserts so a node deleted and re-added in one batch survives.
        for id in &c.delete_edge_ids {
            tx.execute(
                "DELETE FROM board_edges WHERE project_id = ?1 AND id = ?2",
                params![project_id, id],
            )
            .map_err(err)?;
        }
        for id in &c.delete_node_ids {
            tx.execute(
                "DELETE FROM board_nodes WHERE project_id = ?1 AND id = ?2",
                params![project_id, id],
            )
            .map_err(err)?;
            tx.execute(
                "DELETE FROM board_edges WHERE project_id = ?1 AND (source = ?2 OR target = ?2)",
                params![project_id, id],
            )
            .map_err(err)?;
        }
        for n in &c.upsert_nodes {
            tx.execute(
                "INSERT INTO board_nodes (id, project_id, type, x, y, width, height, data, z)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(project_id, id) DO UPDATE SET type = excluded.type, x = excluded.x,
                   y = excluded.y, width = excluded.width, height = excluded.height,
                   data = excluded.data, z = excluded.z",
                params![
                    n.id,
                    project_id,
                    n.kind,
                    n.x,
                    n.y,
                    n.width,
                    n.height,
                    n.data.to_string(),
                    n.z
                ],
            )
            .map_err(err)?;
        }
        for e in &c.upsert_edges {
            tx.execute(
                "INSERT INTO board_edges (id, project_id, source, target, data) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_id, id) DO UPDATE SET source = excluded.source,
                   target = excluded.target, data = excluded.data",
                params![e.id, project_id, e.source, e.target, e.data.to_string()],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)
    }
}

impl Store {
    pub fn node_role(&self, project_id: &str, node_id: &str) -> Res<Option<String>> {
        self.conn()?
            .query_row(
                "SELECT type FROM board_nodes WHERE project_id = ?1 AND id = ?2",
                [project_id, node_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)
    }

    fn query_sessions(&self, filter: &str, args: &[&str]) -> Res<Vec<AgentSession>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(&format!("SELECT {SESSION_COLS} FROM sessions WHERE removed_at IS NULL AND {filter} ORDER BY created_at"))
            .map_err(err)?;
        stmt.query_map(rusqlite::params_from_iter(args), session_row)
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }

    pub fn session(&self, id: &str) -> Res<Option<AgentSession>> {
        Ok(self.query_sessions("id = ?1", &[id])?.pop())
    }

    pub fn node_session(&self, project_id: &str, node_id: &str) -> Res<Option<AgentSession>> {
        Ok(self
            .query_sessions("project_id = ?1 AND node_id = ?2", &[project_id, node_id])?
            .pop())
    }

    pub fn project_sessions(&self, project_id: &str) -> Res<Vec<AgentSession>> {
        self.query_sessions("project_id = ?1", &[project_id])
    }

    // Sessions of deleted projects are left out: nothing may restart them.
    pub fn live_sessions(&self) -> Res<Vec<AgentSession>> {
        self.query_sessions("project_id IN (SELECT id FROM projects)", &[])
    }

    pub fn insert_session(&self, s: &AgentSession) -> Res<()> {
        self.conn()?
            .execute(
                &format!(
                    "INSERT INTO sessions (id, project_id, node_id, role, repo, worktree, branch, tmux_name,
                       claude_session_id, token, status, action, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, {NOW_MS}, {NOW_MS})"
                ),
                params![
                    s.id, s.project_id, s.node_id, s.role, s.repo, s.worktree, s.branch, s.tmux_name,
                    s.claude_session_id, s.token, s.status, s.action
                ],
            )
            .map_err(err)?;
        Ok(())
    }

    pub fn set_session_status(&self, id: &str, status: &str, action: &str) -> Res<()> {
        self.conn()?
            .execute(
                &format!("UPDATE sessions SET status = ?2, action = ?3, updated_at = {NOW_MS} WHERE id = ?1"),
                params![id, status, action],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Deletes the row, or keeps it as removed with the reason when git refused to delete the work.
    pub fn remove_session(&self, id: &str, kept: Option<&str>) -> Res<()> {
        let conn = self.conn()?;
        match kept {
            None => conn.execute("DELETE FROM sessions WHERE id = ?1", [id]),
            Some(why) => conn.execute(
                &format!("UPDATE sessions SET removed_at = {NOW_MS}, status = 'done', action = ?2 WHERE id = ?1"),
                params![id, why],
            ),
        }
        .map_err(err)?;
        Ok(())
    }
}

const SESSION_COLS: &str = "id, project_id, node_id, role, repo, worktree, branch, tmux_name, claude_session_id, token, status, action";

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<AgentSession> {
    Ok(AgentSession {
        id: r.get(0)?,
        project_id: r.get(1)?,
        node_id: r.get(2)?,
        role: r.get(3)?,
        repo: r.get(4)?,
        worktree: r.get(5)?,
        branch: r.get(6)?,
        tmux_name: r.get(7)?,
        claude_session_id: r.get(8)?,
        token: r.get(9)?,
        status: r.get(10)?,
        action: r.get(11)?,
    })
}

fn project_row(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        path: r.get(2)?,
        position: r.get(3)?,
        created_at: r.get(4)?,
        last_opened_at: r.get(5)?,
    })
}

fn json_col(s: String) -> rusqlite::Result<serde_json::Value> {
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("ceo.db");
    println!("store: database at {}", path.display());
    app.manage(Store::open(&path)?);
    Ok(())
}

#[tauri::command(async)]
pub fn project_list(s: State<Store>) -> Res<Vec<Project>> {
    s.list_projects()
}
#[tauri::command(async)]
pub fn project_create(s: State<Store>, name: String, path: String) -> Res<Project> {
    s.create_project(&name, &path)
}
#[tauri::command(async)]
pub fn project_update(s: State<Store>, id: String, name: String, path: String) -> Res<Project> {
    s.update_project(&id, &name, &path)
}
#[tauri::command(async)]
pub fn project_touch(s: State<Store>, id: String) -> Res<Project> {
    s.touch_project(&id)
}
#[tauri::command(async)]
pub fn project_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    s: State<Store>,
    id: String,
) -> Res<()> {
    crate::sessions::remove_project(&app, &id);
    s.delete_project(&id)
}
#[tauri::command(async)]
pub fn project_reorder(s: State<Store>, ids: Vec<String>) -> Res<()> {
    s.reorder_projects(&ids)
}
#[tauri::command(async)]
pub fn board_load(s: State<Store>, project_id: String) -> Res<Board> {
    s.load_board(&project_id)
}
#[tauri::command(async)]
pub fn board_save(s: State<Store>, project_id: String, changes: BoardChanges) -> Res<()> {
    s.save_board(&project_id, &changes)
}

#[cfg(test)]
mod ipc_tests;
#[cfg(test)]
mod tests;
