//! Marks a worktree the app created as trusted in Claude Code's `.claude.json`, so its session never stops on the trust dialog.
//! A parent entry does not cover a git checkout below it (claude 2.1.308), so each worktree gets its own entry.

use serde_json::{Map, Value};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Where claude keeps its global state: `$CLAUDE_CONFIG_DIR/.claude.json`, else `$HOME/.claude.json`.
pub fn config_file() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .or_else(|| std::env::var_os("HOME"))
        .map(|d| PathBuf::from(d).join(".claude.json"))
}

/// The key claude looks up: the real path, as its cwd resolves symlinks like /tmp.
pub fn key(dir: &str) -> String {
    std::fs::canonicalize(dir).map_or_else(|_| dir.into(), |p| p.to_string_lossy().into_owned())
}

/// Sets `projects.<dir>.hasTrustDialogAccepted`, or drops the whole entry; every other key keeps its value and place.
pub fn set(file: &Path, dir: &str, trusted: bool) -> Result<(), String> {
    static WRITING: Mutex<()> = Mutex::new(());
    let _w = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    // A dotfiles symlink stays a symlink: the rename lands on its target.
    let file = std::fs::canonicalize(file).unwrap_or_else(|_| file.into());
    let mut root = match std::fs::read_to_string(&file) {
        Ok(s) => serde_json::from_str::<Value>(&s)
            .map_err(|e| format!("{} is not JSON, left alone: {e}", file.display()))?,
        Err(e) if e.kind() == ErrorKind::NotFound && trusted => Value::Object(Map::new()),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", file.display())),
    };
    let not_object = || format!("{} has no projects object, left alone", file.display());
    let projects = root
        .as_object_mut()
        .ok_or_else(not_object)?
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(not_object)?;
    if trusted {
        projects
            .entry(dir)
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(not_object)?
            .insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    } else if projects.shift_remove(dir).is_none() {
        return Ok(());
    }
    let tmp = file.with_file_name(format!(".claude.json.ceo-{}", std::process::id()));
    let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    // 0600 from the first byte, like claude's own file: it holds the account details.
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}
