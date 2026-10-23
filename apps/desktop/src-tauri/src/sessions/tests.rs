use super::*;
use crate::store::{BoardChanges, BoardNode};
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
        parent: None,
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
            json!({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "Claude is waiting for your input"}),
            Some(("idle", "Claude is waiting for your input")),
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

// Claude Code 2.1.308 screens from `tmux capture-pane -e -p`, trimmed to the rows that matter.
#[test]
fn a_pointer_is_typed_only_into_an_empty_prompt() {
    let rule = "\x1b[38;5;244m────────────────────────────────────────\x1b[39m";
    let footer = "  \x1b[38;5;211m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m";
    let screen = |input: &str| {
        format!(
            "\x1b[38;5;246m\x1b[48;5;237m❯\x1b[39m \x1b[38;5;231m/model\x1b[39m \x1b[49m\n\n{rule}\n{input}\n{rule}\n{footer}\n"
        )
    };
    assert!(hooks::prompt_empty(&screen("\x1b[39m❯ ")), "empty");
    assert!(
        hooks::prompt_empty(&screen(
            "\x1b[39m❯ \x1b[2mTry \"write a test for <filepath>\"\x1b[0m"
        )),
        "the dim placeholder of an empty prompt"
    );
    assert!(
        !hooks::prompt_empty(&screen("\x1b[39m❯ fix the half typed")),
        "the owner's draft"
    );
    let picker = "   Select model\n\n     1.  Default (recommended)\n   \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m2.  \x1b[38;5;114mOpus 5.5\x1b[39m\n     3.  Sonnet 5.5\n\n   \x1b[38;5;246mEnter to set as default · s to use this session only · Esc to cancel\x1b[39m\n";
    assert!(!hooks::prompt_empty(picker), "a picker");
    let trust = " Accessing workspace:\n\n /private/tmp/x\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n";
    assert!(!hooks::prompt_empty(trust), "the trust dialog");
    let busy = format!("✻ Thinking… (esc to interrupt)\n{}", screen("\x1b[39m❯ "));
    assert!(!hooks::prompt_empty(&busy), "a running turn");
    assert!(!hooks::prompt_empty(""), "no claude prompt at all");
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
    post_body(port, path, auth, body).0
}

fn post_body(port: u16, path: &str, auth: Option<&str>, body: &str) -> (u16, String) {
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
    let code = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    (code, out.split_once("\r\n\r\n").unwrap().1.to_string())
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
        nudging: Mutex::default(),
        ask_wait: Duration::from_millis(300),
        claude_json: Some(dir.join(".claude.json")),
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
        Arc::new(move |path, auth, body| on_request(&handle, path, auth, body)),
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

    let row = s.create(&store, &p.id, "n1", "ceo", None, "ceo").unwrap();
    s.launch(&row, (100, 30), "--session-id").unwrap();
    let tmux = s.tmux().unwrap();
    assert!(tmux.has(&row.tmux_name));
    let wt = PathBuf::from(row.worktree.clone().unwrap());
    assert!(wt.starts_with(d.path().join("worktrees").join(&p.id)));
    assert!(branches(&repo).contains(row.branch.as_deref().unwrap()));
    // Keyed by the real path (tempdirs sit under the /var symlink), as claude resolves its cwd.
    let trusted = |key: &str| {
        let c: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.path().join(".claude.json")).unwrap())
                .unwrap();
        c["projects"]
            .get(key)
            .map(|e| e == &json!({ "hasTrustDialogAccepted": true }))
    };
    let key = trust::key(row.worktree.as_deref().unwrap());
    assert_ne!(Some(key.as_str()), row.worktree.as_deref());
    assert_eq!(trusted(&key), Some(true), "marked before the launch");
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
    s.restart(&store, &row, (100, 30)).unwrap();
    assert!(tmux.has(&row.tmux_name));
    assert!(wait_read(&wt.join("args")).contains("--session-id"));
    // With a transcript, --resume holds.
    tmux.kill(&row.tmux_name).unwrap();
    std::fs::write(wt.join("resumable"), "").unwrap();
    std::fs::remove_file(wt.join("args")).unwrap();
    s.restart(&store, &row, (100, 30)).unwrap();
    assert!(wait_read(&wt.join("args")).contains(&format!("--resume {}", row.id)));

    // Dirty worktree: the session ends, the work and the row stay.
    s.remove(&store, &row).unwrap();
    assert!(!tmux.has(&row.tmux_name));
    assert!(wt.join("resumable").exists());
    assert_eq!(trusted(&key), Some(true), "a kept worktree stays trusted");
    assert!(
        store.node_session(&p.id, "n1").unwrap().is_none(),
        "the node is free for a new session"
    );
    assert!(store.session(&row.id).unwrap().is_none());

    // Clean worktree: everything goes.
    let clean = s.create(&store, &p.id, "n2", "ceo", None, "ceo").unwrap();
    let clean_key = trust::key(clean.worktree.as_deref().unwrap());
    assert_eq!(trusted(&clean_key), Some(true));
    s.launch(&clean, (100, 30), "--session-id").unwrap();
    let args = PathBuf::from(clean.worktree.clone().unwrap()).join("args");
    wait_read(&args);
    std::fs::remove_file(args).unwrap();
    s.remove(&store, &clean).unwrap();
    assert!(!tmux.has(&clean.tmux_name));
    assert!(!Path::new(clean.worktree.as_deref().unwrap()).exists());
    assert_eq!(trusted(&clean_key), None, "a removed worktree's entry goes");
    assert_eq!(trusted(&key), Some(true));
    assert!(!branches(&repo).contains(clean.branch.as_deref().unwrap()));
    assert!(store.project_sessions(&p.id).unwrap().is_empty());
}

#[test]
fn trust_marks_a_path_and_keeps_the_rest_of_claude_json() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join(".claude.json");
    let read = || std::fs::read_to_string(&f).unwrap();

    // Missing file: created with just the entry, private to the owner.
    trust::set(&f, "/w/a", true).unwrap();
    let c: serde_json::Value = serde_json::from_str(&read()).unwrap();
    assert_eq!(
        c,
        json!({ "projects": { "/w/a": { "hasTrustDialogAccepted": true } } })
    );
    assert_eq!(
        std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // Existing keys keep their values and order, an existing entry only gains the flag.
    std::fs::write(
        &f,
        r#"{"zeta":1,"projects":{"/w/b":{"lastCost":0.5,"hasTrustDialogAccepted":false},"/w/c":{"x":[1,2]}},"alpha":{"n":12345678901234567890}}"#,
    )
    .unwrap();
    trust::set(&f, "/w/b", true).unwrap();
    trust::set(&f, "/w/new", true).unwrap();
    let c: serde_json::Value = serde_json::from_str(&read()).unwrap();
    let keys = |v: &serde_json::Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&c), ["zeta", "projects", "alpha"]);
    assert_eq!(keys(&c["projects"]), ["/w/b", "/w/c", "/w/new"]);
    assert_eq!(
        c["projects"]["/w/b"],
        json!({ "lastCost": 0.5, "hasTrustDialogAccepted": true })
    );
    assert_eq!(c["projects"]["/w/c"], json!({ "x": [1, 2] }));
    assert!(read().contains("12345678901234567890"));

    // Removal drops only that entry, the rest stays in place.
    trust::set(&f, "/w/b", false).unwrap();
    let c: serde_json::Value = serde_json::from_str(&read()).unwrap();
    assert_eq!(keys(&c["projects"]), ["/w/c", "/w/new"]);
    assert_eq!(keys(&c), ["zeta", "projects", "alpha"]);

    // Not JSON (claude halfway through a write, say): left byte for byte, the dialog shows instead.
    std::fs::write(&f, "{\"projects\": {").unwrap();
    assert!(trust::set(&f, "/w/a", true).is_err());
    assert_eq!(read(), "{\"projects\": {");
    // Removing from a missing file creates nothing; no temp file is left behind.
    std::fs::remove_file(&f).unwrap();
    trust::set(&f, "/w/a", false).unwrap();
    assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
}

#[test]
fn push_guard_finds_every_git_push_and_gh() {
    for cmd in [
        "git push",
        "git -C x push",
        "git -C 'a b' push origin main",
        "cd x && git push",
        "true; git push",
        "git status || git push",
        "sh -c 'git push'",
        "bash -lc \"cd x; git push --force\"",
        "env X=1 git push",
        "FOO=bar BAZ=1 git push",
        "/usr/bin/git push",
        "sudo -u me git push",
        "nohup git push &",
        "time git push",
        "timeout 10 git push",
        "xargs -n 1 git push",
        "echo $(git push)",
        "echo \"$(git push)\"",
        "echo `git push`",
        "eval git push",
        "eval 'git push'",
        "(git push)",
        "{ git push; }",
        "if true; then git push; fi",
        "git --git-dir=.git push",
        "git --git-dir .git --work-tree . push",
        "git -c user.name=x push",
        "git -c alias.p=push p",
        "g\\it push",
        "gh pr create",
        "/opt/homebrew/bin/gh api repos",
        "ls | gh",
        "git reset --hard HEAD~1",
        "git branch -D x",
        "git branch --delete --force x",
        "git branch -df x",
        "git worktree remove -f x",
        "git worktree remove --force x",
        "git clean -fdx",
        "p=push; git $p",
        "git $(echo push)",
        "echo push | xargs git",
        "git config alias.p push",
        "git config --global alias.p push",
        "git config set Alias.p push",
        "git config --add alias.p '!git push'",
        "git -c Alias.p=push p",
    ] {
        assert!(guard::deny(cmd).is_some(), "should deny: {cmd}");
    }
    for cmd in [
        "git log --grep=push",
        "git log --grep push",
        "git commit -m 'git push later'",
        "echo git push",
        "rg 'git push' docs",
        "grep -r gh src",
        "cat push.txt",
        "ls ghost",
        "git status",
        "git stash push -m wip",
        "git branch -d merged",
        "git worktree remove x",
        "git reset --soft HEAD~1",
        "command -v git",
        "git config user.name x",
        "git config --get alias.p",
        "git config get alias.p",
        "git config --list",
        "",
    ] {
        assert_eq!(guard::deny(cmd), None, "should allow: {cmd}");
    }
}

fn session(id: &str, project: &str, role: &str, parent: Option<&str>) -> AgentSession {
    let mut r = row(id, &format!("t-{id}"));
    r.project_id = project.into();
    r.node_id = id.into();
    r.role = role.into();
    r.parent = parent.map(Into::into);
    // Busy, so no test here types into a pane.
    r.status = "working".into();
    r
}

fn tool(
    app: &tauri::App<MockRuntime>,
    row: &AgentSession,
    name: &str,
    args: serde_json::Value,
) -> Result<String, String> {
    let r = bus::call(
        app.handle(),
        row,
        &json!({ "name": name, "arguments": args }),
    );
    let text = r["content"][0]["text"].as_str().unwrap().to_string();
    if r["isError"] == true {
        Err(text)
    } else {
        Ok(text)
    }
}

fn names(list: serde_json::Value) -> Vec<String> {
    list["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().into())
        .collect()
}

#[test]
fn bus_tools_by_role_and_links_checked() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    let ceo = session("ceo", &p.id, "ceo", None);
    let e1 = session("e1", &p.id, "executor", Some("ceo"));
    let e2 = session("e2", &p.id, "executor", Some("ceo"));
    let boss = session("boss", &p.id, "ceo", None);
    let e3 = session("e3", &p.id, "executor", Some("boss"));
    for r in [&ceo, &e1, &e2, &boss, &e3] {
        store.insert_session(r).unwrap();
    }

    assert_eq!(
        names(bus::tools("executor")),
        ["report", "ask", "send", "inbox", "accept"]
    );
    assert_eq!(
        names(bus::tools("ceo")),
        [
            "spawn_executor",
            "spawn_lead",
            "send",
            "interrupt",
            "stop",
            "reply",
            "inbox",
            "accept"
        ]
    );
    assert!(bus::linked(&ceo, &e1) && bus::linked(&e1, &ceo));
    assert!(bus::linked(&e1, &e2), "teammates");
    assert!(
        !bus::linked(&e3, &ceo) && !bus::linked(&ceo, &e3),
        "someone else's executor"
    );
    assert!(!bus::linked(&ceo, &boss));

    // An executor calling CEO tools, or messaging another executor.
    let e = tool(&app, &e1, "stop", json!({"to": "e2"})).unwrap_err();
    assert_eq!(e, "stop is not a tool of the executor");
    assert!(
        tool(
            &app,
            &e1,
            "spawn_executor",
            json!({"title": "t", "brief": "b"})
        )
        .is_err()
    );
    assert!(tool(&app, &e1, "reply", json!({"id": "x", "body": "b"})).is_err());
    let e = bus::send(app.handle(), &e1, &e3, "send", "hi", None).unwrap_err();
    assert!(e.contains("not linked"), "{e}");
    let e = tool(&app, &ceo, "send", json!({"to": "e3", "body": "hi"})).unwrap_err();
    assert!(e.contains("not linked"), "{e}");
    assert!(tool(&app, &ceo, "send", json!({"to": "nobody", "body": "hi"})).is_err());
    assert_eq!(
        tool(&app, &ceo, "report", json!({"body": "x"})).unwrap_err(),
        "report is not a tool of the ceo"
    );
    let e = tool(&app, &ceo, "send", json!({"to": "e1"})).unwrap_err();
    assert!(e.contains("body is required"), "{e}");
    assert!(
        store.list_messages(&p.id).unwrap().is_empty(),
        "nothing rejected was stored"
    );

    // Report: sent, delivered by the inbox call, accepted only by its recipient.
    tool(&app, &e1, "report", json!({"body": "done"})).unwrap();
    let m = store.inbox(&p.id, "ceo").unwrap().pop().unwrap();
    assert_eq!(
        (m.from.as_str(), m.kind.as_str(), m.state.as_str()),
        ("e1", "report", "sent")
    );
    let e = tool(&app, &e2, "accept", json!({"id": m.id})).unwrap_err();
    assert!(e.contains("not addressed to you"), "{e}");
    // A reply takes only an ask: replying to a report would accept it without ending its executor.
    let e = tool(&app, &ceo, "reply", json!({"id": m.id, "body": "ok"})).unwrap_err();
    assert!(
        e.contains("not an ask") && e.contains("mcp__ceo__accept"),
        "{e}"
    );
    assert_eq!(store.message(&m.id).unwrap().unwrap().state, "sent");
    assert!(store.reply_in(&m.thread, "e1").unwrap().is_none());
    let text = tool(&app, &ceo, "inbox", json!({})).unwrap();
    assert!(text.contains(&m.id) && text.contains("done"), "{text}");
    assert_eq!(
        store.message(&m.id).unwrap().unwrap().state,
        "sent",
        "not seen yet"
    );
    // Its PostToolUse says claude got the result; only messages to the caller move.
    let result = json!([{ "type": "text", "text": text }]);
    bus::delivered_in(app.handle(), &e2, &result);
    assert_eq!(store.message(&m.id).unwrap().unwrap().state, "sent");
    bus::delivered_in(app.handle(), &ceo, &result);
    let w = store.message(&m.id).unwrap().unwrap();
    assert_eq!(
        (w.state.as_str(), w.delivered_via.as_deref()),
        ("waiting", Some("post_tool_use"))
    );
    tool(&app, &ceo, "accept", json!({"id": m.id})).unwrap();
    assert_eq!(store.message(&m.id).unwrap().unwrap().state, "accepted");

    // Ask blocks, returns pending, and resumes on the same thread once the CEO replies.
    let pending = tool(&app, &e2, "ask", json!({"body": "which file?"})).unwrap();
    assert!(pending.contains("\"pending\""), "{pending}");
    let ask = store.inbox(&p.id, "ceo").unwrap().pop().unwrap();
    assert!(pending.contains(&ask.id));
    let e = tool(&app, &e1, "ask", json!({"resume": ask.id})).unwrap_err();
    assert!(e.contains("no ask"), "{e}");
    tool(
        &app,
        &ceo,
        "reply",
        json!({"id": ask.id, "body": "hello.txt"}),
    )
    .unwrap();
    assert_eq!(
        store.message(&ask.id).unwrap().unwrap().state,
        "accepted",
        "replying accepts"
    );
    let got = tool(&app, &e2, "ask", json!({"resume": ask.id})).unwrap();
    assert!(got.contains("hello.txt"), "{got}");
    let reply = store.reply_in(&ask.thread, "e2").unwrap().unwrap();
    assert_eq!(
        reply.state, "sent",
        "an ask cancelled in claude delivers nothing"
    );
    bus::delivered_in(app.handle(), &e2, &json!(got));
    let reply = store.message(&reply.id).unwrap().unwrap();
    assert_eq!(
        reply.state, "waiting",
        "the reply waits for the executor's accept"
    );
    tool(&app, &e2, "accept", json!({"id": reply.id})).unwrap();
}

#[test]
fn hooks_answer_with_the_push_guard_and_with_messages_for_a_busy_agent() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    let ceo = session("ceo", &p.id, "ceo", None);
    let e1 = session("e1", &p.id, "executor", Some("ceo"));
    store.insert_session(&ceo).unwrap();
    store.insert_session(&e1).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = app.handle().clone();
    hooks::serve(
        listener,
        Arc::new(move |path, auth, body| on_request(&handle, path, auth, body)),
    );
    let hook = |body: serde_json::Value| {
        let (code, out) = post_body(port, "/hook/e1", Some("Bearer secret"), &body.to_string());
        assert_eq!(code, 200);
        if out.is_empty() {
            json!(null)
        } else {
            serde_json::from_str(&out).unwrap()
        }
    };
    let bash = |cmd: &str| {
        hook(
            json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}}),
        )
    };

    let deny = bash("cd x && git -C . push");
    assert_eq!(deny["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(
        deny["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("push")
    );
    assert_eq!(bash("git log --grep=push"), json!(null));
    assert_eq!(
        hook(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash"})),
        json!(null)
    );

    let a = bus::send(app.handle(), &ceo, &e1, "send", "use hello.txt", None).unwrap();
    let ctx = hook(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash"}));
    let text = ctx["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(
        text.contains(&a.id) && text.contains("use hello.txt"),
        "{text}"
    );
    assert_eq!(
        store
            .message(&a.id)
            .unwrap()
            .unwrap()
            .delivered_via
            .as_deref(),
        Some("post_tool_use")
    );
    assert_eq!(
        hook(json!({"hook_event_name": "PostToolUse"})),
        json!(null),
        "delivered once"
    );

    let b = bus::send(app.handle(), &ceo, &e1, "send", "also tests", None).unwrap();
    // A turn already continued by a block is let go: Claude Code caps consecutive blocks.
    assert_eq!(
        hook(json!({"hook_event_name": "Stop", "stop_hook_active": true})),
        json!(null)
    );
    assert_eq!(store.message(&b.id).unwrap().unwrap().state, "sent");
    store
        .set_session_status("e1", "working", "Thinking")
        .unwrap();
    let stop = hook(json!({"hook_event_name": "Stop", "stop_hook_active": false}));
    assert_eq!(stop["decision"], "block");
    assert!(stop["reason"].as_str().unwrap().contains("also tests"));
    let b = store.message(&b.id).unwrap().unwrap();
    assert_eq!(
        (b.state.as_str(), b.delivered_via.as_deref()),
        ("waiting", Some("stop"))
    );
    assert_eq!(
        store.session("e1").unwrap().unwrap().status,
        "working",
        "the blocked turn goes on"
    );

    // Waiting on a free pane, a message comes with the next prompt the owner submits.
    let c = bus::send(app.handle(), &ceo, &e1, "send", "and docs", None).unwrap();
    let ctx = hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "go on"}));
    assert_eq!(
        ctx["hookSpecificOutput"]["hookEventName"],
        "UserPromptSubmit"
    );
    assert!(
        ctx["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("and docs")
    );
    assert_eq!(
        store
            .message(&c.id)
            .unwrap()
            .unwrap()
            .delivered_via
            .as_deref(),
        Some("user_prompt_submit")
    );
    assert_eq!(
        hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "more"})),
        json!(null)
    );

    // The bus routes need the same token.
    assert_eq!(post(port, "/bus/e1/tools", Some("Bearer nope"), "{}"), 401);
    assert_eq!(
        post(port, "/bus/e1/other", Some("Bearer secret"), "{}"),
        404
    );
    let (code, tools) = post_body(port, "/bus/e1/tools", Some("Bearer secret"), "{}");
    assert_eq!(code, 200);
    assert!(tools.contains("\"report\"") && !tools.contains("spawn_executor"));
}

#[test]
fn shim_speaks_json_rpc_and_reaches_the_bus_again_after_a_restart() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    store
        .insert_session(&session("ceo", &p.id, "ceo", None))
        .unwrap();
    store
        .insert_session(&session("e1", &p.id, "executor", Some("ceo")))
        .unwrap();
    // A port with nothing on it yet: the app is down.
    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();

    let (reader, mut writer) = std::io::pipe().unwrap();
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let shim_out = out.clone();
    let url = format!("http://127.0.0.1:{port}/bus/e1");
    let shim = std::thread::spawn(move || {
        shim::serve(std::io::BufReader::new(reader), shim_out, &url, "secret")
    });
    let answer = |id: u64| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = String::from_utf8(out.lock().unwrap().clone()).unwrap();
            if let Some(v) = text
                .lines()
                .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
                .find(|v| v["id"] == id)
            {
                return v;
            }
            assert!(Instant::now() < deadline, "no answer to {id}: {text}");
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let mut send = |v: serde_json::Value| writeln!(writer, "{v}").unwrap();

    send(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}}}),
    );
    let init = answer(1);
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["serverInfo"]["name"], "ceo");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    send(json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}));
    assert_eq!(answer(2)["result"], json!({}));
    send(json!({"jsonrpc": "2.0", "id": 3, "method": "server/discover"}));
    assert_eq!(answer(3)["error"]["code"], -32601);
    send(
        json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "inbox", "arguments": {}}}),
    );
    let down = answer(4);
    assert_eq!(down["result"]["isError"], true);
    assert!(
        down["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not reachable")
    );

    // The app comes back on the same port; the same shim's next calls work.
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let handle = app.handle().clone();
    hooks::serve(
        listener,
        Arc::new(move |path, auth, body| on_request(&handle, path, auth, body)),
    );
    send(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/list"}));
    assert_eq!(
        names(answer(5)["result"].clone()),
        ["report", "ask", "send", "inbox", "accept"]
    );
    send(
        json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "report", "arguments": {"body": "done"}}}),
    );
    assert_eq!(answer(6)["result"]["isError"], false);
    assert_eq!(store.inbox(&p.id, "ceo").unwrap()[0].body, "done");
    drop(writer);
    shim.join().unwrap();
}

fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn sleeper(d: &Path) -> Bins {
    let stub = d.join("claude");
    // An empty claude prompt, drawn again after every line typed into it.
    std::fs::write(
        &stub,
        "#!/bin/sh\necho \"$@\" > args\nprintf '❯ '\nwhile read -r l; do printf '❯ '; done\n",
    )
    .unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    Bins {
        tmux: "tmux".into(),
        claude: stub.to_string_lossy().into(),
        path: std::env::var("PATH").unwrap(),
    }
}

#[test]
fn spawned_executor_reports_is_accepted_and_leaves_its_branch() {
    let sock = TestSocket(format!("ceo-test-bus-{}", std::process::id()));
    let (d, repo) = repo();
    let app = mock_app(d.path(), Ok(sleeper(d.path())), &sock.0);
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let p = store.create_project("p", repo.to_str().unwrap()).unwrap();
    let ceo = s
        .create(&store, &p.id, "ceo-node", "ceo", None, "ceo")
        .unwrap();
    s.launch(&ceo, (100, 30), "--session-id").unwrap();
    let ceo_node = BoardNode {
        id: "ceo-node".into(),
        kind: "ceo".into(),
        x: 0.0,
        y: 0.0,
        width: None,
        height: None,
        data: json!({"name": "CEO", "model": "haiku"}),
        z: 0,
    };
    let changes = BoardChanges {
        upsert_nodes: vec![ceo_node],
        ..Default::default()
    };
    store.save_board(&p.id, &changes).unwrap();
    // The executor starts from the CEO's branch, not from main.
    let ceo_wt = PathBuf::from(ceo.worktree.clone().unwrap());
    git(
        &ceo_wt,
        &["commit", "-q", "--allow-empty", "-m", "ceo work"],
    );

    let brief = json!({"title": "Add hello file!", "brief": "- write hello.txt;", "effort": "low"});
    let out = tool(&app, &ceo, "spawn_executor", brief).unwrap();
    let spawned: serde_json::Value = serde_json::from_str(out.lines().next().unwrap()).unwrap();
    let node = spawned["node"].as_str().unwrap().to_string();
    let exec = store.node_session(&p.id, &node).unwrap().unwrap();
    let branch = exec.branch.clone().unwrap();
    assert!(branch.starts_with("ceo/exec-add-hello-file-"), "{branch}");
    assert_eq!(
        (exec.role.as_str(), exec.parent.as_deref()),
        ("executor", Some("ceo-node"))
    );
    assert_eq!(
        (exec.status.as_str(), exec.action.as_str()),
        ("working", "Starting")
    );
    let wt = PathBuf::from(exec.worktree.clone().unwrap());
    assert_eq!(
        git(&wt, &["rev-parse", "HEAD"]),
        git(&ceo_wt, &["rev-parse", "HEAD"])
    );
    let args = wait_read(&wt.join("args"));
    assert!(
        args.contains("--mcp-config")
            && args.contains("--append-system-prompt You are an executor"),
        "{args}"
    );
    assert!(
        args.ends_with("--model sonnet --effort low -- - write hello.txt;\n"),
        "model from the executor profile, not the CEO's node, the brief's trailing ; kept: {args}"
    );
    let mcp = std::fs::read_to_string(s.session_dir(&exec.id).join("mcp.json")).unwrap();
    let mcp: serde_json::Value = serde_json::from_str(&mcp).unwrap();
    let server = &mcp["mcpServers"]["ceo"];
    assert_eq!(server["args"], json!(["mcp-shim"]));
    assert_eq!(
        server["env"]["CEO_BUS_URL"],
        format!("http://127.0.0.1:1/bus/{}", exec.id)
    );
    assert_eq!(server["env"]["CEO_BUS_TOKEN"], exec.token);
    let board = store.load_board(&p.id).unwrap();
    assert!(
        board
            .nodes
            .iter()
            .any(|n| n.id == node && n.kind == "executor" && n.data["branch"] == branch.as_str())
    );
    assert!(
        board
            .edges
            .iter()
            .any(|e| e.source == "ceo-node" && e.target == node && e.data["kind"] == "spawn")
    );
    // An interrupt leaves a booting executor "Starting", so nothing is typed into it yet.
    let note = tool(
        &app,
        &ceo,
        "interrupt",
        json!({"to": node, "body": "one file"}),
    )
    .unwrap();
    let exec_now = store.session(&exec.id).unwrap().unwrap();
    assert_eq!(
        (exec_now.status.as_str(), exec_now.action.as_str()),
        ("working", "Starting"),
        "{note}"
    );
    let bad = json!({"title": "t", "brief": "b", "model": "gpt"});
    assert!(tool(&app, &ceo, "spawn_executor", bad).is_err());

    // The executor commits and reports; the idle CEO gets a typed pointer, never the text.
    std::fs::remove_file(wt.join("args")).unwrap();
    git(&wt, &["commit", "-q", "--allow-empty", "-m", "exec work"]);
    store
        .set_session_status(&exec.id, "idle", "Turn finished")
        .unwrap();
    // An ask the CEO never answers; the mock bus gives up waiting at once.
    let pending = tool(&app, &exec, "ask", json!({"body": "which file?"})).unwrap();
    assert!(pending.contains("\"pending\""), "{pending}");
    // What the CEO's SessionStart would say; a "Starting" pane is never typed into.
    store.set_session_status(&ceo.id, "idle", "Ready").unwrap();
    tool(&app, &exec, "report", json!({"body": "secret result text"})).unwrap();
    let tmux = s.tmux().unwrap();
    wait_until("the pointer is typed", || {
        store.inbox(&p.id, "ceo-node").unwrap()[0]
            .delivered_via
            .as_deref()
            == Some("typed")
    });
    let pane = tmux.capture(&ceo.tmux_name);
    assert!(
        pane.contains("2 new messages, call mcp__ceo__inbox"),
        "{pane}"
    );
    assert!(!pane.contains("secret result text"));
    wait_until(
        "Enter follows the pointer and the prompt is drawn again",
        || tmux.capture(&ceo.tmux_name).matches('❯').count() == 2,
    );

    let m = store.inbox(&p.id, "ceo-node").unwrap().pop().unwrap();
    tool(&app, &ceo, "accept", json!({"id": m.id})).unwrap();
    wait_until("the executor's tmux session ends", || {
        !tmux.has(&exec.tmux_name)
    });
    wait_until("its node leaves the board", || {
        store
            .load_board(&p.id)
            .unwrap()
            .nodes
            .iter()
            .all(|n| n.id != node)
    });
    assert!(store.load_board(&p.id).unwrap().edges.is_empty());
    // What nobody can accept now is closed, never accepted: off the board and out of the CEO's inbox.
    assert!(
        store.inbox(&p.id, "ceo-node").unwrap().is_empty(),
        "no orphaned ask"
    );
    assert!(store.list_messages(&p.id).unwrap().is_empty());
    let ask: serde_json::Value = serde_json::from_str(pending.lines().next().unwrap()).unwrap();
    let send = note.trim_end_matches('.').rsplit(' ').next().unwrap();
    for id in [ask["pending"].as_str().unwrap(), send] {
        let m = store.message(id).unwrap().unwrap();
        assert!(m.closed_at.is_some() && m.state != "accepted", "{m:?}");
    }
    assert!(!wt.exists(), "the worktree is removed");
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s", &branch]),
        "exec work",
        "the branch stays with the commit"
    );
    assert!(
        store.session(&exec.id).unwrap().is_none(),
        "the row is done"
    );
    assert!(tmux.has(&ceo.tmux_name), "the CEO goes on");

    // Stored while the app was down: the reopened store's first watchdog pass delivers it.
    store
        .set_session_status(&ceo.id, "working", "Thinking")
        .unwrap();
    let late = store
        .add_message(&p.id, "x", "ceo-node", "send", "late", None)
        .unwrap();
    store.set_session_status(&ceo.id, "idle", "Ready").unwrap();
    drop(app);
    let app = mock_app(d.path(), Ok(sleeper(d.path())), &sock.0);
    let store = app.state::<Store>();
    assert_eq!(
        store.undelivered(&p.id, "ceo-node").unwrap(),
        std::slice::from_ref(&late)
    );
    tick(app.handle(), Instant::now());
    wait_until("the late message is typed", || {
        store.message(&late.id).unwrap().unwrap().state == "waiting"
    });
    app.state::<Sessions>().remove(&store, &ceo).unwrap();
}

#[test]
fn a_spawned_session_in_a_git_project_never_falls_back_to_the_project_folder() {
    let (d, repo) = repo();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let p = store.create_project("p", repo.to_str().unwrap()).unwrap();
    let mut ceo = session("ceo", &p.id, "ceo", None);
    ceo.worktree = Some(d.path().join("gone").to_string_lossy().into());
    let e = s
        .create(&store, &p.id, "exec", "executor", Some(&ceo), "exec")
        .unwrap_err();
    assert!(e.contains("HEAD"), "{e}");
    assert!(store.node_session(&p.id, "exec").unwrap().is_none());

    // A non-git project has no branch to start from, so its sessions run in the folder.
    let plain = tempfile::tempdir().unwrap();
    let q = store
        .create_project("q", plain.path().to_str().unwrap())
        .unwrap();
    let row = s
        .create(
            &store,
            &q.id,
            "exec",
            "executor",
            Some(&session("ceo", &q.id, "ceo", None)),
            "exec",
        )
        .unwrap();
    assert_eq!((row.worktree, row.branch), (None, None));
}

// Team per task (#20): links for every role pair, the files overlap rule, and a Lead retired after its team.

#[test]
fn team_links_for_every_role_pair() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    let all = [
        session("ceo", &p.id, "ceo", None),
        session("l1", &p.id, "lead", Some("ceo")),
        session("l2", &p.id, "lead", Some("ceo")),
        session("a1", &p.id, "executor", Some("l1")),
        session("a2", &p.id, "executor", Some("l1")),
        session("b1", &p.id, "executor", Some("l2")),
        session("d1", &p.id, "executor", Some("ceo")),
        session("d2", &p.id, "executor", Some("ceo")),
        session("boss", &p.id, "ceo", None),
        session("l3", &p.id, "lead", Some("boss")),
    ];
    for r in &all {
        store.insert_session(r).unwrap();
    }
    let links = [
        "ceo-l1", "ceo-l2", "ceo-d1", "ceo-d2", "l1-l2", "l1-a1", "l1-a2", "a1-a2", "l2-b1",
        "d1-d2", "boss-l3",
    ];
    for a in &all {
        for b in &all {
            let want = [(a, b), (b, a)]
                .iter()
                .any(|(x, y)| links.contains(&format!("{}-{}", x.node_id, y.node_id).as_str()));
            assert_eq!(bus::linked(a, b), want, "{} with {}", a.node_id, b.node_id);
        }
    }
    let mut elsewhere = all[1].clone();
    elsewhere.project_id = "q".into();
    assert!(!bus::linked(&all[0], &elsewhere), "another project");

    assert_eq!(
        names(bus::tools("lead")),
        [
            "spawn_executor",
            "send",
            "interrupt",
            "stop",
            "reply",
            "report",
            "ask_ceo",
            "inbox",
            "accept"
        ]
    );
    let spawn = &bus::tools("lead")["tools"][0]["inputSchema"]["required"];
    assert_eq!(spawn, &json!(["title", "brief", "files"]));
    let spawn = &bus::tools("ceo")["tools"][0]["inputSchema"]["required"];
    assert_eq!(spawn, &json!(["title", "brief"]));

    let [_, l1, _, a1, ..] = &all;
    let e = tool(&app, a1, "send", json!({"to": "ceo", "body": "hi"})).unwrap_err();
    assert_eq!(e, "ceo is not linked to you on the bus");
    for to in ["b1", "l2", "d1", "l3"] {
        let e = tool(&app, a1, "send", json!({"to": to, "body": "hi"})).unwrap_err();
        assert!(e.contains("not linked"), "{to}: {e}");
    }
    let e = tool(&app, l1, "send", json!({"to": "b1", "body": "hi"})).unwrap_err();
    assert!(e.contains("not linked"), "{e}");
    // Linked is not spawned: a Lead never stops or interrupts its CEO or a sibling Lead.
    let e = tool(&app, l1, "stop", json!({"to": "ceo"})).unwrap_err();
    assert_eq!(e, "ceo was not spawned by you");
    let e = tool(&app, l1, "interrupt", json!({"to": "l2", "body": "x"})).unwrap_err();
    assert_eq!(e, "l2 was not spawned by you");
    let e = tool(&app, a1, "ask_ceo", json!({"body": "?"})).unwrap_err();
    assert_eq!(e, "ask_ceo is not a tool of the executor");
    let e = tool(&app, l1, "spawn_lead", json!({"title": "t", "brief": "b"})).unwrap_err();
    assert_eq!(e, "spawn_lead is not a tool of the lead");
    let e = tool(
        &app,
        l1,
        "spawn_executor",
        json!({"title": "t", "brief": "b"}),
    )
    .unwrap_err();
    assert!(e.contains("files is required"), "{e}");
    let bad = json!({"title": "t", "brief": "b", "files": "src"});
    assert!(tool(&app, l1, "spawn_executor", bad).is_err());
    assert!(store.list_messages(&p.id).unwrap().is_empty());

    // An executor's report and ask go to its Lead, a teammate's send to the teammate, the Lead's report to the CEO.
    tool(
        &app,
        a1,
        "send",
        json!({"to": "a2", "body": "mine is a.txt"}),
    )
    .unwrap();
    tool(&app, a1, "report", json!({"body": "done"})).unwrap();
    tool(&app, a1, "ask", json!({"body": "which?"})).unwrap();
    tool(&app, l1, "send", json!({"to": "l2", "body": "careful"})).unwrap();
    tool(&app, l1, "report", json!({"body": "merged"})).unwrap();
    let pending = tool(&app, l1, "ask_ceo", json!({"body": "conflict?"})).unwrap();
    assert!(
        pending.contains("call mcp__ceo__ask_ceo with resume"),
        "{pending}"
    );
    let got: Vec<String> = store
        .list_messages(&p.id)
        .unwrap()
        .iter()
        .map(|m| format!("{} {}>{}", m.kind, m.from, m.to))
        .collect();
    assert_eq!(
        got,
        [
            "send a1>a2",
            "report a1>l1",
            "ask a1>l1",
            "send l1>l2",
            "report l1>ceo",
            "ask l1>ceo"
        ]
    );
}

#[test]
fn files_overlap_on_path_boundaries() {
    let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let o = |a: &[&str], b: &[&str]| bus::overlap(&v(a), &v(b)).map(|(x, y)| format!("{x} {y}"));
    assert_eq!(
        o(&["src/a.rs"], &["src/a.rs"]).as_deref(),
        Some("src/a.rs src/a.rs")
    );
    assert_eq!(
        o(&["x", "src/a.rs"], &["src"]).as_deref(),
        Some("src/a.rs src")
    );
    assert_eq!(
        o(&["src/"], &["src/a/b.rs"]).as_deref(),
        Some("src/ src/a/b.rs")
    );
    assert_eq!(
        o(&["./src/a"], &["src/a/b.rs"]).as_deref(),
        Some("./src/a src/a/b.rs")
    );
    assert_eq!(
        o(&["."], &["docs"]).as_deref(),
        Some(". docs"),
        "the whole repo"
    );
    assert_eq!(o(&["/src/app"], &["src"]).as_deref(), Some("/src/app src"));
    assert_eq!(o(&["src/a"], &["src/ab"]), None, "not on a / boundary");
    assert_eq!(o(&["src/a.rs"], &["src/a.rs.bak"]), None);
    assert_eq!(o(&["a", "b"], &["c/a", "bb"]), None);
    assert_eq!(o(&[], &["src"]), None, "a review touches nothing");
}

#[test]
fn a_lead_spawns_its_team_off_its_branch_and_is_retired_after_it() {
    let sock = TestSocket(format!("ceo-test-team-{}", std::process::id()));
    let (d, repo) = repo();
    let app = mock_app(d.path(), Ok(sleeper(d.path())), &sock.0);
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let p = store.create_project("p", repo.to_str().unwrap()).unwrap();
    let ceo = s
        .create(&store, &p.id, "ceo-node", "ceo", None, "ceo")
        .unwrap();
    let ceo_node = BoardNode {
        id: "ceo-node".into(),
        kind: "ceo".into(),
        x: 0.0,
        y: 0.0,
        width: None,
        height: None,
        data: json!({"name": "CEO", "model": "haiku"}),
        z: 0,
    };
    let changes = BoardChanges {
        upsert_nodes: vec![ceo_node],
        ..Default::default()
    };
    store.save_board(&p.id, &changes).unwrap();
    // A spawned session, with the args file the sleeper writes read and removed, so its worktree is clean.
    let spawned = |out: Result<String, String>| {
        let out = out.unwrap();
        let v: serde_json::Value = serde_json::from_str(out.lines().next().unwrap()).unwrap();
        let row = store
            .node_session(&p.id, v["node"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let wt = PathBuf::from(row.worktree.clone().unwrap());
        let args = wait_read(&wt.join("args"));
        std::fs::remove_file(wt.join("args")).unwrap();
        (row, wt, args)
    };

    let brief = json!({"title": "Wave of three", "brief": "a; b; c", "model": "sonnet"});
    let (lead, lead_wt, args) = spawned(tool(&app, &ceo, "spawn_lead", brief));
    assert_eq!(
        (lead.role.as_str(), lead.parent.as_deref()),
        ("lead", Some("ceo-node"))
    );
    let lead_branch = lead.branch.clone().unwrap();
    assert!(
        lead_branch.starts_with("ceo/lead-wave-of-three-"),
        "{lead_branch}"
    );
    assert!(lead.tmux_name.starts_with("lead-"));
    assert!(
        args.contains("--append-system-prompt You are a Lead") && args.contains("--model sonnet"),
        "{args}"
    );
    git(
        &lead_wt,
        &["commit", "-q", "--allow-empty", "-m", "lead base"],
    );

    let team = |title: &str, files: serde_json::Value| {
        let brief = json!({"title": title, "brief": format!("write {title}"), "files": files});
        tool(&app, &lead, "spawn_executor", brief)
    };
    let (a, a_wt, args) = spawned(team("a", json!(["src/a"])));
    assert!(args.contains("--model sonnet"), "the Lead's model: {args}");
    let e = team("a2", json!(["src/a/x.rs"])).unwrap_err();
    assert!(
        e.contains("src/a/x.rs overlaps src/a")
            && e.contains(&a.node_id)
            && e.contains("wait for its report"),
        "{e}"
    );
    let (b, b_wt, _) = spawned(team("b", json!(["src/b"])));
    let (c, c_wt, _) = spawned(team("c", json!(["src/c"])));
    assert_eq!(
        git(&a_wt, &["rev-parse", "HEAD"]),
        git(&lead_wt, &["rev-parse", "HEAD"]),
        "executors start off the Lead's branch"
    );
    let board = store.load_board(&p.id).unwrap();
    let at = |id: &str| board.nodes.iter().find(|n| n.id == id).unwrap();
    let ln = at(&lead.node_id);
    assert_eq!((ln.kind.as_str(), ln.x, ln.y), ("lead", 1000.0, 0.0));
    for (i, x) in [&a, &b, &c].into_iter().enumerate() {
        let n = at(&x.node_id);
        assert_eq!(
            (n.kind.as_str(), n.x, n.y, n.data["leadId"].as_str()),
            (
                "executor",
                2000.0,
                320.0 * i as f64,
                Some(lead.node_id.as_str())
            )
        );
        assert_eq!(x.parent.as_deref(), Some(lead.node_id.as_str()));
        assert!(board.edges.iter().any(|e| e.source == lead.node_id
            && e.target == x.node_id
            && e.data["kind"] == "spawn"));
    }

    // a and b are merged into the Lead; c's commit is not.
    for (wt, f) in [(&a_wt, "a"), (&b_wt, "b"), (&c_wt, "c")] {
        std::fs::write(wt.join(f), f).unwrap();
        git(wt, &["add", f]);
        git(wt, &["commit", "-q", "-m", f]);
    }
    for x in [&a, &b] {
        let branch = x.branch.as_deref().unwrap();
        git(
            &lead_wt,
            &[
                "merge",
                "-q",
                "--no-ff",
                "-m",
                &format!("Merge {branch}"),
                branch,
            ],
        );
    }
    for x in [&lead, &b, &c] {
        store.set_session_status(&x.id, "idle", "Ready").unwrap();
    }
    let tmux = s.tmux().unwrap();

    // The Lead accepts a's report: a ends after its turn and its branch, merged into the Lead, is deleted.
    tool(&app, &a, "report", json!({"body": "a done"})).unwrap();
    let m = store.inbox(&p.id, &lead.node_id).unwrap().pop().unwrap();
    tool(&app, &lead, "accept", json!({"id": m.id})).unwrap();
    // Accepted is done: a follow-up on a's files may start while a still finishes its turn.
    let (follow, follow_wt, _) = spawned(team("a again", json!(["src/a/x.rs"])));
    assert!(store.session(&a.id).unwrap().is_some(), "a is still ending");
    store.set_session_status(&a.id, "idle", "Ready").unwrap();
    store
        .set_session_status(&follow.id, "idle", "Ready")
        .unwrap();
    wait_until("a ends", || store.session(&a.id).unwrap().is_none());
    assert!(!tmux.has(&a.tmux_name) && !a_wt.exists());
    assert!(!branches(&repo).contains(a.branch.as_deref().unwrap()));

    // The CEO accepts the Lead's report: b and c end first, then the Lead.
    tool(
        &app,
        &lead,
        "report",
        json!({"body": "merged a, b; gate ok"}),
    )
    .unwrap();
    let m = store.inbox(&p.id, "ceo-node").unwrap().pop().unwrap();
    assert_eq!(m.from, lead.node_id);
    let text = tool(&app, &ceo, "accept", json!({"id": m.id})).unwrap();
    assert!(text.contains("the Lead and its executors end"), "{text}");
    wait_until("the Lead ends", || {
        store.session(&lead.id).unwrap().is_none()
    });
    for x in [&lead, &b, &c, &follow] {
        assert!(store.session(&x.id).unwrap().is_none());
        assert!(!tmux.has(&x.tmux_name), "{}", x.tmux_name);
    }
    assert!(!lead_wt.exists() && !b_wt.exists() && !c_wt.exists() && !follow_wt.exists());
    // b's branch went only because it was checked against the Lead's worktree, so b ended before the Lead.
    let left = branches(&repo);
    assert!(!left.contains(b.branch.as_deref().unwrap()), "{left}");
    assert!(
        left.contains(c.branch.as_deref().unwrap()),
        "unmerged work stays: {left}"
    );
    assert!(left.contains(&lead_branch), "{left}");
    assert_eq!(
        git(&repo, &["log", "--merges", "--format=%s", &lead_branch])
            .lines()
            .count(),
        2
    );
    let board = store.load_board(&p.id).unwrap();
    assert_eq!(
        board
            .nodes
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        ["ceo-node"]
    );
    assert!(board.edges.is_empty());
    app.state::<Sessions>().remove(&store, &ceo).unwrap();
}

// #21: memory, prime, token accounting and profiles.

const FIXTURE: &str = include_str!("fixtures/transcript.jsonl");
const RESUMED: &str = include_str!("fixtures/transcript-resumed.jsonl");

#[test]
fn transcript_parser_counts_every_field_on_the_fixture() {
    assert_eq!(
        usage::millis("2026-10-23T10:00:02.500Z"),
        Some(1_792_749_602_500)
    );
    assert_eq!(usage::millis("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(usage::millis("1970-01-01T00:00:01.5Z"), Some(1500));
    assert_eq!(usage::millis("1970-01-01T00:00:01.123456Z"), Some(1123));
    let mut cur = usage::Cursor::default();
    let d = usage::parse(FIXTURE.as_bytes(), &mut cur);
    // msg_01 spans two lines with the same usage and counts once.
    assert_eq!(
        (d.input, d.output, d.cache_read),
        (3 + 5 + 2 + 4, 100 + 200 + 50 + 80, 11000 + 18000 + 9000)
    );
    assert_eq!((d.cache_1h, d.cache_5m), (7000 + 500 + 12000, 3000));
    assert_eq!(d.first_prompt, Some(3 + 11000 + 7000));
    assert_eq!(d.compactions, 1);
    // 18 minutes after a 5m write, nothing read: an idle miss; 30 s and 90 s gaps are not.
    assert_eq!(
        d.misses,
        vec![json!({"gap": "18m", "ttl": "5m", "tokens": 12004})]
    );
    assert_eq!(d.context, Some(12004));
    assert_eq!(cur.offset, FIXTURE.len() as u64);
    assert!(cur.ttl_1h, "the last write was 1h");

    // The resumed session appends to the same file: only the new lines count, the first prompt stays.
    let all = format!("{FIXTURE}{RESUMED}");
    let d = usage::parse(&all.as_bytes()[cur.offset as usize..], &mut cur);
    assert_eq!((d.input, d.output, d.cache_read), (7, 100, 15200));
    assert_eq!((d.cache_1h, d.cache_5m), (15000, 0));
    assert_eq!(d.first_prompt, None);
    assert_eq!(d.compactions, 0);
    assert_eq!(
        d.misses,
        vec![json!({"gap": "1h40m", "ttl": "1h", "tokens": 15106})]
    );
    assert_eq!(d.context, Some(15101));
    assert_eq!(cur.offset, all.len() as u64);

    // A line still being written is left for the next read.
    let mut cur = usage::Cursor::default();
    let cut = FIXTURE.len() - 10;
    let d = usage::parse(&FIXTURE.as_bytes()[..cut], &mut cur);
    assert_eq!(
        d.context,
        Some(2 + 9000 + 3000),
        "msg_04 is not complete yet"
    );
    let d = usage::parse(&FIXTURE.as_bytes()[cur.offset as usize..], &mut cur);
    assert_eq!((d.input, d.misses.len()), (4, 1));
}

fn ceo_board(store: &Store, project: &str, note: Option<&str>) {
    let mut nodes = vec![BoardNode {
        id: "ceo".into(),
        kind: "ceo".into(),
        x: 0.0,
        y: 0.0,
        width: None,
        height: None,
        data: json!({"name": "CEO", "model": "opus"}),
        z: 0,
    }];
    let mut edges = vec![];
    if let Some(text) = note {
        nodes.push(BoardNode {
            id: "note".into(),
            kind: "note".into(),
            data: json!({"text": text, "color": "yellow"}),
            ..nodes[0].clone()
        });
        edges.push(crate::store::BoardEdge {
            id: "e".into(),
            source: "note".into(),
            target: "ceo".into(),
            data: json!({}),
        });
    }
    let changes = BoardChanges {
        upsert_nodes: nodes,
        upsert_edges: edges,
        ..Default::default()
    };
    store.save_board(project, &changes).unwrap();
}

#[test]
fn usage_is_read_from_the_stored_offset_and_kept_per_session() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    ceo_board(&store, &p.id, None);
    let ceo = session("ceo", &p.id, "ceo", None);
    store.insert_session(&ceo).unwrap();
    let path = d.path().join("t.jsonl");
    let file = path.to_str().unwrap();
    std::fs::write(&path, FIXTURE).unwrap();
    let u = usage::record(app.handle(), &ceo, file).unwrap();
    assert_eq!((u.input, u.cache_write_1h, u.compactions), (14, 19500, 1));
    assert_eq!((u.role.as_str(), u.task.as_str()), ("ceo", "CEO"));
    // Nothing new, nothing added.
    assert_eq!(usage::record(app.handle(), &ceo, file).unwrap(), u);
    // Half a line, then the rest: counted once it is complete.
    let (head, tail) = RESUMED.split_at(RESUMED.len() - 20);
    std::fs::write(&path, format!("{FIXTURE}{head}")).unwrap();
    let mid = usage::record(app.handle(), &ceo, file).unwrap();
    assert_eq!(mid.input, 14 + 6);
    std::fs::write(&path, format!("{FIXTURE}{head}{tail}")).unwrap();
    let u = usage::record(app.handle(), &ceo, file).unwrap();
    assert_eq!((u.input, u.output, u.cache_read), (21, 530, 53200));
    assert_eq!(u.first_prompt, Some(18003));
    assert_eq!(u.idle_misses.len(), 2);
    assert_eq!(u.context, Some(15101));
    // A wave boundary records the context the CEO holds then; the row outlives the session.
    usage::wave_mark(app.handle(), &ceo);
    store.remove_session(&ceo.id, None).unwrap();
    let list = store.usage_list(&p.id).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].wave_contexts, vec![15101]);
    assert_eq!(list[0].session_id, ceo.id);
}

#[test]
fn prime_stays_under_the_cap_cutting_details_then_notes_never_core() {
    let core: String = (0..400)
        .map(|i| format!("fact {i:03}: the owner wants every wave reported with its gate line\n"))
        .collect();
    assert!(core.len() > 20_000);
    let index: Vec<String> = (0..200)
        .map(|i| format!("- notes/topic-{i}.md: what we decided about topic {i}"))
        .collect();
    let notes = vec![format!("- {}", "board note text ".repeat(400))];
    let details: Vec<String> = (0..300)
        .map(|i| format!("- Executor {i} (executor): working, Running Bash, branch ceo/exec-{i}"))
        .collect();
    let snapshot = "Wave state: 300 executors live, 2 unaccepted messages for you.";
    let p = prime::ceo(
        "/data/memory/p",
        &core,
        snapshot,
        index.clone(),
        notes.clone(),
        details.clone(),
    );
    assert!(p.chars().count() <= prime::CAP, "{}", p.len());
    // core.md is cut only by its own cap: every whole line of its first 8000 characters is there.
    let kept: String = core.chars().take(memory::CORE_CAP).collect();
    for line in kept.lines().take(kept.lines().count() - 1) {
        assert!(p.contains(line), "{line}");
    }
    assert!(!p.contains("fact 399"));
    assert!(p.contains("/data/memory/p") && p.contains(snapshot));
    assert!(!p.contains("Executor 299"), "details go first");

    // With a small core, notes fit and the details are what gets cut.
    let p = prime::ceo(
        "/m",
        "one fact",
        snapshot,
        index[..5].to_vec(),
        notes,
        details,
    );
    assert!(p.chars().count() <= prime::CAP);
    assert!(p.contains("one fact") && p.contains("topic-4.md") && p.contains("board note text"));
    assert!(p.contains("Executor 0 ") && !p.contains("Executor 299"));
    assert!(
        prime::fit(
            &[("## Board notes linked to you".into(), vec![])],
            prime::CAP
        )
        .is_empty()
    );
}

#[test]
fn session_start_takes_the_new_id_and_answers_with_the_prime_and_stop_commits_memory() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    ceo_board(&store, &p.id, Some("Ship the memory slice first"));
    let mut ceo = session("ceo", &p.id, "ceo", None);
    ceo.claude_session_id = "before-clear".into();
    store.insert_session(&ceo).unwrap();
    let mem = memory::dir(app.handle(), &p.id);
    std::fs::create_dir_all(mem.join("notes")).unwrap();
    std::fs::write(mem.join("core.md"), "The owner's codeword is PLUM.\n").unwrap();
    std::fs::write(mem.join("notes/waves.md"), "# How waves are cut\nbody").unwrap();

    let answer = on_hook(
        app.handle(),
        &ceo,
        &json!({"hook_event_name": "SessionStart", "source": "clear", "session_id": "after-clear"}),
    );
    let answer: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(
        answer["hookSpecificOutput"]["hookEventName"],
        "SessionStart"
    );
    let text = answer["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    for want in [
        "The owner's codeword is PLUM.",
        "Wave state: no executors live, 0 unaccepted messages",
        "- notes/waves.md: How waves are cut",
        "- Ship the memory slice first",
        "- CEO (ceo): working",
        &mem.to_string_lossy(),
    ] {
        assert!(text.contains(want), "{want} in {text}");
    }
    assert_eq!(
        store.session(&ceo.id).unwrap().unwrap().claude_session_id,
        "after-clear",
        "a later --resume resumes the cleared conversation"
    );
    // The same id again changes nothing.
    let row = store.session(&ceo.id).unwrap().unwrap();
    on_hook(
        app.handle(),
        &row,
        &json!({"hook_event_name": "SessionStart", "source": "resume", "session_id": "after-clear"}),
    );
    assert_eq!(
        store.session(&ceo.id).unwrap().unwrap().claude_session_id,
        "after-clear"
    );

    // An executor without linked notes gets no context at all.
    let exec = session("exec", &p.id, "executor", Some("ceo"));
    store.insert_session(&exec).unwrap();
    assert_eq!(
        on_hook(
            app.handle(),
            &exec,
            &json!({"hook_event_name": "SessionStart", "source": "startup", "session_id": "x"})
        ),
        ""
    );

    // The CEO's Stop commits its memory edits and records the turn's tokens.
    let path = d.path().join("ceo.jsonl");
    std::fs::write(&path, FIXTURE).unwrap();
    on_hook(
        app.handle(),
        &row,
        &json!({"hook_event_name": "Stop", "stop_hook_active": true, "transcript_path": path}),
    );
    wait_until("the memory commit", || {
        Command::new("git")
            .arg("-C")
            .arg(&mem)
            .args(["log", "--format=%s"])
            .output()
            .unwrap()
            .stdout
            == b"memory: core.md, notes/waves.md\n"
    });
    assert_eq!(git(&mem, &["config", "--local", "user.name"]), "CEO memory");
    std::fs::write(
        mem.join("core.md"),
        "The owner's codeword is PLUM.\nNew fact.\n",
    )
    .unwrap();
    on_hook(
        app.handle(),
        &row,
        &json!({"hook_event_name": "Stop", "stop_hook_active": true}),
    );
    wait_until("the second commit", || {
        git(&mem, &["rev-list", "--count", "HEAD"]) == "2"
    });
    assert_eq!(git(&mem, &["log", "-1", "--format=%s"]), "memory: core.md");
    assert_eq!(store.usage(&ceo.id).unwrap().unwrap().input, 14);
}

#[test]
fn profiles_default_override_key_by_key_and_follow_precedence() {
    let d = tempfile::tempdir().unwrap();
    let p = profile::load(d.path());
    let get = |role, key| profile::get(&p, role, key);
    assert_eq!(
        (get("ceo", "model"), get("ceo", "effort")),
        (Some("opus".into()), Some("medium".into()))
    );
    assert_eq!(
        (get("lead", "model"), get("lead", "effort")),
        (Some("sonnet".into()), Some("high".into()))
    );
    assert_eq!(
        (get("executor", "model"), get("executor", "effort")),
        (Some("sonnet".into()), None)
    );
    assert_eq!(get("mechanical", "model"), Some("haiku".into()));
    assert_eq!(get("review", "model"), Some("opus".into()));
    assert!(
        profile::advice(&p).contains("haiku for mechanical work")
            && profile::advice(&p).contains("opus for reviews")
    );

    std::fs::write(
        d.path().join("profiles.json"),
        r#"{"ceo": {"effort": "high"}, "mechanical": {"model": "sonnet"}}"#,
    )
    .unwrap();
    let p = profile::load(d.path());
    assert_eq!(
        profile::get(&p, "ceo", "model"),
        Some("opus".into()),
        "untouched keys stay"
    );
    assert_eq!(profile::get(&p, "ceo", "effort"), Some("high".into()));
    assert!(profile::advice(&p).contains("sonnet for mechanical work"));

    let s = |a: Option<&str>, b: Option<&str>| (a.map(String::from), b.map(String::from));
    assert_eq!(
        profile::pick(&p, "ceo", &json!({}), None),
        s(Some("opus"), Some("high"))
    );
    assert_eq!(
        profile::pick(&p, "ceo", &json!({}), Some("sonnet")),
        s(Some("sonnet"), Some("high")),
        "the node beats the profile"
    );
    assert_eq!(
        profile::pick(
            &p,
            "executor",
            &json!({"model": "haiku", "effort": "low"}),
            Some("opus")
        ),
        s(Some("haiku"), Some("low")),
        "spawn arguments beat the node"
    );
    assert_eq!(
        profile::pick(&p, "executor", &json!({"model": null}), None),
        s(Some("sonnet"), None)
    );
}

#[test]
fn the_ceo_launches_with_its_profile_the_advice_and_no_idle_compaction() {
    let sock = TestSocket(format!("ceo-test-prof-{}", std::process::id()));
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Ok(sleeper(d.path())), &sock.0);
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    let p = store
        .create_project("p", d.path().to_str().unwrap())
        .unwrap();
    let ceo = s.create(&store, &p.id, "ceo", "ceo", None, "ceo").unwrap();
    s.launch(&ceo, (100, 30), "--session-id").unwrap();
    let args = wait_read(&d.path().join("args"));
    assert!(
        args.trim_end().ends_with("--model opus --effort medium"),
        "{args}"
    );
    assert!(
        args.contains("haiku for mechanical work")
            && args.contains(
                "Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context"
            ),
        "{args}"
    );
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(s.session_dir(&ceo.id).join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(settings["idleCompaction"], false);
    s.remove(&store, &ceo).unwrap();
}

#[test]
fn a_spawned_agent_that_stops_without_reporting_is_sent_back_once() {
    let d = tempfile::tempdir().unwrap();
    let app = mock_app(d.path(), Err("unused".into()), "unused");
    let store = app.state::<Store>();
    let p = store.create_project("p", "/tmp").unwrap();
    let rows = [
        session("ceo", &p.id, "ceo", None),
        session("l1", &p.id, "lead", Some("ceo")),
        session("a1", &p.id, "executor", Some("l1")),
    ];
    for r in &rows {
        store.insert_session(r).unwrap();
    }
    let [ceo, l1, a1] = &rows;
    let stop = |row: &AgentSession, active: bool| -> serde_json::Value {
        let out = on_hook(
            app.handle(),
            row,
            &json!({"hook_event_name": "Stop", "stop_hook_active": active}),
        );
        if out.is_empty() {
            json!(null)
        } else {
            serde_json::from_str(&out).unwrap()
        }
    };
    let told = stop(a1, false);
    assert_eq!(told["decision"], "block");
    assert!(
        told["reason"]
            .as_str()
            .unwrap()
            .contains("mcp__ceo__report")
    );
    assert_eq!(stop(a1, true), json!(null), "once per stop");
    assert_eq!(
        stop(l1, false),
        json!(null),
        "a Lead with a live team is waiting"
    );
    assert_eq!(stop(ceo, false), json!(null), "the CEO reports to nobody");
    tool(&app, a1, "report", json!({"body": "done"})).unwrap();
    // The report itself is a message for l1, so its Stop delivers that first.
    let m = store.inbox(&p.id, "l1").unwrap();
    store.accept_message(&m[0].id, "l1").unwrap();
    assert_eq!(stop(a1, false), json!(null), "reported");
}
