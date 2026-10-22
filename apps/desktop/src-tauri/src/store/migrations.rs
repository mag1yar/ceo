use rusqlite::Connection;

// Append only: the index + 1 of an entry is its schema version (PRAGMA user_version).
const MIGRATIONS: &[&str] = &["
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER
);
CREATE TABLE boards (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    viewport TEXT NOT NULL
);
CREATE TABLE board_nodes (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type <> ''),
    x REAL NOT NULL,
    y REAL NOT NULL,
    width REAL,
    height REAL,
    data TEXT NOT NULL,
    z INTEGER NOT NULL,
    PRIMARY KEY (project_id, id)
);
CREATE TABLE board_edges (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
);
"];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    // Refuse a database written by a newer build instead of running queries on an unknown schema.
    if current < 0 || current as usize > MIGRATIONS.len() {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "unsupported schema version {current}"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}
