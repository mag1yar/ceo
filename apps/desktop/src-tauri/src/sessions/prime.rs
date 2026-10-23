//! What SessionStart (startup, resume, clear, compact) hands a session: the CEO's memory and the app's state, board notes for others.

use super::memory;
use crate::store::{AgentSession, Store};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};

/// Claude Code's own cap on a hook's context; past it the text becomes a file and a preview.
pub const CAP: usize = 10_000;

const AGENTS: &[&str] = &["ceo", "lead", "member", "executor"];

/// Sections in priority order, each cut to what the cap leaves, so the lowest go first.
pub fn fit(sections: &[(String, Vec<String>)], cap: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for (title, lines) in sections.iter().filter(|(_, l)| !l.is_empty()) {
        for line in std::iter::once(title).chain(lines) {
            let n = line.chars().count() + 1;
            if len + n > cap {
                // A long line (a note's text) keeps the start that fits.
                let rest: String = line.chars().take(cap.saturating_sub(len + 1)).collect();
                if !rest.is_empty() {
                    out += &rest;
                    out.push('\n');
                }
                return out;
            }
            out += line;
            out.push('\n');
            len += n;
        }
        if len < cap {
            out.push('\n');
            len += 1;
        }
    }
    out
}

fn rules(dir: &str) -> String {
    format!(
        "Your memory is the folder {dir}, a git repo this app owns. core.md (at most {} characters) is loaded at every \
         session start, after /clear and after compaction: keep there what you must never lose (the owner's preferences, \
         decisions, the state of the current wave). Put the rest in notes/<slug>.md, first line a one-line description; \
         read a note when you need it. Edit these files directly; the app commits each change when your turn ends. \
         The app clears your context when a wave is over, so write down what matters before you report the wave done.",
        memory::CORE_CAP
    )
}

/// The CEO's prime, from parts the caller gathered; `snapshot` is the summary line, `details` one line per agent.
pub fn ceo(
    dir: &str,
    core: &str,
    snapshot: &str,
    index: Vec<String>,
    notes: Vec<String>,
    details: Vec<String>,
) -> String {
    let core: String = core.chars().take(memory::CORE_CAP).collect();
    fit(
        &[
            ("# Your memory".into(), vec![rules(dir)]),
            (
                "## core.md".into(),
                core.lines().map(str::to_string).collect(),
            ),
            ("## Now, from the app".into(), vec![snapshot.into()]),
            ("## Notes in your memory folder".into(), index),
            ("## Board notes linked to you".into(), notes),
            ("## Agents on the board".into(), details),
        ],
        CAP,
    )
}

/// Board notes linked to the node by an edge, either way.
fn linked_notes(
    nodes: &[crate::store::BoardNode],
    edges: &[crate::store::BoardEdge],
    node: &str,
) -> Vec<String> {
    edges
        .iter()
        .filter_map(|e| match (e.source == node, e.target == node) {
            (true, _) => Some(&e.target),
            (_, true) => Some(&e.source),
            _ => None,
        })
        .filter_map(|id| nodes.iter().find(|n| &n.id == id && n.kind == "note"))
        .filter_map(|n| n.data["text"].as_str())
        .map(|t| t.trim().replace('\n', " "))
        .filter(|t| !t.is_empty())
        .map(|t| format!("- {t}"))
        .collect()
}

pub fn for_session<R: Runtime>(app: &AppHandle<R>, row: &AgentSession) -> String {
    let store = app.state::<Store>();
    let board = store
        .load_board(&row.project_id)
        .unwrap_or_else(|_| crate::store::Board {
            viewport: json!({}),
            nodes: vec![],
            edges: vec![],
        });
    let notes = linked_notes(&board.nodes, &board.edges, &row.node_id);
    if row.role != "ceo" {
        return fit(&[("## Board notes linked to you".into(), notes)], CAP);
    }
    let dir = memory::dir(app, &row.project_id);
    if let Err(e) = memory::ensure(&dir) {
        println!("memory: {e}");
    }
    let sessions = store.project_sessions(&row.project_id).unwrap_or_default();
    let live: Vec<&str> = sessions
        .iter()
        .filter(|s| s.parent.as_deref() == Some(&row.node_id))
        .filter_map(|s| {
            board
                .nodes
                .iter()
                .find(|n| n.id == s.node_id)
                .and_then(|n| n.data["name"].as_str())
        })
        .collect();
    let waiting = store
        .inbox(&row.project_id, &row.node_id)
        .map_or(0, |l| l.len());
    let snapshot = match live.len() {
        0 => format!(
            "Wave state: no executors live, {waiting} unaccepted messages for you; the last wave is over."
        ),
        n => format!(
            "Wave state: {n} executor{} live ({}), {waiting} unaccepted messages for you.",
            if n == 1 { "" } else { "s" },
            live.join("; ")
        ),
    };
    let details = board
        .nodes
        .iter()
        .filter(|n| AGENTS.contains(&n.kind.as_str()))
        .map(|n| {
            let name = n.data["name"].as_str().unwrap_or("?");
            match sessions.iter().find(|s| s.node_id == n.id) {
                Some(s) => format!(
                    "- {name} ({}): {}, {}, branch {}",
                    n.kind,
                    s.status,
                    s.action,
                    s.branch.as_deref().unwrap_or("-")
                ),
                None => format!("- {name} ({}): no session", n.kind),
            }
        })
        .collect();
    ceo(
        &dir.to_string_lossy(),
        &memory::core(&dir),
        &snapshot,
        memory::index(&dir),
        notes,
        details,
    )
}

/// Takes claude's session id when it changed (a `/clear` starts a new one), then answers with the prime.
pub fn session_start<R: Runtime>(
    app: &AppHandle<R>,
    row: &AgentSession,
    event: &Value,
) -> Option<Value> {
    if let Some(id) = event["session_id"]
        .as_str()
        .filter(|id| *id != row.claude_session_id)
        && let Err(e) = app.state::<Store>().set_claude_session_id(&row.id, id)
    {
        println!("sessions: {e}");
    }
    let text = for_session(app, row);
    (!text.is_empty()).then(|| {
        json!({ "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": text,
        } })
    })
}
