//! The CEO's memory: `<app data>/memory/<project>/`, a git repo the app owns, and the reset at a wave boundary.

use super::{Res, Sessions, hooks, usage};
use crate::store::{AgentSession, Store};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

pub const CORE_CAP: usize = 8000;

pub fn dir<R: Runtime>(app: &AppHandle<R>, project_id: &str) -> PathBuf {
    app.state::<Sessions>().dir.join("memory").join(project_id)
}

fn git(dir: &Path, args: &[&str]) -> Res<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The folder and its repo on first use; the identity is set in this repo only.
pub fn ensure(dir: &Path) -> Res<()> {
    std::fs::create_dir_all(dir.join("notes")).map_err(|e| e.to_string())?;
    if !dir.join(".git").exists() {
        git(dir, &["init", "-q"])?;
        git(dir, &["config", "user.name", "CEO memory"])?;
        git(dir, &["config", "user.email", "memory@ceo.local"])?;
        git(dir, &["config", "commit.gpgsign", "false"])?;
    }
    Ok(())
}

/// Commits every change as `memory: <files>`; None when nothing changed.
pub fn commit(dir: &Path) -> Res<Option<String>> {
    ensure(dir)?;
    git(dir, &["add", "-A"])?;
    let files = git(dir, &["diff", "--cached", "--name-only"])?;
    if files.is_empty() {
        return Ok(None);
    }
    let msg = format!("memory: {}", files.lines().collect::<Vec<_>>().join(", "));
    git(dir, &["commit", "-q", "--no-verify", "-m", &msg])?;
    Ok(Some(msg))
}

/// `core.md`, cut to its cap.
pub fn core(dir: &Path) -> String {
    let text = std::fs::read_to_string(dir.join("core.md")).unwrap_or_default();
    text.chars().take(CORE_CAP).collect()
}

/// `notes/<slug>.md` with the first line of each, which is its description.
pub fn index(dir: &Path) -> Vec<String> {
    let mut list: Vec<String> = std::fs::read_dir(dir.join("notes"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
        .map(|e| {
            let text = std::fs::read_to_string(e.path()).unwrap_or_default();
            let first = text
                .lines()
                .next()
                .unwrap_or("")
                .trim_start_matches('#')
                .trim();
            format!("- notes/{}: {first}", e.file_name().to_string_lossy())
        })
        .collect();
    list.sort();
    list
}

/// After an accepted report: with no child left and nothing unaccepted, the wave is over, so the CEO
/// is cleared once it sits idle at an empty prompt, and the prime on its SessionStart reloads the memory.
pub fn wave_end<R: Runtime>(app: &AppHandle<R>, exec: &AgentSession, accepted: bool) {
    let store = app.state::<Store>();
    let Ok(Some(ceo)) = store.node_session(&exec.project_id, exec.parent.as_deref().unwrap_or(""))
    else {
        return;
    };
    let busy = |ceo: &AgentSession| {
        store.project_sessions(&ceo.project_id).map_or(true, |l| {
            l.iter().any(|r| r.parent.as_deref() == Some(&ceo.node_id))
        }) || store
            .inbox(&ceo.project_id, &ceo.node_id)
            .map_or(true, |l| !l.is_empty())
    };
    // Reports accepted together end one wave: the first retire clears, the rest stand down.
    static CLEARING: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let clearing = || CLEARING.lock().unwrap_or_else(|e| e.into_inner());
    if !accepted || ceo.role != "ceo" || busy(&ceo) {
        return;
    }
    {
        let mut c = clearing();
        if c.contains(&ceo.id) {
            return;
        }
        c.push(ceo.id.clone());
    }
    wait_and_clear(app, &ceo, busy);
    clearing().retain(|id| id != &ceo.id);
}

fn wait_and_clear<R: Runtime>(
    app: &AppHandle<R>,
    ceo: &AgentSession,
    busy: impl Fn(&AgentSession) -> bool,
) {
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        let Ok(Some(row)) = store.session(&ceo.id) else {
            return;
        };
        // A new task or message meanwhile means the wave goes on.
        if busy(&row) {
            return;
        }
        let quiet = s
            .heard()
            .get(&row.id)
            .is_none_or(|t| t.elapsed() >= Duration::from_millis(500));
        let Ok(tmux) = s.tmux() else { return };
        if row.status != "idle"
            || row.action == "Starting"
            || !quiet
            || !hooks::prompt_empty(&tmux.capture_styled(&row.tmux_name))
            || !s.nudging().insert(row.id.clone())
        {
            continue;
        }
        usage::wave_mark(app, &row);
        let typed = tmux.type_text(&row.tmux_name, "/clear").and_then(|()| {
            std::thread::sleep(Duration::from_millis(150));
            tmux.key(&row.tmux_name, "Enter")
        });
        s.nudging().remove(&row.id);
        if let Err(e) = typed {
            println!("memory: could not clear {}: {e}", row.tmux_name);
        }
        return;
    }
}
