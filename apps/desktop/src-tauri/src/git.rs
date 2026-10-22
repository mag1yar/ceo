use std::path::Path;

/// Inside a git checkout (`.git` is a file in linked worktrees); async so a stalled volume never blocks the main thread.
#[tauri::command]
pub async fn project_is_git(path: String) -> bool {
    Path::new(&path)
        .ancestors()
        .any(|dir| dir.join(".git").exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::{InvokeRequest, WebviewWindowBuilder};

    #[test]
    fn project_is_git_over_ipc() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![project_is_git])
            .build(mock_context(noop_assets()))
            .unwrap();
        let w = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let is_git = |path: &Path| -> Value {
            get_ipc_response(
                &w,
                InvokeRequest {
                    cmd: "project_is_git".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::Json(json!({ "path": path })),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
            .unwrap()
            .deserialize()
            .unwrap()
        };

        let dir = tempfile::tempdir().unwrap();
        let (repo, worktree, plain) = (
            dir.path().join("repo"),
            dir.path().join("wt"),
            dir.path().join("plain"),
        );
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../repo/.git").unwrap();
        std::fs::create_dir_all(&plain).unwrap();

        assert_eq!(is_git(&repo), json!(true));
        assert_eq!(is_git(&worktree), json!(true));
        assert_eq!(is_git(&repo.join("apps/web")), json!(true), "subfolder");
        assert_eq!(is_git(&plain), json!(false));
        assert_eq!(is_git(&dir.path().join("missing")), json!(false));
    }
}
