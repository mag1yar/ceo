#[cfg(feature = "e2e")]
mod e2e;
mod git;
mod sessions;
mod store;
mod terminal;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = e2e::builder(builder);
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::Terminals::new(
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()),
        ))
        // A reload starts a fresh view that knows none of the open shells.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview.state::<terminal::Terminals>().close_all();
            }
        })
        .setup(|app| {
            #[cfg(feature = "e2e")]
            e2e::setup(app);
            store::init(app)?;
            sessions::init(app)
        })
        .invoke_handler(tauri::generate_handler![
            store::project_list,
            store::project_create,
            store::project_update,
            store::project_touch,
            store::project_delete,
            store::project_reorder,
            store::board_load,
            store::board_save,
            git::project_is_git,
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            sessions::session_ensure,
            sessions::session_delete,
            sessions::session_list,
            #[cfg(feature = "e2e")]
            e2e::e2e_menu,
            #[cfg(feature = "e2e")]
            e2e::e2e_menu_click,
            #[cfg(feature = "e2e")]
            e2e::e2e_key,
            #[cfg(feature = "e2e")]
            e2e::e2e_input,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<terminal::Terminals>().close_all();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn e2e_window_matches_main_except_hiding_overrides() {
        // Tauri replaces the whole windows array on merge, so the e2e copy must be kept in sync by hand.
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let e2e: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.e2e.conf.json")).unwrap();
        let mut main = main["app"]["windows"][0].as_object().unwrap().clone();
        let mut e2e = e2e["app"]["windows"][0].as_object().unwrap().clone();
        for key in [
            "x",
            "y",
            "focus",
            "visible",
            "incognito",
            "preventOverflow",
            "decorations",
        ] {
            main.remove(key);
            e2e.remove(key);
        }
        assert_eq!(main, e2e);
    }

    #[test]
    fn main_window_is_ceo_with_min_size() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &conf["app"]["windows"][0];
        assert_eq!(window["title"], "CEO");
        assert_eq!(window["minWidth"], 960);
        assert_eq!(window["minHeight"], 640);
    }
}
