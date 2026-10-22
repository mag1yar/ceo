//! Hidden test build (`--features e2e`): embedded WebDriver on localhost, no Dock icon, no focus.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow};
use objc2_foundation::{NSPoint, NSString};
use tauri::{ActivationPolicy, App, AppHandle, Builder, Manager, Runtime, plugin};

pub fn builder<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    // tao applies the policy only after launch; set Accessory (1) now so LaunchServices never sees a Dock app.
    unsafe {
        use objc2::{
            class, msg_send,
            runtime::{AnyObject, Bool},
        };
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: Bool = msg_send![ns_app, setActivationPolicy: 1isize];
    }
    builder
        .activate_ignoring_other_apps(false)
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(
            plugin::Builder::<R>::new("ceo-e2e")
                // Runs before app code on every load; sessionStorage keeps violations across reloads for wdio's afterEach.
                .js_init_script(CSP_RECORDER)
                .on_webview_ready(|webview| {
                    // The window starts hidden and is shown only after the switch, which WebKit reads when it appears.
                    let window = webview.window();
                    let _ = webview.with_webview(move |wv| {
                        keep_painting(wv.inner());
                        let _ = window.show();
                    });
                })
                .build(),
        )
}

// Also opens window.e2e, where terminals register as they open, before any spec code can run.
const CSP_RECORDER: &str = r#"window.e2e = { terminals: {} };
document.addEventListener("securitypolicyviolation", (e) => {
  const seen = JSON.parse(sessionStorage.getItem("ceo-e2e-csp") ?? "[]");
  seen.push(`${e.effectiveDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`);
  sessionStorage.setItem("ceo-e2e-csp", JSON.stringify(seen));
});"#;

pub fn setup<R: Runtime>(app: &mut App<R>) {
    app.set_activation_policy(ActivationPolicy::Accessory);
}

// WebKit treats an off-screen window as hidden (no rAF, frozen transitions); this private switch keeps it visible.
fn keep_painting(wk_webview: *mut std::ffi::c_void) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};
    let Some(view) = (unsafe { (wk_webview as *mut AnyObject).as_ref() }) else {
        return;
    };
    let sel = sel!(_setWindowOcclusionDetectionEnabled:);
    let supported: bool = unsafe { msg_send![view, respondsToSelector: sel] };
    if supported {
        let _: () = unsafe { msg_send![view, _setWindowOcclusionDetectionEnabled: Bool::NO] };
    }
}

#[derive(serde::Serialize)]
pub struct MenuEntry {
    menu: String,
    title: String,
    key: String,
    cmd: bool,
    shift: bool,
    enabled: bool,
}

// Sync commands run on the main thread, where AppKit lives.
fn main_thread() -> MainThreadMarker {
    MainThreadMarker::new().expect("sync commands run on the main thread")
}

/// The native menu bar as AppKit holds it: every item with its key equivalent.
#[tauri::command]
pub fn e2e_menu() -> Vec<MenuEntry> {
    let Some(bar) = NSApplication::sharedApplication(main_thread()).mainMenu() else {
        return vec![];
    };
    let mut out = vec![];
    for top in bar.itemArray().iter() {
        let Some(menu) = top.submenu() else { continue };
        for item in menu.itemArray().iter() {
            let flags = item.keyEquivalentModifierMask();
            out.push(MenuEntry {
                menu: menu.title().to_string(),
                title: item.title().to_string(),
                key: item.keyEquivalent().to_string(),
                cmd: flags.contains(NSEventModifierFlags::Command),
                shift: flags.contains(NSEventModifierFlags::Shift),
                enabled: item.isEnabled(),
            });
        }
    }
    out
}

/// Runs a menu item's action the way a click does, without touching the screen.
#[tauri::command]
pub fn e2e_menu_click(menu: String, item: String) -> Result<(), String> {
    let bar = NSApplication::sharedApplication(main_thread())
        .mainMenu()
        .ok_or("no menu bar")?;
    let sub = bar
        .itemArray()
        .iter()
        .filter_map(|i| i.submenu())
        .find(|m| m.title().to_string() == menu)
        .ok_or_else(|| format!("no menu {menu}"))?;
    let index = sub
        .itemArray()
        .iter()
        .position(|i| i.title().to_string() == item)
        .ok_or_else(|| format!("no item {item} in {menu}"))?;
    sub.performActionForItemAtIndex(index as isize);
    Ok(())
}

/// A Cmd key press dispatched in-process as AppKit does for a key window (views, then menu bar), which the never-active hidden window cannot be.
#[tauri::command]
pub fn e2e_key<R: Runtime>(
    app: AppHandle<R>,
    chars: String,
    key_code: u16,
    shift: bool,
) -> Result<String, String> {
    let mtm = main_thread();
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let ns_window = window.ns_window().map_err(|e| e.to_string())?;
    // SAFETY: Tauri hands out the live NSWindow of the main webview window.
    let ns_window: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
    let mut flags = NSEventModifierFlags::Command;
    if shift {
        flags |= NSEventModifierFlags::Shift;
    }
    let text = NSString::from_str(&chars);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown,
        NSPoint::new(0.0, 0.0),
        flags,
        0.0,
        ns_window.windowNumber(),
        None,
        &text,
        &text,
        false,
        key_code,
    )
    .ok_or("could not build the key event")?;
    let responder = ns_window
        .firstResponder()
        .map(|r| format!("{:?}", r.class().name()))
        .unwrap_or_default();
    let window_took = ns_window.performKeyEquivalent(&event);
    let menu_took = !window_took
        && NSApplication::sharedApplication(mtm)
            .mainMenu()
            .is_some_and(|m| m.performKeyEquivalent(&event));
    Ok(format!(
        "first responder {responder}, window took it: {window_took}, menu took it directly: {menu_took}"
    ))
}
