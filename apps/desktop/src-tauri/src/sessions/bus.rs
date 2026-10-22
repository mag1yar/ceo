//! The agent bus: tools by role, links checked here, and delivery into an idle pane or the next hook of a busy one.

use super::{Res, Sessions, hooks, report, uuid};
use crate::store::{AgentSession, BoardChanges, BoardEdge, BoardNode, Message, Store};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const BUS_EVENT: &str = "bus://message";
/// Board changes made by Rust (a spawned executor, a retired one) for the open board to merge.
pub const BOARD_EVENT: &str = "board://changes";
/// How long `ask` blocks before it returns `{pending}`; well under the MCP tool timeout set in the shim's config.
pub const ASK_WAIT: Duration = Duration::from_secs(300);
/// A pane is typed into only after its hooks have been quiet this long, so a turn that just ended is really over.
const TYPE_QUIET: Duration = Duration::from_millis(500);

const MODELS: &[&str] = &["haiku", "sonnet", "opus"];
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BoardEvent<'a> {
    project_id: &'a str,
    #[serde(flatten)]
    changes: &'a BoardChanges,
}

pub fn role_prompt(role: &str) -> &'static str {
    match role {
        "executor" => {
            "You are an executor the CEO agent spawned for one task, in your own git worktree on your own branch. \
             Do the brief, run its acceptance check, commit your work on your branch (never push, never touch main), \
             then call mcp__ceo__report with the result and the check's output. If you are blocked, call mcp__ceo__ask. \
             When told about new messages, call mcp__ceo__inbox and mcp__ceo__accept each one once handled."
        }
        _ => {
            "You are the CEO agent of this project. Hand each task to an executor: call mcp__ceo__spawn_executor \
             with a title and a brief that says what to do and which acceptance check to run. Executors answer \
             through the bus: when told about new messages, call mcp__ceo__inbox, act on each, then mcp__ceo__accept it \
             (or mcp__ceo__reply to an ask). Accepting an executor's report ends that executor; its branch stays for \
             the owner to merge. Never merge into main and never push."
        }
    }
}

fn tool(name: &str, description: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": props, "required": required },
    })
}

pub fn tools(role: &str) -> Value {
    let text = |d: &str| json!({ "type": "string", "description": d });
    let mut list = vec![];
    if role == "ceo" {
        list.extend([
            tool(
                "spawn_executor",
                "Start an executor agent for one task in its own worktree and branch.",
                json!({
                    "title": text("Short task title"),
                    "brief": text("What to do and the acceptance check to run"),
                    "model": { "type": "string", "enum": MODELS },
                    "effort": { "type": "string", "enum": EFFORTS },
                }),
                &["title", "brief"],
            ),
            tool(
                "send",
                "Send a message to one of your executors.",
                json!({ "to": text("Executor node id"), "body": text("Message") }),
                &["to", "body"],
            ),
            tool(
                "interrupt",
                "Stop an executor's current turn, then send it a message.",
                json!({ "to": text("Executor node id"), "body": text("Message") }),
                &["to", "body"],
            ),
            tool(
                "stop",
                "End an executor now; its branch stays.",
                json!({ "to": text("Executor node id") }),
                &["to"],
            ),
            tool(
                "reply",
                "Answer a message (an executor's ask); accepts it.",
                json!({ "id": text("Message id"), "body": text("Reply") }),
                &["id", "body"],
            ),
        ]);
    } else {
        list.extend([
            tool(
                "report",
                "Report the task's result to your CEO.",
                json!({ "body": text("Result and the acceptance check's output") }),
                &["body"],
            ),
            tool(
                "ask",
                "Ask your CEO and wait for the reply. Returns {pending: id} if it takes long; call again with resume: id.",
                json!({ "body": text("Question"), "resume": text("Id of an earlier ask to keep waiting for") }),
                &[],
            ),
        ]);
    }
    list.extend([
        tool(
            "inbox",
            "Messages you have not accepted yet.",
            json!({}),
            &[],
        ),
        tool(
            "accept",
            "Mark a message handled.",
            json!({ "id": text("Message id") }),
            &["id"],
        ),
    ]);
    json!({ "tools": list })
}

/// MCP `tools/call` params in, an MCP tool result out; errors reach the agent as text.
pub fn call<R: Runtime>(app: &AppHandle<R>, row: &AgentSession, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or("");
    let (text, is_error) = match dispatch(app, row, name, &params["arguments"]) {
        Ok(t) => (t, false),
        Err(e) => (e, true),
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    row: &AgentSession,
    name: &str,
    args: &Value,
) -> Res<String> {
    let store = app.state::<Store>();
    let arg = |k: &str| {
        args[k]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("{k} is required"))
    };
    match (row.role.as_str(), name) {
        ("ceo", "spawn_executor") => spawn_executor(
            app,
            row,
            arg("title")?,
            arg("brief")?,
            args["model"].as_str(),
            args["effort"].as_str(),
        ),
        ("ceo", "send") => {
            let to = peer(&store, row, arg("to")?)?;
            send(app, row, &to, "send", arg("body")?, None).map(|m| format!("Sent {}.", m.id))
        }
        ("ceo", "interrupt") => {
            let to = peer(&store, row, arg("to")?)?;
            let body = arg("body")?;
            app.state::<Sessions>()
                .tmux()?
                .key(&to.tmux_name, "Escape")?;
            // An Esc interrupt never fires Stop, so the pane is idle by our word; a booting one stays "Starting".
            std::thread::sleep(Duration::from_millis(300));
            if to.action != "Starting" {
                report(app, &to.project_id, &to.node_id, "idle", "Interrupted");
            }
            send(app, row, &to, "send", body, None).map(|m| format!("Interrupted, sent {}.", m.id))
        }
        ("ceo", "stop") => {
            let to = peer(&store, row, arg("to")?)?;
            retire(app, to.clone(), false, "Stopped by the CEO");
            Ok(format!(
                "Stopping {}; branch {} stays if it has commits.",
                to.node_id,
                to.branch.as_deref().unwrap_or("-")
            ))
        }
        ("ceo", "reply") => {
            let id = arg("id")?;
            let ask = store
                .message(id)?
                .filter(|m| m.to == row.node_id && m.project_id == row.project_id);
            let ask = ask.ok_or_else(|| format!("no message {id} addressed to you"))?;
            if ask.kind != "ask" {
                return Err(format!(
                    "message {id} is a {}, not an ask; call mcp__ceo__accept for it",
                    ask.kind
                ));
            }
            let to = peer(&store, row, &ask.from)?;
            let r = send(app, row, &to, "reply", arg("body")?, Some(&ask.thread))?;
            // Replying is accepting; an ask accepted earlier stays as it is.
            if let Ok(m) = store.accept_message(id, &row.node_id) {
                emit(app, &m);
            }
            Ok(format!("Replied {}.", r.id))
        }
        ("executor", "report") => {
            let ceo = parent(&store, row)?;
            send(app, row, &ceo, "report", arg("body")?, None)
                .map(|m| format!("Reported {}.", m.id))
        }
        ("executor", "ask") => ask(app, row, args, app.state::<Sessions>().ask_wait),
        (_, "inbox") => {
            // Delivered once this result reaches claude: its PostToolUse marks them (see `delivered_in`).
            let list = store.inbox(&row.project_id, &row.node_id)?;
            Ok(if list.is_empty() {
                "No messages.".into()
            } else {
                render(&list)
            })
        }
        (_, "accept") => {
            let m = store.accept_message(arg("id")?, &row.node_id)?;
            emit(app, &m);
            if m.kind == "report"
                && let Some(exec) = store.node_session(&row.project_id, &m.from)?
                && exec.role == "executor"
            {
                retire(app, exec, true, "Report accepted");
                return Ok(format!(
                    "Accepted {}; the executor ends and its branch stays.",
                    m.id
                ));
            }
            Ok(format!("Accepted {}.", m.id))
        }
        (role, name) => Err(format!("{name} is not a tool of the {role}")),
    }
}

/// The only links on the bus: a CEO and the executors it spawned.
pub fn linked(a: &AgentSession, b: &AgentSession) -> bool {
    a.project_id == b.project_id
        && match (a.role.as_str(), b.role.as_str()) {
            ("ceo", "executor") => b.parent.as_deref() == Some(&a.node_id),
            ("executor", "ceo") => a.parent.as_deref() == Some(&b.node_id),
            _ => false,
        }
}

fn peer(store: &Store, from: &AgentSession, to: &str) -> Res<AgentSession> {
    store
        .node_session(&from.project_id, to)?
        .filter(|t| linked(from, t))
        .ok_or_else(|| format!("{to} is not linked to you on the bus"))
}

fn parent(store: &Store, row: &AgentSession) -> Res<AgentSession> {
    peer(store, row, row.parent.as_deref().unwrap_or_default())
}

pub fn emit<R: Runtime>(app: &AppHandle<R>, m: &Message) {
    let _ = app.emit(BUS_EVENT, m);
}

fn emit_board<R: Runtime>(app: &AppHandle<R>, project_id: &str, changes: &BoardChanges) {
    let _ = app.emit(
        BOARD_EVENT,
        BoardEvent {
            project_id,
            changes,
        },
    );
}

/// Stores the message, then delivers it if the recipient sits idle; a busy one gets it from its next hook.
pub fn send<R: Runtime>(
    app: &AppHandle<R>,
    from: &AgentSession,
    to: &AgentSession,
    kind: &str,
    body: &str,
    thread: Option<&str>,
) -> Res<Message> {
    if !linked(from, to) {
        return Err(format!("{} is not linked to you on the bus", to.node_id));
    }
    let m = app.state::<Store>().add_message(
        &from.project_id,
        &from.node_id,
        &to.node_id,
        kind,
        body,
        thread,
    )?;
    emit(app, &m);
    nudge(app, to.clone());
    Ok(m)
}

/// The text a hook or the inbox hands the agent.
pub fn render(list: &[Message]) -> String {
    let mut out = String::from("Messages on the CEO bus:\n");
    for m in list {
        out += &format!("- id {} · {} from {}: {}\n", m.id, m.kind, m.from, m.body);
    }
    out + "Handle each, then call mcp__ceo__accept with its id (answer an ask with mcp__ceo__reply)."
}

/// After a bus tool's PostToolUse: the messages its result showed (`id <hex>`) reached the agent.
pub fn delivered_in<R: Runtime>(app: &AppHandle<R>, row: &AgentSession, result: &Value) {
    let store = app.state::<Store>();
    let text = result.to_string();
    for part in text.split("id ").skip(1) {
        let id: String = part.chars().take_while(char::is_ascii_hexdigit).collect();
        let mine = store
            .message(&id)
            .ok()
            .flatten()
            .is_some_and(|m| m.to == row.node_id);
        if id.len() == 16
            && mine
            && let Ok(Some(w)) = store.mark_waiting(&id, "post_tool_use")
        {
            emit(app, &w);
        }
    }
}

/// Hands every undelivered message to the session through a hook answer; None when there is nothing.
pub fn deliver_by_hook<R: Runtime>(
    app: &AppHandle<R>,
    row: &AgentSession,
    via: &str,
) -> Option<String> {
    let store = app.state::<Store>();
    let list: Vec<Message> = store
        .undelivered(&row.project_id, &row.node_id)
        .ok()?
        .iter()
        .filter_map(|m| store.mark_waiting(&m.id, via).ok().flatten())
        .collect();
    for m in &list {
        emit(app, m);
    }
    (!list.is_empty()).then(|| render(&list))
}

/// Types a short pointer into an idle pane with an empty prompt that has undelivered messages; never into a busy one.
pub fn nudge<R: Runtime>(app: &AppHandle<R>, to: AgentSession) {
    let app = app.clone();
    std::thread::spawn(move || {
        let s = app.state::<Sessions>();
        if !s.nudging().insert(to.id.clone()) {
            return;
        }
        let store = app.state::<Store>();
        for _ in 0..40 {
            let (Ok(Some(row)), Ok(list)) = (
                store.session(&to.id),
                store.undelivered(&to.project_id, &to.node_id),
            ) else {
                break;
            };
            // "Starting" until SessionStart: never type into a claude that is still booting.
            if list.is_empty() || row.status != "idle" || row.action == "Starting" {
                break;
            }
            let quiet = s.heard().get(&row.id).map_or(TYPE_QUIET, Instant::elapsed);
            if quiet >= TYPE_QUIET {
                let n = list.len();
                let text = format!(
                    "{n} new message{}, call mcp__ceo__inbox",
                    if n == 1 { "" } else { "s" }
                );
                let Ok(tmux) = s.tmux() else { break };
                // A draft of the owner's, a dialog or a picker would take our Enter; their next prompt brings the messages.
                if !hooks::prompt_empty(&tmux.capture_styled(&row.tmux_name)) {
                    break;
                }
                let typed = tmux.type_text(&row.tmux_name, &text).and_then(|()| {
                    // Delivered before Enter, so the pointer's own UserPromptSubmit hands nothing over twice.
                    for m in &list {
                        if let Ok(Some(w)) = store.mark_waiting(&m.id, "typed") {
                            emit(&app, &w);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(150));
                    tmux.key(&row.tmux_name, "Enter")
                });
                if let Err(e) = typed {
                    println!("bus: could not type into {}: {e}", row.tmux_name);
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        s.nudging().remove(&to.id);
    });
}

fn ask<R: Runtime>(
    app: &AppHandle<R>,
    row: &AgentSession,
    args: &Value,
    wait: Duration,
) -> Res<String> {
    let store = app.state::<Store>();
    let ask = match args["resume"].as_str() {
        Some(id) => store
            .message(id)?
            .filter(|m| m.kind == "ask" && m.from == row.node_id && m.project_id == row.project_id)
            .ok_or_else(|| format!("no ask {id} of yours"))?,
        None => {
            let body = args["body"]
                .as_str()
                .filter(|b| !b.trim().is_empty())
                .ok_or("body is required")?;
            send(app, row, &parent(&store, row)?, "ask", body, None)?
        }
    };
    let deadline = Instant::now() + wait;
    loop {
        if let Some(r) = store.reply_in(&ask.thread, &row.node_id)? {
            return Ok(format!(
                "Reply id {} to your ask: {}\nAccept it with mcp__ceo__accept once handled.",
                r.id, r.body
            ));
        }
        if Instant::now() >= deadline {
            return Ok(format!(
                "{}\nNo reply yet; call mcp__ceo__ask with resume \"{}\" to keep waiting.",
                json!({ "pending": ask.id }),
                ask.id
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn slug(title: &str) -> String {
    let s: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let s: Vec<&str> = s.split('-').filter(|p| !p.is_empty()).collect();
    let s = s.join("-");
    let s = s[..s.len().min(24)].trim_end_matches('-').to_string();
    if s.is_empty() { "task".into() } else { s }
}

fn spawn_executor<R: Runtime>(
    app: &AppHandle<R>,
    ceo: &AgentSession,
    title: &str,
    brief: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Res<String> {
    let (s, store) = (app.state::<Sessions>(), app.state::<Store>());
    if effort.is_some_and(|e| !EFFORTS.contains(&e)) {
        return Err(format!("effort must be one of {}", EFFORTS.join(", ")));
    }
    let board = store.load_board(&ceo.project_id)?;
    let ceo_node = board
        .nodes
        .iter()
        .find(|n| n.id == ceo.node_id)
        .ok_or("the CEO node is gone")?;
    // The executor runs the model it is given, else the CEO's own.
    let model = match model.or(ceo_node.data["model"].as_str()) {
        Some(m) if MODELS.contains(&m) => m,
        Some(m) => return Err(format!("model {m} is not one of {}", MODELS.join(", "))),
        None => "sonnet",
    };
    let node_id = uuid();
    let op = s.lock();
    let row = s.create(
        &store,
        &ceo.project_id,
        &node_id,
        "executor",
        Some(ceo),
        &format!("exec-{}", slug(title)),
    )?;
    let profile = json!({ "brief": brief, "model": model, "effort": effort });
    let started = std::fs::create_dir_all(s.session_dir(&row.id))
        .and_then(|()| {
            std::fs::write(
                s.session_dir(&row.id).join("profile.json"),
                profile.to_string(),
            )
        })
        .map_err(|e| e.to_string())
        // Busy from the start: nothing is typed into a claude that is still booting.
        .and_then(|()| store.set_session_status(&row.id, "working", "Starting"))
        .and_then(|()| s.launch(&row, (220, 50), "--session-id"));
    drop(op);
    if let Err(e) = started {
        let _ = s.remove(&store, &row);
        return Err(e);
    }
    // Below the lowest executor still on the board, so a new one never covers a live one.
    let y = board
        .nodes
        .iter()
        .filter(|n| n.kind == "executor")
        .map(|n| n.y + 320.0)
        .fold(ceo_node.y, f64::max);
    let changes = BoardChanges {
        upsert_nodes: vec![BoardNode {
            id: node_id.clone(),
            kind: "executor".into(),
            x: ceo_node.x + 1000.0,
            y,
            width: None,
            height: None,
            data: json!({ "name": title, "model": model, "branch": row.branch, "worktree": row.worktree }),
            z: 0,
        }],
        upsert_edges: vec![BoardEdge {
            id: uuid(),
            source: ceo.node_id.clone(),
            target: node_id.clone(),
            data: json!({ "kind": "spawn" }),
        }],
        ..Default::default()
    };
    if let Err(e) = store.save_board(&ceo.project_id, &changes) {
        let _ = s.remove(&store, &row);
        return Err(e);
    }
    emit_board(app, &ceo.project_id, &changes);
    report(app, &ceo.project_id, &node_id, "working", "Starting");
    Ok(format!(
        "{}\nThe executor reports back through your inbox.",
        json!({ "node": node_id, "branch": row.branch, "worktree": row.worktree })
    ))
}

/// Ends an executor after its turn (bounded) when `wait`: tmux session, worktree and node go, a branch with commits stays.
pub fn retire<R: Runtime>(app: &AppHandle<R>, exec: AgentSession, wait: bool, why: &str) {
    let (app, why) = (app.clone(), why.to_string());
    std::thread::spawn(move || {
        let store = app.state::<Store>();
        let deadline = Instant::now() + Duration::from_secs(if wait { 60 } else { 0 });
        while Instant::now() < deadline
            && store
                .session(&exec.id)
                .ok()
                .flatten()
                .is_some_and(|r| r.status == "working")
        {
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Err(e) = app.state::<Sessions>().remove(&store, &exec) {
            println!("bus: {e}");
        }
        // Nobody can accept them now; closed, they leave the board and the CEO's inbox.
        for m in store
            .close_messages(&exec.project_id, &exec.node_id)
            .unwrap_or_default()
        {
            emit(&app, &m);
        }
        let changes = BoardChanges {
            delete_node_ids: vec![exec.node_id.clone()],
            ..Default::default()
        };
        if let Err(e) = store.save_board(&exec.project_id, &changes) {
            println!("bus: {e}");
        }
        emit_board(&app, &exec.project_id, &changes);
        report(&app, &exec.project_id, &exec.node_id, "done", &why);
    });
}
