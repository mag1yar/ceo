//! Agent sessions: `claude` in tmux on our own socket, one git worktree each, status from Claude Code hooks.

mod bus;
mod guard;
mod hooks;
mod memory;
mod prime;
mod profile;
pub mod shim;
mod tmux;
mod trust;
mod usage;
mod worktree;

use crate::store::{AgentSession, Store};
use std::collections::{HashMap, HashSet};
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
    // Sessions a pointer is being typed into, so two deliveries never type at once.
    nudging: Mutex<HashSet<String>>,
    ask_wait: Duration,
    // Claude Code's `.claude.json`, where the worktrees this app creates are marked trusted.
    claude_json: Option<PathBuf>,
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

    fn nudging(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.nudging.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Only for worktrees under `<app data>/worktrees`; a failure leaves the trust dialog to the human.
    fn trust(&self, key: &str, trusted: bool) {
        if let Some(file) = &self.claude_json
            && let Err(e) = trust::set(file, key, trusted)
        {
            println!("sessions: trust for {key}: {e}");
        }
    }

    fn session_dir(&self, id: &str) -> PathBuf {
        self.dir.join("sessions").join(id)
    }

    /// A session row and its worktree: off the repo's HEAD, or off the parent's branch HEAD for a spawned one.
    fn create(
        &self,
        store: &Store,
        project_id: &str,
        node_id: &str,
        role: &str,
        parent: Option<&AgentSession>,
        stem: &str,
    ) -> Res<AgentSession> {
        let repo = store
            .list_projects()?
            .into_iter()
            .find(|p| p.id == project_id)
            .ok_or("no such project")?
            .path;
        let id = uuid();
        let short = &id[..8];
        // A non-git project runs the session in the project folder itself; a git one never falls back to it.
        let base = match (worktree::head(&repo), parent) {
            (Some(_), Some(p)) => Some(
                p.worktree
                    .as_deref()
                    .and_then(worktree::head)
                    .ok_or("cannot read the HEAD of the parent's worktree, so there is no branch to start from")?,
            ),
            (head, _) => head,
        };
        let (worktree, branch) = match base {
            Some(base) => {
                let path = self.dir.join("worktrees").join(project_id).join(&id);
                let path = path.to_string_lossy().into_owned();
                let branch = format!("ceo/{stem}-{short}");
                worktree::add(&repo, &path, &branch, &base)?;
                self.trust(&trust::key(&path), true);
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
            parent: parent.map(|p| p.node_id.clone()),
        };
        if let Err(e) = store.insert_session(&row) {
            // No row would ever track this worktree, so take it back now (still without force).
            if let (Some(path), Some(branch)) = (&row.worktree, &row.branch) {
                let key = trust::key(path);
                let _ = worktree::remove(&row.repo, path, branch);
                if !Path::new(path).exists() {
                    self.trust(&key, false);
                }
            }
            return Err(e);
        }
        Ok(row)
    }

    fn launch(&self, row: &AgentSession, size: (u16, u16), mode: &str) -> Res<()> {
        self.launch_as(row, size, mode, None)
    }

    /// `node_model` is the model set on the node in the UI, below the spawn arguments and above the role's profile.
    fn launch_as(
        &self,
        row: &AgentSession,
        size: (u16, u16),
        mode: &str,
        node_model: Option<&str>,
    ) -> Res<()> {
        let bins = self.bins()?;
        let dir = self.session_dir(&row.id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Outside the worktree, so the token never lands in the agent's repo.
        let settings = dir.join("settings.json");
        let url = format!("http://127.0.0.1:{}/hook/{}", self.port, row.id);
        let mut config = hooks::settings(&url, &row.token);
        // The app clears the CEO at wave boundaries; idle compaction would summarise it behind the app's back.
        if row.role == "ceo" {
            config["idleCompaction"] = false.into();
        }
        std::fs::write(&settings, config.to_string()).map_err(|e| e.to_string())?;
        let settings = settings.to_string_lossy();
        // The bus as an MCP server: this binary in shim mode, with the session's own URL and token.
        let mcp = dir.join("mcp.json");
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let config = serde_json::json!({ "mcpServers": { "ceo": {
            "type": "stdio",
            "command": exe,
            "args": ["mcp-shim"],
            "env": {
                "CEO_BUS_URL": format!("http://127.0.0.1:{}/bus/{}", self.port, row.id),
                "CEO_BUS_TOKEN": row.token,
            },
            // Per-server, so an owner's low MCP_TOOL_TIMEOUT never cuts a blocking ask short.
            "timeout": (self.ask_wait + Duration::from_secs(60)).as_millis() as u64,
        } } });
        std::fs::write(&mcp, config.to_string()).map_err(|e| e.to_string())?;
        let mcp = mcp.to_string_lossy();
        // An executor's brief, model and effort, written by spawn_executor.
        let profile: serde_json::Value = std::fs::read_to_string(dir.join("profile.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let profiles = profile::load(&self.dir);
        let (model, effort) = profile::pick(&profiles, &row.role, &profile, node_model);
        let mut prompt = bus::role_prompt(&row.role).to_string();
        if matches!(row.role.as_str(), "ceo" | "lead") {
            prompt = format!("{prompt}\n\n{}", profile::advice(&profiles));
        }
        if row.role == "ceo" {
            prompt = format!("{prompt}\n\n{}", profile::COMPACTION);
        }
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
        let mut argv = vec![
            bins.claude.as_str(),
            "--dangerously-skip-permissions",
            "--settings",
            &settings,
            mode,
            &row.claude_session_id,
            // Not the last option: --mcp-config takes several values and would swallow the prompt.
            "--mcp-config",
            &mcp,
            "--append-system-prompt",
            &prompt,
        ];
        if let Some(m) = &model {
            argv.extend(["--model", m]);
        }
        if let Some(e) = &effort {
            argv.extend(["--effort", e]);
        }
        // The brief starts a fresh session only; a resumed one already has it.
        if let Some(brief) = profile["brief"].as_str().filter(|_| mode == "--session-id") {
            argv.extend(["--", brief]);
        }
        self.tmux()?.start(&row.tmux_name, &cwd, size, &env, &argv)
    }

    /// Runs claude for a row whose tmux session is gone: resume, else a fresh start under the same id.
    fn restart(&self, store: &Store, row: &AgentSession, size: (u16, u16)) -> Res<()> {
        let tmux = self.tmux()?;
        // Nothing is typed into it until its SessionStart says the prompt is up.
        store.set_session_status(&row.id, "idle", "Starting")?;
        // Only a session that got a prompt has a transcript; --resume of any other exits at once.
        let node_model = profile::node_model(store, row);
        for mode in ["--resume", "--session-id"] {
            let _ = self.launch_as(row, size, mode, node_model.as_deref());
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
        // `branch -d` keeps a branch with unmerged commits, so an executor's work stays for the owner to merge.
        let kept = match (&row.worktree, &row.branch) {
            (Some(path), Some(branch)) => {
                // The real path is gone once the worktree is.
                let key = trust::key(path);
                // A Lead's executor runs git in the Lead's worktree, so `branch -d` drops a branch merged into the Lead.
                let base = row
                    .parent
                    .as_deref()
                    .and_then(|p| store.node_session(&row.project_id, p).ok().flatten())
                    .filter(|p| p.role == "lead")
                    .and_then(|p| p.worktree)
                    .unwrap_or_else(|| row.repo.clone());
                let kept = worktree::remove(&base, path, branch).err();
                if !Path::new(path).exists() {
                    self.trust(&key, false);
                }
                kept
            }
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

/// `/hook/<session>` for Claude Code hooks, `/bus/<session>/tools` and `/bus/<session>/call` for the MCP shim.
fn on_request<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    auth: Option<&str>,
    body: &[u8],
) -> (u16, String) {
    let (id, route) = match path.strip_prefix("/hook/") {
        Some(id) => (id, "hook"),
        None => match path.strip_prefix("/bus/").and_then(|p| p.split_once('/')) {
            Some((id, route @ ("tools" | "call"))) => (id, route),
            _ => return (404, String::new()),
        },
    };
    if id.is_empty() || id.contains('/') {
        return (404, String::new());
    }
    let Ok(Some(row)) = app.state::<Store>().session(id) else {
        return (401, String::new());
    };
    if !hooks::token_ok(&row.token, auth) {
        return (401, String::new());
    }
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(body) else {
        return (400, String::new());
    };
    match route {
        "hook" => (200, on_hook(app, &row, &body)),
        "tools" => (200, bus::tools(&row.role).to_string()),
        _ => (200, bus::call(app, &row, &body).to_string()),
    }
}

/// Moves the node status, and answers with the push guard's deny or with messages for a busy agent.
fn on_hook<R: Runtime>(
    app: &AppHandle<R>,
    row: &AgentSession,
    event: &serde_json::Value,
) -> String {
    app.state::<Sessions>()
        .heard()
        .insert(row.id.clone(), Instant::now());
    let name = event["hook_event_name"].as_str().unwrap_or("");
    let mut status = hooks::status_for(event);
    // Before the status moves, so a wave reset waiting for idle reads this turn's tokens.
    if matches!(name, "Stop" | "SessionEnd") {
        usage::after_turn(app, row, event);
    }
    let answer = match name {
        "SessionStart" => prime::session_start(app, row, event),
        "PreToolUse" if event["tool_name"] == "Bash" => event["tool_input"]["command"]
            .as_str()
            .and_then(guard::deny)
            .map(|why| {
                serde_json::json!({ "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": why,
                } })
            }),
        // A prompt the owner typed brings what waited for a free pane.
        "UserPromptSubmit" => bus::deliver_by_hook(app, row, "user_prompt_submit").map(|text| {
            serde_json::json!({ "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": text,
            } })
        }),
        "PostToolUse" => {
            if event["tool_name"]
                .as_str()
                .is_some_and(|t| t.starts_with("mcp__ceo__"))
            {
                bus::delivered_in(app, row, &event["tool_response"]);
            }
            bus::deliver_by_hook(app, row, "post_tool_use")
        }
        .map(|text| {
            serde_json::json!({ "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": text,
            } })
        }),
        // Blocks once per stop: while stop_hook_active the turn ends, which keeps us under Claude Code's block cap.
        "Stop" if event["stop_hook_active"] != true => {
            bus::deliver_by_hook(app, row, "stop").map(|text| {
                status = Some(("working", "Reading messages".into()));
                serde_json::json!({ "decision": "block", "reason": text })
            })
        }
        _ => None,
    };
    if let Some((status, action)) = status {
        report(app, &row.project_id, &row.node_id, status, &action);
    }
    // Messages that came in while the turn was ending go in once the pane is idle.
    if name == "Stop" && answer.is_none() {
        bus::nudge(app, row.clone());
    }
    answer.map(|a| a.to_string()).unwrap_or_default()
}

fn watchdog<R: Runtime>(app: AppHandle<R>) {
    let since = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        tick(&app, since);
    }
}

/// One watchdog pass: idles a session whose Stop never came, and re-delivers to idle ones, also what was stored before a restart.
fn tick<R: Runtime>(app: &AppHandle<R>, since: Instant) {
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let (Ok(tmux), Ok(rows)) = (s.tmux(), store.live_sessions()) else {
        return;
    };
    for row in &rows {
        let last = s.heard().get(&row.id).copied().unwrap_or(since);
        if row.status == "working"
            && hooks::missed_stop(&row.status, last.elapsed(), &tmux.capture(&row.tmux_name))
        {
            report(app, &row.project_id, &row.node_id, "idle", "Interrupted");
        }
        if row.status == "idle"
            && store
                .undelivered(&row.project_id, &row.node_id)
                .is_ok_and(|l| !l.is_empty())
        {
            bus::nudge(app, row.clone());
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
        Arc::new(move |path, auth, body| on_request(&handle, path, auth, body)),
    );
    app.manage(Sessions {
        dir,
        socket: socket(),
        port,
        bins: OnceLock::new(),
        ops: Mutex::default(),
        heard: Mutex::default(),
        nudging: Mutex::default(),
        ask_wait: bus::ASK_WAIT,
        claude_json: trust::config_file(),
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
            match s.restart(&store, row, (220, 50)) {
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
    // Newest first: a Lead's executors go while its worktree still decides which of their branches are merged.
    for row in store
        .project_sessions(project_id)
        .unwrap_or_default()
        .into_iter()
        .rev()
    {
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
    // shortcut: the CEO starts its claude here, executors and spawned Leads attach to theirs; hand-placed Leads and Members stay shells.
    match store.node_role(&project_id, &node_id)?.as_deref() {
        Some("ceo") => {}
        Some("executor" | "lead") if store.node_session(&project_id, &node_id)?.is_some() => {}
        _ => return Ok(None),
    }
    let s = app.state::<Sessions>();
    let ensure = || -> Res<AgentSession> {
        let _op = s.lock();
        let tmux = s.tmux()?;
        let row = match store.node_session(&project_id, &node_id)? {
            Some(row) if tmux.has(&row.tmux_name) => return Ok(row),
            Some(row) => {
                s.restart(&store, &row, (cols, rows))?;
                row
            }
            None => {
                let row = s.create(&store, &project_id, &node_id, "ceo", None, "ceo")?;
                // The node switches off the mock pool now, not at the first hook (onboarding sends none).
                report(&app, &project_id, &node_id, &row.status, &row.action);
                s.launch_as(
                    &row,
                    (cols, rows),
                    "--session-id",
                    profile::node_model(&store, &row).as_deref(),
                )?;
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
        // Executors and Leads end through the bus (their report accepted, or stop); a node undone on the board comes back.
        Some(row) if row.role == "ceo" => {
            for exec in store.project_sessions(&project_id)? {
                if exec.parent.as_deref() == Some(&row.node_id) {
                    bus::retire(&app, exec, false, "Its CEO was removed");
                }
            }
            app.state::<Sessions>().remove(&store, &row)
        }
        _ => Ok(()),
    }
}

#[tauri::command(async)]
pub fn session_list(store: tauri::State<Store>) -> Res<Vec<AgentSession>> {
    store.live_sessions()
}

#[cfg(test)]
mod tests;
