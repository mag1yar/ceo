use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[ts(type = "number")]
    pub position: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub last_opened_at: Option<i64>,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardNode {
    pub id: String,
    #[serde(rename = "type")]
    #[ts(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    #[ts(type = "unknown")]
    pub data: Value,
    #[ts(type = "number")]
    pub z: i64,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[ts(type = "unknown")]
    pub data: Value,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    #[ts(type = "unknown")]
    pub viewport: Value,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardChanges {
    #[ts(type = "unknown | null")]
    pub viewport: Option<Value>,
    pub upsert_nodes: Vec<BoardNode>,
    pub delete_node_ids: Vec<String>,
    pub upsert_edges: Vec<BoardEdge>,
    pub delete_edge_ids: Vec<String>,
}

/// One `claude` in tmux behind an agent node; `worktree` and `branch` are absent for a non-git project.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub project_id: String,
    pub node_id: String,
    pub role: String,
    pub repo: String,
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub tmux_name: String,
    pub claude_session_id: String,
    #[serde(skip)]
    #[ts(skip)]
    pub token: String,
    pub status: String,
    pub action: String,
    /// The node that spawned this session: an executor's CEO.
    pub parent: Option<String>,
}

/// One bus message; serialises to the `Message` contract in `src/features/messages/messages.ts`.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub project_id: String,
    pub from: String,
    pub to: String,
    pub thread: String,
    pub kind: String,
    pub body: String,
    pub state: String,
    pub delivered_via: Option<String>,
    pub sent_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_at: Option<i64>,
    /// Set when its executor is retired unaccepted; the board drops it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
}
