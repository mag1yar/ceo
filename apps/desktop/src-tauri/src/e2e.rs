//! Hidden test build (`--features e2e`): embedded WebDriver on localhost, no Dock icon, no focus.

use tauri::{ActivationPolicy, App, Builder, Runtime, plugin};

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
    println!("e2e: _setWindowOcclusionDetectionEnabled supported={supported}");
    if supported {
        let _: () = unsafe { msg_send![view, _setWindowOcclusionDetectionEnabled: Bool::NO] };
    }
}
