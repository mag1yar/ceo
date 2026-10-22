//! tmux on the app's own socket (`-L`); every target is an exact `=name`, so a prefix never hits another session.

use std::process::{Command, Output};

/// tmux ends a command at an argument ending in `;` and drops the `;`; a trailing `\;` stays a literal `;`.
fn literal(arg: &str) -> String {
    match arg.strip_suffix(';') {
        Some(head) => format!("{head}\\;"),
        None => arg.into(),
    }
}

pub struct Tmux {
    pub bin: String,
    pub socket: String,
}

impl Tmux {
    fn run(&self, args: &[&str]) -> Result<Output, String> {
        Command::new(&self.bin)
            .arg("-L")
            .arg(&self.socket)
            .args(args)
            .output()
            .map_err(|e| format!("{}: {e}", self.bin))
    }

    fn ok(&self, args: &[&str]) -> Result<String, String> {
        let out = self.run(args)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    pub fn has(&self, name: &str) -> bool {
        self.ok(&["has-session", "-t", &format!("={name}")]).is_ok()
    }

    /// Session names on our socket; none when no server runs.
    pub fn list(&self) -> Vec<String> {
        self.ok(&["list-sessions", "-F", "#{session_name}"])
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    pub fn kill(&self, name: &str) -> Result<(), String> {
        self.ok(&["kill-session", "-t", &format!("={name}")])
            .map(drop)
    }

    pub fn capture(&self, name: &str) -> String {
        self.ok(&["capture-pane", "-p", "-t", &format!("={name}:")])
            .unwrap_or_default()
    }

    /// With colours and attributes as escape sequences, so dim placeholder text tells from typed text.
    pub fn capture_styled(&self, name: &str) -> String {
        self.ok(&["capture-pane", "-e", "-p", "-t", &format!("={name}:")])
            .unwrap_or_default()
    }

    /// Literal text into the pane, as if typed; no key names are interpreted.
    pub fn type_text(&self, name: &str, text: &str) -> Result<(), String> {
        self.ok(&["send-keys", "-t", &format!("={name}:"), "-l", text])
            .map(drop)
    }

    /// One named key, like `Enter` or `Escape`.
    pub fn key(&self, name: &str, key: &str) -> Result<(), String> {
        self.ok(&["send-keys", "-t", &format!("={name}:"), key])
            .map(drop)
    }

    /// Detached session running `cmd` directly (no shell), with the status bar off and detach-on-destroy on.
    pub fn start(
        &self,
        name: &str,
        cwd: &str,
        size: (u16, u16),
        env: &[(&str, &str)],
        cmd: &[&str],
    ) -> Result<(), String> {
        let (cols, rows) = (size.0.to_string(), size.1.to_string());
        let target = format!("={name}:");
        let env: Vec<String> = env
            .iter()
            .map(|(k, v)| literal(&format!("{k}={v}")))
            .collect();
        let cwd = literal(cwd);
        let cmd: Vec<String> = cmd.iter().map(|a| literal(a)).collect();
        let mut args = vec![
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            &cols,
            "-y",
            &rows,
            "-c",
            &cwd,
        ];
        for e in &env {
            args.extend(["-e", e]);
        }
        args.extend(cmd.iter().map(String::as_str));
        args.extend([";", "set-option", "-t", &target, "detach-on-destroy", "on"]);
        args.extend([";", "set-option", "-t", &target, "status", "off"]);
        self.ok(&args).map(drop)
    }

    /// argv for a PTY client: UTF-8 forced and 24-bit colour passed through to xterm.js.
    pub fn attach_argv(&self, name: &str) -> Vec<String> {
        [
            &self.bin,
            "-L",
            &self.socket,
            "-u",
            "-T",
            "RGB",
            "attach-session",
            "-t",
        ]
        .map(String::from)
        .into_iter()
        .chain([format!("={name}")])
        .collect()
    }
}
