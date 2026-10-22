use super::*;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::webview::{InvokeRequest, WebviewWindow, WebviewWindowBuilder};

fn app() -> (tempfile::TempDir, WebviewWindow<MockRuntime>) {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(Store::open(&dir.path().join("ipc.db")).unwrap())
        .invoke_handler(tauri::generate_handler![
            project_list,
            project_create,
            project_update,
            project_touch,
            project_delete,
            project_reorder,
            board_load,
            board_save,
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, webview)
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

#[test]
fn project_commands_over_ipc() {
    let (_d, w) = app();
    let a = call(&w, "project_create", json!({"name": "a", "path": "/tmp/a"})).unwrap();
    let b = call(&w, "project_create", json!({"name": "b", "path": "/tmp/b"})).unwrap();
    assert_eq!(
        (&a["position"], &a["lastOpenedAt"]),
        (&json!(0), &Value::Null)
    );

    let u = call(
        &w,
        "project_update",
        json!({"id": a["id"], "name": "a2", "path": "/tmp/a2"}),
    )
    .unwrap();
    assert_eq!((&u["name"], &u["path"]), (&json!("a2"), &json!("/tmp/a2")));
    let t = call(&w, "project_touch", json!({"id": a["id"]})).unwrap();
    assert!(t["lastOpenedAt"].is_i64());

    call(&w, "project_reorder", json!({"ids": [b["id"], a["id"]]})).unwrap();
    let ids: Vec<_> = call(&w, "project_list", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].clone())
        .collect();
    assert_eq!(ids, [b["id"].clone(), a["id"].clone()]);

    call(&w, "project_delete", json!({"id": b["id"]})).unwrap();
    assert_eq!(
        call(&w, "project_list", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        call(
            &w,
            "project_update",
            json!({"id": b["id"], "name": "x", "path": "/x"})
        )
        .is_err()
    );
}

#[test]
fn board_commands_over_ipc() {
    let (_d, w) = app();
    let p = call(&w, "project_create", json!({"name": "p", "path": "/tmp/p"})).unwrap();
    let node = json!({"id": "n1", "type": "note", "x": 1.5, "y": 2.0, "width": null, "height": null, "data": {"t": 1}, "z": 0});
    call(
        &w,
        "board_save",
        json!({"projectId": p["id"], "changes": {"viewport": {"zoom": 2}, "upsertNodes": [node]}}),
    )
    .unwrap();
    let board = call(&w, "board_load", json!({"projectId": p["id"]})).unwrap();
    assert_eq!(
        board,
        json!({"viewport": {"zoom": 2}, "nodes": [node], "edges": []})
    );

    let bad = json!({"projectId": p["id"], "changes": {"upsertNodes": [{"id": "n2", "type": "", "x": 0, "y": 0, "width": null, "height": null, "data": {}, "z": 1}]}});
    assert!(call(&w, "board_save", bad).unwrap_err().is_string());
    assert!(
        call(&w, "board_load", json!({})).is_err(),
        "missing projectId is rejected"
    );
}
