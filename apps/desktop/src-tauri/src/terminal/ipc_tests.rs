use super::*;
use serde_json::{Value, json};
use std::sync::mpsc::Receiver;
use std::time::Instant;
use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::{InvokeRequest, WebviewWindow, WebviewWindowBuilder};

// Channel messages are caught by the interceptor, the same hook the real IPC delivers through.
fn app() -> (WebviewWindow<MockRuntime>, Receiver<Vec<u8>>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let app = mock_builder()
        .manage(Terminals::new("/bin/sh".into()))
        .channel_interceptor(move |_, _, _, body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.lock().unwrap().send(bytes.clone());
            }
            true
        })
        .invoke_handler(tauri::generate_handler![
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (webview, rx)
}

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        w,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|b| b.deserialize().unwrap())
}

// Reads channel output until `needle` shows up, or panics with what arrived.
fn wait_for(rx: &Receiver<Vec<u8>>, seen: &mut String, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !seen.contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(bytes) => seen.push_str(&String::from_utf8_lossy(&bytes)),
            Err(_) => panic!("no {needle:?} in {seen:?}"),
        }
    }
}

#[test]
fn terminal_commands_over_ipc() {
    let (w, rx) = app();
    let dir = tempfile::tempdir().unwrap();
    let id = call(
        &w,
        "terminal_open",
        json!({"cwd": dir.path(), "cols": 80, "rows": 24, "onOutput": "__CHANNEL__:7"}),
    )
    .unwrap();
    let mut seen = String::new();

    call(
        &w,
        "terminal_write",
        json!({"id": id, "data": "echo h''i; pwd\n"}),
    )
    .unwrap();
    wait_for(&rx, &mut seen, "hi\r\n");
    // The shell starts in the project folder.
    wait_for(&rx, &mut seen, dir.path().to_str().unwrap());

    call(
        &w,
        "terminal_resize",
        json!({"id": id, "cols": 97, "rows": 31}),
    )
    .unwrap();
    call(
        &w,
        "terminal_write",
        json!({"id": id, "data": "stty size\n"}),
    )
    .unwrap();
    wait_for(&rx, &mut seen, "31 97");

    call(&w, "terminal_close", json!({"id": id})).unwrap();
    // The pump reports the shell's exit with an empty chunk.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("no exit chunk")
        .is_empty()
    {}

    let err = call(&w, "terminal_close", json!({"id": id})).unwrap_err();
    assert_eq!(err, json!(format!("no terminal {id}")));
    assert!(call(&w, "terminal_write", json!({"id": 999, "data": "x"})).is_err());
    assert!(
        call(
            &w,
            "terminal_resize",
            json!({"id": 999, "cols": 1, "rows": 1})
        )
        .is_err()
    );
}

#[test]
fn close_all_kills_every_shell() {
    let (w, _rx) = app();
    for _ in 0..2 {
        call(
            &w,
            "terminal_open",
            json!({"cwd": "/", "cols": 80, "rows": 24, "onOutput": "__CHANNEL__:7"}),
        )
        .unwrap();
    }
    let t = w.state::<Terminals>();
    let pids: Vec<u32> = t
        .sessions()
        .values()
        .filter_map(|s| s.child.process_id())
        .collect();
    assert_eq!(pids.len(), 2);
    t.close_all();
    assert!(t.sessions().is_empty());
    for pid in pids {
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!alive, "shell {pid} survived close_all");
    }
}
