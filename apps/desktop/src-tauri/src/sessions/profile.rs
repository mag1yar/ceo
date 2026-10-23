//! Model and effort per role: `profiles.json` built in, overridden key by key by `<app data>/profiles.json`.

use serde_json::Value;
use std::path::Path;

const DEFAULTS: &str = include_str!("../../profiles.json");

/// Read on every launch, so an edited file applies to the next session without a rebuild.
pub fn load(dir: &Path) -> Value {
    let mut all: Value = serde_json::from_str(DEFAULTS).expect("profiles.json");
    let over: Value = std::fs::read_to_string(dir.join("profiles.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for (role, fields) in over.as_object().into_iter().flatten() {
        for (k, v) in fields.as_object().into_iter().flatten() {
            all[role][k] = v.clone();
        }
    }
    all
}

pub fn get(profiles: &Value, role: &str, key: &str) -> Option<String> {
    profiles[role][key].as_str().map(str::to_string)
}

/// Spawn arguments beat the node's model in the UI, which beats the role's profile; effort has no node setting.
pub fn pick(
    profiles: &Value,
    role: &str,
    explicit: &Value,
    node_model: Option<&str>,
) -> (Option<String>, Option<String>) {
    let model = explicit["model"]
        .as_str()
        .or(node_model)
        .map(str::to_string)
        .or_else(|| get(profiles, role, "model"));
    let effort = explicit["effort"]
        .as_str()
        .map(str::to_string)
        .or_else(|| get(profiles, role, "effort"));
    (model, effort)
}

/// The CEO's and a Lead's advice on which model to hand out, from the file so it changes without code.
pub fn advice(profiles: &Value) -> String {
    let m = |role| get(profiles, role, "model").unwrap_or_else(|| "sonnet".into());
    format!(
        "Pick the model for each session you start: {} for mechanical work (renames, formatting, moving files), {} for reviews, otherwise leave it unset.",
        m("mechanical"),
        m("review")
    )
}

/// Auto-compaction stays as the CEO's backstop; its summary keeps a fixed handoff shape.
pub const COMPACTION: &str = "When your context is compacted, write the summary with exactly these sections: \
    Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context. Durable facts belong in your memory folder, not only in the summary.";

/// The model set on the session's node in the UI.
pub fn node_model(store: &crate::store::Store, row: &crate::store::AgentSession) -> Option<String> {
    store
        .load_board(&row.project_id)
        .ok()?
        .nodes
        .into_iter()
        .find(|n| n.id == row.node_id)?
        .data["model"]
        .as_str()
        .map(str::to_string)
}
