//! `ceo mcp-shim`: an MCP server on stdio for one claude session; every tool list and call is relayed to the app's bus.

use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

/// Entry point of the shim mode; the bus URL and the session token come in the environment.
pub fn run() {
    let url = std::env::var("CEO_BUS_URL").unwrap_or_default();
    let token = std::env::var("CEO_BUS_TOKEN").unwrap_or_default();
    serve(
        std::io::stdin().lock(),
        Arc::new(Mutex::new(std::io::stdout())),
        &url,
        &token,
    );
}

/// Newline-delimited JSON-RPC until stdin closes; tool calls run on their own thread, so a blocking `ask` never holds up the rest.
pub fn serve<W: Write + Send + 'static>(
    input: impl BufRead,
    out: Arc<Mutex<W>>,
    url: &str,
    token: &str,
) {
    let mut calls = vec![];
    for line in input.lines() {
        calls.retain(|c: &std::thread::JoinHandle<()>| !c.is_finished());
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // Notifications (initialized, cancelled) carry no id and get no answer.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        let answer = match msg["method"].as_str().unwrap_or("") {
            "initialize" => Ok(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "ceo", "version": env!("CARGO_PKG_VERSION") },
            })),
            "ping" => Ok(json!({})),
            "tools/list" => {
                post(&format!("{url}/tools"), token, &json!({})).map_err(|e| (-32603, e))
            }
            "tools/call" => {
                let (out, url, token) = (out.clone(), format!("{url}/call"), token.to_string());
                calls.push(std::thread::spawn(move || {
                    let result = post(&url, &token, &params).unwrap_or_else(
                        |e| json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                    );
                    write(
                        &out,
                        json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    );
                }));
                continue;
            }
            _ => Err((-32601, "Method not found".to_string())),
        };
        write(
            &out,
            match answer {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                }
            },
        );
    }
    for c in calls {
        let _ = c.join();
    }
}

fn write<W: Write>(out: &Mutex<W>, msg: Value) {
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

/// One POST per call: a fresh connection each time, so the shim keeps working across an app restart on the same port.
fn post(url: &str, token: &str, body: &Value) -> Result<Value, String> {
    let rest = url.strip_prefix("http://").ok_or("bad CEO_BUS_URL")?;
    let (host, path) = rest.split_once('/').ok_or("bad CEO_BUS_URL")?;
    let mut s = TcpStream::connect(host)
        .map_err(|e| format!("the CEO app is not reachable ({e}); try again once it runs"))?;
    let body = body.to_string();
    write!(
        s,
        "POST /{path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut resp = String::new();
    s.read_to_string(&mut resp).map_err(|e| e.to_string())?;
    let (head, body) = resp
        .split_once("\r\n\r\n")
        .ok_or("bad answer from the bus")?;
    match head.split_whitespace().nth(1) {
        Some("200") => serde_json::from_str(body).map_err(|e| e.to_string()),
        code => Err(format!(
            "the bus refused the call ({})",
            code.unwrap_or("?")
        )),
    }
}
