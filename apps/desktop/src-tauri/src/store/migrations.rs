use rusqlite::Connection;

// Append only: the index + 1 of an entry is its schema version (PRAGMA user_version).
const MIGRATIONS: &[&str] = &[
    "
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
",
    "
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    role TEXT NOT NULL,
    repo TEXT NOT NULL,
    worktree TEXT,
    branch TEXT,
    tmux_name TEXT NOT NULL,
    claude_session_id TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER
);
CREATE UNIQUE INDEX sessions_node ON sessions (project_id, node_id) WHERE removed_at IS NULL;
",
    "
ALTER TABLE sessions ADD COLUMN parent TEXT;
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    thread TEXT NOT NULL,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sent', 'waiting', 'accepted')),
    delivered_via TEXT CHECK (delivered_via IN ('typed', 'post_tool_use', 'stop')),
    sent_at INTEGER NOT NULL,
    waiting_at INTEGER,
    accepted_at INTEGER
);
CREATE INDEX messages_to ON messages (project_id, to_node, state);
",
];

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
