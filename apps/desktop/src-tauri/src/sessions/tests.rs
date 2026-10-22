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
    assert!(
        store.node_session(&p.id, "n1").unwrap().is_none(),
        "the node is free for a new session"
    );
    assert!(store.session(&row.id).unwrap().is_none());

    // Clean worktree: everything goes.
    let clean = s.create(&store, &p.id, "n2", "ceo", None, "ceo").unwrap();
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
        ["report", "ask", "inbox", "accept"]
    );
    assert_eq!(
        names(bus::tools("ceo")),
        [
            "spawn_executor",
            "send",
            "interrupt",
            "stop",
            "reply",
            "inbox",
            "accept"
        ]
    );
    assert!(bus::linked(&ceo, &e1) && bus::linked(&e1, &ceo));
    assert!(!bus::linked(&e1, &e2), "executor to executor");
    assert!(
        !bus::linked(&e3, &ceo) && !bus::linked(&ceo, &e3),
        "someone else's executor"
    );
    assert!(!bus::linked(&ceo, &boss));

    // An executor calling CEO tools, or messaging another executor.
    let e = tool(&app, &e1, "send", json!({"to": "e2", "body": "hi"})).unwrap_err();
    assert_eq!(e, "send is not a tool of the executor");
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
    let e = bus::send(app.handle(), &e1, &e2, "send", "hi", None).unwrap_err();
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
        ["report", "ask", "inbox", "accept"]
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
    std::fs::write(&stub, "#!/bin/sh\necho \"$@\" > args\nexec sleep 600\n").unwrap();
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

    let brief = json!({"title": "Add hello file!", "brief": "- write hello.txt", "effort": "low"});
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
        args.ends_with("--model haiku --effort low -- - write hello.txt\n"),
        "model from the CEO's node: {args}"
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
    let bad = json!({"title": "t", "brief": "b", "model": "gpt"});
    assert!(tool(&app, &ceo, "spawn_executor", bad).is_err());

    // The executor commits and reports; the idle CEO gets a typed pointer, never the text.
    std::fs::remove_file(wt.join("args")).unwrap();
    git(&wt, &["commit", "-q", "--allow-empty", "-m", "exec work"]);
    store
        .set_session_status(&exec.id, "idle", "Turn finished")
        .unwrap();
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
        pane.contains("1 new message, call mcp__ceo__inbox"),
        "{pane}"
    );
    assert!(!pane.contains("secret result text"));

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
