// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // claude starts this binary as the session's MCP server; that mode never starts Tauri.
    if std::env::args().nth(1).as_deref() == Some("mcp-shim") {
        return ceo_lib::mcp_shim();
    }
    ceo_lib::run();
}
