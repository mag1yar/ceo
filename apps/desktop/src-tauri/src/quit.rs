//! Holds the app's exit until the board has written its pending batch.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering::SeqCst};
use std::time::Duration;
use tauri::{AppHandle, Emitter, RunEvent, WindowEvent};

// A hung or reloading webview never answers; quit anyway after this.
const BOUND: Duration = Duration::from_millis(1500);

static APP: OnceLock<AppHandle> = OnceLock::new();
static ASKED: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
static CODE: AtomicI32 = AtomicI32::new(0);

pub fn on_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::Ready => {
            let _ = APP.set(app.clone());
            #[cfg(target_os = "macos")]
            hook_terminate();
        }
        // Closing the only window quits, but by ExitRequested its webview is gone; quit while it is alive.
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            app.exit(0);
        }
        RunEvent::ExitRequested { code, api, .. } => {
            // Our own exit after the flush passes through.
            if DONE.load(SeqCst) {
                return;
            }
            api.prevent_exit();
            if ASKED.swap(true, SeqCst) {
                return;
            }
            CODE.store(code.unwrap_or(0), SeqCst);
            if app.emit("app://flush", ()).is_err() {
                return finish(app);
            }
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(BOUND);
                finish(&app);
            });
        }
        _ => {}
    }
}

fn finish(app: &AppHandle) {
    if !DONE.swap(true, SeqCst) {
        app.exit(CODE.load(SeqCst));
    }
}

/// The webview's answer to `app://flush`: its pending batch is saved.
#[tauri::command]
pub fn app_flush_done(app: AppHandle) {
    finish(&app);
}

// The Quit item (Cmd+Q, Dock, logout) sends terminate:, which tao lets through with no ExitRequested; turn it into one.
#[cfg(target_os = "macos")]
fn hook_terminate() {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, ffi, msg_send, sel};

    extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
        const NOW: usize = 1;
        const CANCEL: usize = 0;
        match APP.get() {
            Some(app) if !DONE.load(SeqCst) => {
                app.exit(0);
                CANCEL
            }
            _ => NOW,
        }
    }

    // SAFETY: runs on the main thread after launch; the IMP matches applicationShouldTerminate:'s signature "Q@:@".
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        if delegate.is_null() {
            return;
        }
        let cls = ffi::object_getClass(delegate) as *mut AnyClass;
        let imp: Imp = std::mem::transmute(
            should_terminate as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
        );
        let sel = sel!(applicationShouldTerminate:);
        // Fails only if tao starts implementing it; quit.ts's Cmd+Q case then catches the lost batch.
        if !ffi::class_addMethod(cls, sel, imp, c"Q@:@".as_ptr()).as_bool() {
            eprintln!(
                "quit: applicationShouldTerminate: already defined, Cmd+Q skips the board flush"
            );
        }
    }
}
