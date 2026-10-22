//! Bus messages: stored on send, `waiting` once delivered, `accepted` only by the recipient's explicit call.

use super::{Message, NOW_MS, Res, Store, err};
use rusqlite::{OptionalExtension, params};

const COLS: &str = "id, project_id, from_node, to_node, thread, kind, body, state, delivered_via, sent_at, waiting_at, accepted_at, closed_at";
/// What the board still draws: open, and unaccepted or an ask whose reply is not accepted yet.
const LIVE: &str = "closed_at IS NULL AND (state <> 'accepted' OR (kind = 'ask' AND NOT EXISTS (
    SELECT 1 FROM messages r WHERE r.thread = messages.thread AND r.kind = 'reply' AND r.state = 'accepted')))";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: r.get(0)?,
        project_id: r.get(1)?,
        from: r.get(2)?,
        to: r.get(3)?,
        thread: r.get(4)?,
        kind: r.get(5)?,
        body: r.get(6)?,
        state: r.get(7)?,
        delivered_via: r.get(8)?,
        sent_at: r.get(9)?,
        waiting_at: r.get(10)?,
        accepted_at: r.get(11)?,
        closed_at: r.get(12)?,
    })
}

impl Store {
    fn query_messages(&self, filter: &str, args: &[&str]) -> Res<Vec<Message>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM messages WHERE {filter} ORDER BY sent_at, rowid"
            ))
            .map_err(err)?;
        stmt.query_map(rusqlite::params_from_iter(args), row)
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }

    /// Stores a message as `sent`; a message without a thread starts its own.
    pub fn add_message(
        &self,
        project_id: &str,
        from: &str,
        to: &str,
        kind: &str,
        body: &str,
        thread: Option<&str>,
    ) -> Res<Message> {
        self.conn()?
            .query_row(
                &format!(
                    "INSERT INTO messages (id, project_id, from_node, to_node, thread, kind, body, state, sent_at)
                     SELECT id, ?1, ?2, ?3, COALESCE(?6, id), ?4, ?5, 'sent', {NOW_MS}
                     FROM (SELECT lower(hex(randomblob(8))) AS id)
                     RETURNING {COLS}"
                ),
                params![project_id, from, to, kind, body, thread],
                row,
            )
            .map_err(err)
    }

    pub fn message(&self, id: &str) -> Res<Option<Message>> {
        Ok(self.query_messages("id = ?1", &[id])?.pop())
    }

    /// Stored but not yet delivered to the node.
    pub fn undelivered(&self, project_id: &str, to: &str) -> Res<Vec<Message>> {
        self.query_messages(
            "project_id = ?1 AND to_node = ?2 AND state = 'sent' AND closed_at IS NULL",
            &[project_id, to],
        )
    }

    /// Everything the node has not accepted yet.
    pub fn inbox(&self, project_id: &str, to: &str) -> Res<Vec<Message>> {
        self.query_messages(
            "project_id = ?1 AND to_node = ?2 AND state <> 'accepted' AND closed_at IS NULL",
            &[project_id, to],
        )
    }

    /// The first reply in a thread addressed to `to`, accepted or not.
    pub fn reply_in(&self, thread: &str, to: &str) -> Res<Option<Message>> {
        Ok(self
            .query_messages(
                "thread = ?1 AND to_node = ?2 AND kind = 'reply'",
                &[thread, to],
            )?
            .into_iter()
            .next())
    }

    /// What the board draws after a restart: unaccepted messages, and asks still waiting for an accepted reply.
    pub fn list_messages(&self, project_id: &str) -> Res<Vec<Message>> {
        self.query_messages(&format!("project_id = ?1 AND {LIVE}"), &[project_id])
    }

    /// Closes what the board still draws to or from a node that is gone; their state stays, accepted is never set here.
    pub fn close_messages(&self, project_id: &str, node: &str) -> Res<Vec<Message>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "UPDATE messages SET closed_at = {NOW_MS}
                 WHERE project_id = ?1 AND (to_node = ?2 OR from_node = ?2) AND {LIVE} RETURNING {COLS}"
            ))
            .map_err(err)?;
        stmt.query_map(params![project_id, node], row)
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)
    }

    /// `sent` -> `waiting`; None when it was already delivered, so two paths never deliver one message twice.
    pub fn mark_waiting(&self, id: &str, via: &str) -> Res<Option<Message>> {
        self.conn()?
            .query_row(
                &format!(
                    "UPDATE messages SET state = 'waiting', delivered_via = ?2, waiting_at = {NOW_MS}
                     WHERE id = ?1 AND state = 'sent' RETURNING {COLS}"
                ),
                params![id, via],
                row,
            )
            .optional()
            .map_err(err)
    }

    /// Only the recipient accepts, and only once.
    pub fn accept_message(&self, id: &str, by: &str) -> Res<Message> {
        let found = self
            .conn()?
            .query_row(
                &format!(
                    "UPDATE messages SET state = 'accepted', accepted_at = {NOW_MS},
                       waiting_at = COALESCE(waiting_at, {NOW_MS})
                     WHERE id = ?1 AND to_node = ?2 AND state <> 'accepted' RETURNING {COLS}"
                ),
                params![id, by],
                row,
            )
            .optional()
            .map_err(err)?;
        found.ok_or_else(|| match self.message(id) {
            Ok(Some(m)) if m.to != by => format!("message {id} is not addressed to you"),
            Ok(Some(_)) => format!("message {id} is already accepted"),
            _ => format!("no message {id}"),
        })
    }
}
