#[cfg(feature = "e2e")]
mod e2e;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = e2e::builder(builder);
    builder
        .setup(|app| {
            #[cfg(feature = "e2e")]
            e2e::setup(app);
            store::init(app)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
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
