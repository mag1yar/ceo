//! Agent sessions: `claude` in tmux on our own socket, one git worktree each, status from Claude Code hooks.

mod hooks;
mod tmux;
mod worktree;

use crate::store::{AgentSession, Store};
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tmux::Tmux;

type Res<T> = Result<T, String>;

pub const STATUS_EVENT: &str = "session-status";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusChange<'a> {
    project_id: &'a str,
    node_id: &'a str,
    status: &'a str,
    action: &'a str,
}

struct Bins {
    tmux: String,
    claude: String,
    // The login shell's PATH: a Finder-started app lacks Homebrew's, and so would claude's tools.
    path: String,
}

pub struct Sessions {
    dir: PathBuf,
    socket: String,
    port: u16,
    bins: OnceLock<Res<Bins>>,
    // Serialises start and removal, so a node mount and the startup reconcile never race on one session.
    ops: Mutex<()>,
    heard: Mutex<HashMap<String, Instant>>,
}

#[cfg(not(feature = "e2e"))]
fn socket() -> String {
    "ceo".into()
}

// tmux sockets live in TMUX_TMPDIR or /tmp, outside the throwaway HOME, so each run names its own.
#[cfg(feature = "e2e")]
fn socket() -> String {
    std::env::var("CEO_E2E_TMUX").unwrap_or_else(|_| format!("ceo-e2e-{}", std::process::id()))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .expect("/dev/urandom");
    b
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn uuid() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

// A login shell that hangs (a prompt in .zprofile) must not hang the app.
fn login_shell(script: &str) -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(mut child) = Command::new(shell)
        .args(["-lc", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    out
}

fn resolve_bins() -> Res<Bins> {
    let out = login_shell(
        r#"printf '\nceo-tmux=%s\nceo-claude=%s\nceo-path=%s\n' "$(command -v tmux)" "$(command -v claude)" "$PATH""#,
    );
    // Startup files may print anything, so take the marked lines.
    let found = |key: &str| {
        out.lines()
            .rev()
            .find_map(|l| l.strip_prefix(key))
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let pick = |env: &str, key: &str, name: &str| {
        std::env::var(env)
            .ok()
            .or_else(|| found(key))
            .ok_or_else(|| {
                format!("{name} not found in the login shell's PATH; install it or set {env}")
            })
    };
    let process_path = std::env::var("PATH").unwrap_or_default();
    let path = match found("ceo-path=") {
        Some(p) => format!("{p}:{process_path}"),
        None => process_path,
    };
    Ok(Bins {
        tmux: pick("CEO_TMUX_BIN", "ceo-tmux=", "tmux")?,
        claude: pick("CEO_CLAUDE_BIN", "ceo-claude=", "claude")?,
        path,
    })
}

// The previous run's port when it is free, so claude sessions that outlived the app keep reaching their hooks.
fn bind(dir: &Path) -> std::io::Result<TcpListener> {
    let file = dir.join("hooks-port");
    let last = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok());
    let listener = last
        .and_then(|p| TcpListener::bind(("127.0.0.1", p)).ok())
        .map_or_else(|| TcpListener::bind(("127.0.0.1", 0)), Ok)?;
    let port = listener.local_addr()?.port();
    if last.is_some_and(|p| p != port) {
        println!(
            "sessions: hooks port {last:?} is taken, now {port}; claude sessions still running post to the old one"
        );
    }
    std::fs::write(file, port.to_string())?;
    Ok(listener)
}

impl Sessions {
    fn bins(&self) -> Res<&Bins> {
        self.bins
            .get_or_init(resolve_bins)
            .as_ref()
            .map_err(Clone::clone)
    }

    fn tmux(&self) -> Res<Tmux> {
        Ok(Tmux {
            bin: self.bins()?.tmux.clone(),
            socket: self.socket.clone(),
        })
    }

    pub fn attach_argv(&self, name: &str) -> Res<Vec<String>> {
        Ok(self.tmux()?.attach_argv(name))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.ops.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn heard(&self) -> std::sync::MutexGuard<'_, HashMap<String, Instant>> {
        self.heard.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session_dir(&self, id: &str) -> PathBuf {
        self.dir.join("sessions").join(id)
    }

    fn create(
        &self,
        store: &Store,
        project_id: &str,
        node_id: &str,
        role: &str,
    ) -> Res<AgentSession> {
        let repo = store
            .list_projects()?
            .into_iter()
            .find(|p| p.id == project_id)
            .ok_or("no such project")?
            .path;
        let id = uuid();
        let short = &id[..8];
        // A non-git project runs the session in the project folder itself.
        let (worktree, branch) = match worktree::head(&repo) {
            Some(base) => {
                let path = self.dir.join("worktrees").join(project_id).join(&id);
                let path = path.to_string_lossy().into_owned();
                let branch = format!("ceo/{role}-{short}");
                worktree::add(&repo, &path, &branch, &base)?;
                (Some(path), Some(branch))
            }
            None => (None, None),
        };
        let row = AgentSession {
            id: id.clone(),
            project_id: project_id.into(),
            node_id: node_id.into(),
            role: role.into(),
            repo,
            worktree,
            branch,
            tmux_name: format!("{role}-{short}"),
            claude_session_id: id,
            token: hex(&random_bytes::<32>()),
            status: "idle".into(),
            action: "Starting".into(),
        };
        if let Err(e) = store.insert_session(&row) {
            // No row would ever track this worktree, so take it back now (still without force).
            if let (Some(path), Some(branch)) = (&row.worktree, &row.branch) {
                let _ = worktree::remove(&row.repo, path, branch);
            }
            return Err(e);
        }
        Ok(row)
    }

    fn launch(&self, row: &AgentSession, size: (u16, u16), mode: &str) -> Res<()> {
        let bins = self.bins()?;
        let dir = self.session_dir(&row.id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Outside the worktree, so the token never lands in the agent's repo.
        let settings = dir.join("settings.json");
        let url = format!("http://127.0.0.1:{}/hook/{}", self.port, row.id);
        std::fs::write(&settings, hooks::settings(&url, &row.token).to_string())
            .map_err(|e| e.to_string())?;
        let settings = settings.to_string_lossy();
        // A project at a subfolder of its repo runs claude at the same subfolder of the worktree.
        let cwd = match &row.worktree {
            Some(wt) => Path::new(wt).join(worktree::prefix(&row.repo)),
            None => PathBuf::from(&row.repo),
        };
        let cwd = cwd.to_string_lossy();
        let mut env = vec![("PATH", bins.path.as_str())];
        if std::env::var_os("LANG").is_none() {
            env.push(("LANG", "en_US.UTF-8"));
        }
        self.tmux()?.start(
            &row.tmux_name,
            &cwd,
            size,
            &env,
            &[
                &bins.claude,
                "--dangerously-skip-permissions",
                "--settings",
                &settings,
                mode,
                &row.claude_session_id,
            ],
        )
    }

    /// Runs claude for a row whose tmux session is gone: resume, else a fresh start under the same id.
    fn restart(&self, row: &AgentSession, size: (u16, u16)) -> Res<()> {
        let tmux = self.tmux()?;
        // Only a session that got a prompt has a transcript; --resume of any other exits at once.
        for mode in ["--resume", "--session-id"] {
            let _ = self.launch(row, size, mode);
            let deadline = Instant::now() + Duration::from_secs(2);
            while tmux.has(&row.tmux_name) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
            }
            if tmux.has(&row.tmux_name) {
                return Ok(());
            }
        }
        Err("claude exited right after it started".into())
    }

    fn remove(&self, store: &Store, row: &AgentSession) -> Res<()> {
        let _op = self.lock();
        if let Ok(tmux) = self.tmux() {
            let _ = tmux.kill(&row.tmux_name);
        }
        let kept = match (&row.worktree, &row.branch) {
            (Some(path), Some(branch)) => worktree::remove(&row.repo, path, branch).err(),
            _ => None,
        };
        if let Some(why) = &kept {
            println!("sessions: {why}");
        }
        store.remove_session(&row.id, kept.as_deref())?;
        let _ = std::fs::remove_dir_all(self.session_dir(&row.id));
        self.heard().remove(&row.id);
        Ok(())
    }
}

fn report<R: Runtime>(
    app: &AppHandle<R>,
    project_id: &str,
    node_id: &str,
    status: &str,
    action: &str,
) {
    if let Ok(Some(row)) = app.state::<Store>().node_session(project_id, node_id) {
        let _ = app
            .state::<Store>()
            .set_session_status(&row.id, status, action);
    }
    let _ = app.emit(
        STATUS_EVENT,
        StatusChange {
            project_id,
            node_id,
            status,
            action,
        },
    );
}

/// Live rows whose tmux session is gone, and tmux sessions on our socket that no row knows.
fn reconcile<'a>(
    rows: &'a [AgentSession],
    live: &'a [String],
) -> (Vec<&'a AgentSession>, Vec<&'a String>) {
    let dead = rows
        .iter()
        .filter(|r| !live.contains(&r.tmux_name))
        .collect();
    let orphans = live
        .iter()
        .filter(|n| !rows.iter().any(|r| &r.tmux_name == *n))
        .collect();
    (dead, orphans)
}

fn on_hook<R: Runtime>(app: &AppHandle<R>, id: &str, auth: Option<&str>, body: &[u8]) -> u16 {
    let store = app.state::<Store>();
    let Ok(Some(row)) = store.session(id) else {
        return 401;
    };
    if !hooks::token_ok(&row.token, auth) {
        return 401;
    }
    let Ok(event) = serde_json::from_slice::<serde_json::Value>(body) else {
        return 400;
    };
    app.state::<Sessions>()
        .heard()
        .insert(row.id.clone(), Instant::now());
    if let Some((status, action)) = hooks::status_for(&event) {
        report(app, &row.project_id, &row.node_id, status, &action);
    }
    200
}

fn watchdog<R: Runtime>(app: AppHandle<R>) {
    let since = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
        let (Ok(tmux), Ok(rows)) = (s.tmux(), store.live_sessions()) else {
            continue;
        };
        for row in rows.iter().filter(|r| r.status == "working") {
            let last = s.heard().get(&row.id).copied().unwrap_or(since);
            if hooks::missed_stop(&row.status, last.elapsed(), &tmux.capture(&row.tmux_name)) {
                report(&app, &row.project_id, &row.node_id, "idle", "Interrupted");
            }
        }
    }
}

pub fn init(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let listener = bind(&dir)?;
    let port = listener.local_addr()?.port();
    let handle = app.handle().clone();
    hooks::serve(
        listener,
        Arc::new(move |id, auth, body| on_hook(&handle, id, auth, body)),
    );
    app.manage(Sessions {
        dir,
        socket: socket(),
        port,
        bins: OnceLock::new(),
        ops: Mutex::default(),
        heard: Mutex::default(),
    });
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        let (s, store) = (handle.state::<Sessions>(), handle.state::<Store>());
        let tmux = match s.tmux() {
            Ok(t) => t,
            Err(e) => return println!("sessions: {e}"),
        };
        let rows = store.live_sessions().unwrap_or_default();
        let live = tmux.list();
        let (dead, orphans) = reconcile(&rows, &live);
        for name in orphans {
            println!("sessions: tmux session {name} has no row, left alone");
        }
        for row in dead {
            let _op = s.lock();
            match s.restart(row, (220, 50)) {
                Ok(()) => println!("sessions: restarted {}", row.tmux_name),
                Err(e) => report(
                    &handle,
                    &row.project_id,
                    &row.node_id,
                    "error",
                    &format!("Could not resume: {e}"),
                ),
            }
        }
        watchdog(handle.clone());
    });
    Ok(())
}

/// Ends every session of a project that is being deleted, keeping any work git refuses to drop.
pub fn remove_project<R: Runtime>(app: &AppHandle<R>, project_id: &str) {
    let (Some(s), Some(store)) = (app.try_state::<Sessions>(), app.try_state::<Store>()) else {
        return;
    };
    for row in store.project_sessions(project_id).unwrap_or_default() {
        if let Err(e) = s.remove(&store, &row) {
            println!("sessions: {e}");
        }
    }
}

/// The node's session, started or restarted as needed; None for nodes that keep a login shell.
#[tauri::command(async)]
pub fn session_ensure<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    node_id: String,
    cols: u16,
    rows: u16,
) -> Res<Option<AgentSession>> {
    let store = app.state::<Store>();
    // shortcut: only the CEO runs claude; Leads and Members stay shells until #19 spawns them.
    if store.node_role(&project_id, &node_id)?.as_deref() != Some("ceo") {
        return Ok(None);
    }
    let s = app.state::<Sessions>();
    let ensure = || -> Res<AgentSession> {
        let _op = s.lock();
        let tmux = s.tmux()?;
        let row = match store.node_session(&project_id, &node_id)? {
            Some(row) if tmux.has(&row.tmux_name) => return Ok(row),
            Some(row) => {
                s.restart(&row, (cols, rows))?;
                row
            }
            None => {
                let row = s.create(&store, &project_id, &node_id, "ceo")?;
                // The node switches off the mock pool now, not at the first hook (onboarding sends none).
                report(&app, &project_id, &node_id, &row.status, &row.action);
                s.launch(&row, (cols, rows), "--session-id")?;
                row
            }
        };
        store
            .session(&row.id)?
            .ok_or_else(|| "session vanished".into())
    };
    ensure()
        .inspect_err(|e| report(&app, &project_id, &node_id, "error", e))
        .map(Some)
}

#[tauri::command(async)]
pub fn session_delete<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
    node_id: String,
) -> Res<()> {
    let store = app.state::<Store>();
    match store.node_session(&project_id, &node_id)? {
        Some(row) => app.state::<Sessions>().remove(&store, &row),
        None => Ok(()),
    }
}

#[tauri::command(async)]
pub fn session_list(store: tauri::State<Store>) -> Res<Vec<AgentSession>> {
    store.live_sessions()
}

#[cfg(test)]
mod tests;
