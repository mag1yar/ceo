//! Claude Code hooks posted to a loopback listener, mapped to the node status.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

/// Every hook, so the status follows the whole turn; SessionStart takes only command hooks, so it posts through curl.
pub fn settings(url: &str, token: &str) -> Value {
    let auth = format!("Bearer {token}");
    let http = json!([{ "hooks": [{
        "type": "http", "url": url, "headers": { "Authorization": auth }, "timeout": 5
    }] }]);
    let curl = format!(
        "curl -s -m 5 -X POST -H 'Authorization: {auth}' -H 'Content-Type: application/json' --data-binary @- {url}"
    );
    let mut hooks = serde_json::Map::new();
    hooks.insert(
        "SessionStart".into(),
        json!([{ "hooks": [{ "type": "command", "command": curl, "timeout": 5 }] }]),
    );
    for event in [
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "Stop",
        "StopFailure",
        "Notification",
        "SessionEnd",
    ] {
        hooks.insert(event.into(), http.clone());
    }
    json!({
        "permissions": { "deny": [
            "Agent",
            "Workflow",
            "Bash(git push:*)",
            "Bash(git reset --hard:*)",
            "Bash(git branch -D:*)",
            "Bash(git branch --delete --force:*)",
            "Bash(git worktree remove --force:*)",
            "Bash(git worktree remove -f:*)",
            "Bash(git clean:*)",
        ] },
        "hooks": hooks,
    })
}

/// The status and action text a hook event moves the node to; None leaves it as it is.
pub fn status_for(event: &Value) -> Option<(&'static str, String)> {
    let tool = event["tool_name"].as_str().unwrap_or("a tool");
    let text = |key: &str, or: &str| event[key].as_str().unwrap_or(or).to_string();
    Some(match event["hook_event_name"].as_str()? {
        "SessionStart" => ("idle", "Ready".into()),
        "UserPromptSubmit" | "PostToolUse" => ("working", "Thinking".into()),
        "PreToolUse" => ("working", format!("Running {tool}")),
        "PermissionRequest" => ("waiting", format!("Needs permission for {tool}")),
        "Notification" => ("waiting", text("message", "Needs your input")),
        "Stop" => ("idle", "Turn finished".into()),
        "StopFailure" => ("error", text("last_assistant_message", "The turn failed")),
        "SessionEnd" => ("done", "Session ended".into()),
        _ => return None,
    })
}

/// How long `working` may go without a hook before the watchdog looks at the pane.
pub const QUIET: Duration = Duration::from_secs(20);

/// A Stop that never came, as after an Esc interrupt: still `working`, hooks quiet, and the pane shows the prompt, not "esc to interrupt".
pub fn missed_stop(status: &str, quiet: Duration, pane: &str) -> bool {
    status == "working"
        && quiet >= QUIET
        && pane.contains('❯')
        && !pane.contains("esc to interrupt")
}

/// Constant time, so the loopback port cannot be used to guess a token byte by byte.
pub fn token_ok(expected: &str, header: Option<&str>) -> bool {
    let Some(got) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    expected.len() == got.len()
        && !expected.is_empty()
        && expected
            .bytes()
            .zip(got.bytes())
            .fold(0, |a, (x, y)| a | (x ^ y))
            == 0
}

/// `POST /hook/<session id>` with the bearer token; the handler gets id, Authorization header and body, and returns the status code.
pub type Handler = dyn Fn(&str, Option<&str>, &[u8]) -> u16 + Send + Sync;

pub fn serve(listener: TcpListener, handler: Arc<Handler>) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = handler.clone();
            std::thread::spawn(move || respond(stream, &*handler));
        }
    });
}

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 1024 * 1024;

fn respond(stream: TcpStream, handler: &Handler) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let code = read_request(&stream).map_or_else(
        |c| c,
        |(id, auth, body)| handler(&id, auth.as_deref(), &body),
    );
    let reason = match code {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let _ = (&stream).write_all(
        format!("HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .as_bytes(),
    );
}

type Request = (String, Option<String>, Vec<u8>);

fn read_request(stream: &TcpStream) -> Result<Request, u16> {
    let mut r = BufReader::new(stream).take(MAX_HEAD as u64);
    let mut line = String::new();
    r.read_line(&mut line).map_err(|_| 400u16)?;
    let target: Vec<String> = line.split_whitespace().take(2).map(String::from).collect();
    let (mut len, mut auth) = (0usize, None);
    loop {
        line.clear();
        if r.read_line(&mut line).map_err(|_| 400u16)? == 0 {
            return Err(400);
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(400);
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = value.trim().parse().map_err(|_| 400u16)?,
            "authorization" => auth = Some(value.trim().to_string()),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return Err(400);
    }
    // The whole request is read before any answer, so the client never writes into a closed socket.
    let mut r = r.into_inner();
    let mut body = vec![0; len];
    r.read_exact(&mut body).map_err(|_| 400u16)?;
    let id = match target.as_slice() {
        [method, path] if method == "POST" => path.strip_prefix("/hook/"),
        _ => None,
    };
    match id {
        Some(id) if !id.is_empty() && !id.contains('/') => Ok((id.to_string(), auth, body)),
        _ => Err(404),
    }
}
