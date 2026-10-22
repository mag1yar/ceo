use super::*;
use serde_json::json;
use std::io::Write;
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}

fn repo() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let repo = d.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    (d, repo)
}

fn branches(repo: &Path) -> String {
    git(repo, &["branch", "--list", "ceo/*"])
}

fn row(id: &str, tmux: &str) -> AgentSession {
    AgentSession {
        id: id.into(),
        project_id: "p".into(),
        node_id: format!("n-{id}"),
        role: "ceo".into(),
        repo: "/tmp".into(),
        worktree: None,
        branch: None,
        tmux_name: tmux.into(),
        claude_session_id: id.into(),
        token: "secret".into(),
        status: "idle".into(),
        action: "Starting".into(),
    }
}

#[test]
fn hooks_map_to_status() {
    let cases = [
        (
            json!({"hook_event_name": "SessionStart"}),
            Some(("idle", "Ready")),
        ),
        (
            json!({"hook_event_name": "UserPromptSubmit"}),
            Some(("working", "Thinking")),
        ),
        (
            json!({"hook_event_name": "PreToolUse", "tool_name": "Bash"}),
            Some(("working", "Running Bash")),
        ),
        (
            json!({"hook_event_name": "PostToolUse"}),
            Some(("working", "Thinking")),
        ),
        (
            json!({"hook_event_name": "PermissionRequest", "tool_name": "Edit"}),
            Some(("waiting", "Needs permission for Edit")),
        ),
        (
            json!({"hook_event_name": "Notification", "message": "Claude needs your permission"}),
            Some(("waiting", "Claude needs your permission")),
        ),
        (
            json!({"hook_event_name": "Stop"}),
            Some(("idle", "Turn finished")),
        ),
        (
            json!({"hook_event_name": "StopFailure", "error": "rate_limit", "last_assistant_message": "API Error: Rate limit reached"}),
            Some(("error", "API Error: Rate limit reached")),
        ),
        (
            json!({"hook_event_name": "SessionEnd", "reason": "other"}),
            Some(("done", "Session ended")),
        ),
        (json!({"hook_event_name": "SubagentStop"}), None),
        (json!({}), None),
    ];
    for (event, want) in cases {
        let got = hooks::status_for(&event);
        assert_eq!(got.as_ref().map(|(s, a)| (*s, a.as_str())), want, "{event}");
    }
}

#[test]
fn watchdog_idles_only_a_quiet_working_session_at_its_prompt() {
    let prompt = "❯ \n  ⏵⏵ bypass permissions on";
    let busy = "✻ Thinking… (esc to interrupt)\n❯ ";
    let long = hooks::QUIET + Duration::from_secs(1);
    assert!(hooks::missed_stop("working", long, prompt));
    assert!(
        !hooks::missed_stop("working", Duration::from_secs(1), prompt),
        "hooks still recent"
    );
    assert!(
        !hooks::missed_stop("working", long, busy),
        "still running a turn"
    );
    assert!(
        !hooks::missed_stop("working", long, "Accessing workspace: trust?"),
        "no prompt"
    );
    assert!(
        !hooks::missed_stop("waiting", long, prompt),
        "waiting is left to the human"
    );
}

#[test]
fn reconcile_sorts_live_dead_and_orphans() {
    let rows = [row("a", "ceo-live"), row("b", "ceo-dead")];
    let live = ["ceo-live".to_string(), "ceo-orphan".to_string()];
    let (dead, orphans) = reconcile(&rows, &live);
    assert_eq!(
        dead.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["b"]
    );
    assert_eq!(orphans, [&"ceo-orphan".to_string()]);
}

#[test]
fn settings_deny_subagents_and_push_and_post_every_hook() {
    let s = hooks::settings("http://127.0.0.1:1/hook/x", "tok");
    let deny = s["permissions"]["deny"].as_array().unwrap();
    for rule in ["Agent", "Workflow", "Bash(git push:*)", "Bash(git clean:*)"] {
        assert!(deny.contains(&json!(rule)), "{rule}");
    }
    assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["type"], "http");
    assert_eq!(
        s["hooks"]["Stop"][0]["hooks"][0]["headers"]["Authorization"],
        "Bearer tok"
    );
    let start = s["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    assert!(start.contains("Bearer tok") && start.ends_with("http://127.0.0.1:1/hook/x"));
    assert_eq!(s["hooks"].as_object().unwrap().len(), 9);
}

fn post(port: u16, path: &str, auth: Option<&str>, body: &str) -> u16 {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let auth = auth
        .map(|a| format!("Authorization: {a}\r\n"))
        .unwrap_or_default();
    write!(
        s,
        "POST {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out.split_whitespace().nth(1).unwrap().parse().unwrap()
}

fn mock_app(dir: &Path, bins: Res<Bins>, socket: &str) -> tauri::App<MockRuntime> {
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    app.manage(Store::open(&dir.join("t.db")).unwrap());
    app.manage(Sessions {
        dir: dir.into(),
        socket: socket.into(),
        port: 1,
        bins: OnceLock::from(bins),
        ops: Mutex::default(),
        heard: Mutex::default(),
    });
    app
}

#[test]
fn hook_server_rejects_bad_tokens_and_applies_good_ones() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    let mut r = row("s1", "ceo-x");
    r.project_id = p.id.clone();
    store.insert_session(&r).unwrap();

    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = app.handle().clone();
    hooks::serve(
        listener,
        Arc::new(move |id, auth, body| on_hook(&handle, id, auth, body)),
    );
    let work = r#"{"hook_event_name":"UserPromptSubmit"}"#;
    let status = || store.session("s1").unwrap().unwrap().status;

    assert_eq!(post(port, "/hook/s1", None, work), 401);
    assert_eq!(post(port, "/hook/s1", Some("Bearer wrong!"), work), 401);
    assert_eq!(
        post(port, "/hook/s1", Some("secret"), work),
        401,
        "no Bearer prefix"
    );
    assert_eq!(post(port, "/hook/nope", Some("Bearer secret"), work), 401);
    assert_eq!(post(port, "/other", Some("Bearer secret"), work), 404);
    assert_eq!(status(), "idle", "rejected posts change nothing");

    assert_eq!(
        post(port, "/hook/s1", Some("Bearer secret"), "not json"),
        400
    );
    assert_eq!(post(port, "/hook/s1", Some("Bearer secret"), work), 200);
    assert_eq!(status(), "working");
    assert_eq!(
        post(
            port,
            "/hook/s1",
            Some("Bearer secret"),
            r#"{"hook_event_name":"Stop"}"#
        ),
        200
    );
    assert_eq!(status(), "idle");
}

#[test]
fn worktree_add_and_non_force_remove() {
    let (_d, repo) = repo();
    let r = repo.to_str().unwrap();
    let base = worktree::head(r).unwrap();
    let wt = repo.parent().unwrap().join("wt/a");
    let path = wt.to_str().unwrap();

    worktree::add(r, path, "ceo/ceo-a", &base).unwrap();
    assert!(wt.join(".git").exists());
    assert!(branches(&repo).contains("ceo/ceo-a"));
    worktree::remove(r, path, "ceo/ceo-a").unwrap();
    assert!(!wt.exists());
    assert_eq!(branches(&repo), "");

    // Dirty: git refuses, both stay.
    worktree::add(r, path, "ceo/ceo-b", &base).unwrap();
    std::fs::write(wt.join("work.txt"), "unsaved").unwrap();
    let e = worktree::remove(r, path, "ceo/ceo-b").unwrap_err();
    assert!(e.starts_with("kept worktree"), "{e}");
    assert!(wt.join("work.txt").exists());
    assert!(branches(&repo).contains("ceo/ceo-b"));
    std::fs::remove_file(wt.join("work.txt")).unwrap();

    // Committed but unmerged: the worktree goes, the branch with its commit stays.
    git(&wt, &["commit", "-q", "--allow-empty", "-m", "agent work"]);
    let e = worktree::remove(r, path, "ceo/ceo-b").unwrap_err();
    assert!(e.starts_with("kept branch ceo/ceo-b"), "{e}");
    assert!(!wt.exists());
    assert!(branches(&repo).contains("ceo/ceo-b"));

    assert_eq!(
        worktree::head(repo.parent().unwrap().to_str().unwrap()),
        None,
        "not a repo"
    );
    std::fs::create_dir_all(repo.join("apps/web")).unwrap();
    assert_eq!(
        worktree::prefix(repo.join("apps/web").to_str().unwrap()),
        "apps/web/"
    );
    assert_eq!(worktree::prefix(r), "");
}

fn wait_read(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::read_to_string(path) {
            Ok(s) if !s.is_empty() => return s,
            _ if Instant::now() > deadline => panic!("{} never appeared", path.display()),
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

// A unique socket per test run, killed at the end: never the default or `ceo` socket.
struct TestSocket(String);
impl Drop for TestSocket {
    fn drop(&mut self) {
        let _ = Command::new("tmux")
            .args(["-L", &self.0, "kill-server"])
            .output();
        // tmux 3.6 leaves the socket file behind once its server is gone.
        let uid = Command::new("id").arg("-u").output().unwrap().stdout;
        let dir = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let _ = std::fs::remove_file(format!(
            "{dir}/tmux-{}/{}",
            String::from_utf8_lossy(&uid).trim(),
            self.0
        ));
    }
}

#[test]
fn sessions_start_in_a_worktree_restart_with_resume_and_remove_cleanly() {
    let sock = TestSocket(format!("ceo-test-{}", std::process::id()));
    let (d, repo) = repo();
    // Stand-in for claude: --resume of an unknown id exits at once, like the real one.
    let stub = d.path().join("claude");
    std::fs::write(&stub, "#!/bin/sh\n[ \"$4\" = --resume ] && [ ! -e resumable ] && exit 1\necho \"$@\" > args\nexec sleep 600\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let bins = Bins {
        tmux: "tmux".into(),
        claude: stub.to_string_lossy().into(),
        path: std::env::var("PATH").unwrap(),
    };
    let app = mock_app(d.path(), Ok(bins), &sock.0);
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let p = store.create_project("p", repo.to_str().unwrap()).unwrap();

    let row = s.create(&store, &p.id, "n1", "ceo").unwrap();
    s.launch(&row, (100, 30), "--session-id").unwrap();
    let tmux = s.tmux().unwrap();
    assert!(tmux.has(&row.tmux_name));
    let wt = PathBuf::from(row.worktree.clone().unwrap());
    assert!(wt.starts_with(d.path().join("worktrees").join(&p.id)));
    assert!(branches(&repo).contains(row.branch.as_deref().unwrap()));
    assert!(
        !tmux.has(&row.tmux_name[..4]),
        "exact targets: a prefix matches nothing"
    );
    let args = wait_read(&wt.join("args"));
    assert!(args.contains(&format!("--session-id {}", row.id)), "{args}");
    let settings = s.session_dir(&row.id).join("settings.json");
    assert!(
        std::fs::read_to_string(settings)
            .unwrap()
            .contains(&row.token)
    );

    // Killed outside the app and never prompted: resume fails, a fresh start under the same id follows.
    tmux.kill(&row.tmux_name).unwrap();
    let live = tmux.list();
    let (dead, _) = reconcile(std::slice::from_ref(&row), &live);
    assert_eq!(dead.len(), 1);
    s.restart(&row, (100, 30)).unwrap();
    assert!(tmux.has(&row.tmux_name));
    assert!(wait_read(&wt.join("args")).contains("--session-id"));
    // With a transcript, --resume holds.
    tmux.kill(&row.tmux_name).unwrap();
    std::fs::write(wt.join("resumable"), "").unwrap();
    std::fs::remove_file(wt.join("args")).unwrap();
    s.restart(&row, (100, 30)).unwrap();
    assert!(wait_read(&wt.join("args")).contains(&format!("--resume {}", row.id)));

    // Dirty worktree: the session ends, the work and the row stay.
    s.remove(&store, &row).unwrap();
    assert!(!tmux.has(&row.tmux_name));
    assert!(wt.join("resumable").exists());
    assert!(
        store.node_session(&p.id, "n1").unwrap().is_none(),
        "the node is free for a new session"
    );
    assert!(store.session(&row.id).unwrap().is_none());

    // Clean worktree: everything goes.
    let clean = s.create(&store, &p.id, "n2", "ceo").unwrap();
    s.launch(&clean, (100, 30), "--session-id").unwrap();
    let args = PathBuf::from(clean.worktree.clone().unwrap()).join("args");
    wait_read(&args);
    std::fs::remove_file(args).unwrap();
    s.remove(&store, &clean).unwrap();
    assert!(!tmux.has(&clean.tmux_name));
    assert!(!Path::new(clean.worktree.as_deref().unwrap()).exists());
    assert!(!branches(&repo).contains(clean.branch.as_deref().unwrap()));
    assert!(store.project_sessions(&p.id).unwrap().is_empty());
}
