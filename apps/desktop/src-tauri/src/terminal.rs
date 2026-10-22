//! Login shells and tmux clients on PTYs, streamed to the webview as raw bytes over a `Channel`.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime, State};

type Res<T> = Result<T, String>;

struct Session {
    master: Box<dyn MasterPty + Send>,
    // Own lock, so a write blocked on a full PTY does not stall the other terminals.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

pub struct Terminals {
    shell: String,
    next: AtomicU32,
    // Bumped by close_all: a PTY asked for by a page that has since reloaded is not kept.
    page: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

impl Terminals {
    pub fn new(shell: String) -> Self {
        Self {
            shell,
            next: AtomicU32::new(1),
            page: AtomicU32::new(0),
            sessions: Mutex::default(),
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn take(&self, id: u32) -> Res<Session> {
        self.sessions()
            .remove(&id)
            .ok_or_else(|| format!("no terminal {id}"))
    }

    pub fn close_all(&self) {
        let all: Vec<_> = {
            let mut sessions = self.sessions();
            self.page.fetch_add(1, Ordering::Relaxed);
            sessions.drain().map(|(_, s)| s).collect()
        };
        all.into_iter().for_each(kill);
    }
}

fn kill(mut s: Session) {
    // portable-pty sends SIGHUP, then SIGKILL if the shell ignores it.
    let _ = s.child.kill();
    let _ = s.child.wait();
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

// Batches reads that arrive within a few ms so floods like `yes` become a few large IPC messages.
fn pump(mut reader: Box<dyn Read + Send>, out: Channel<InvokeResponseBody>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        while let Ok(mut chunk) = rx.recv() {
            while chunk.len() < 256 * 1024 {
                match rx.recv_timeout(Duration::from_millis(4)) {
                    Ok(more) => chunk.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if out.send(InvokeResponseBody::Raw(chunk)).is_err() {
                return;
            }
        }
        // An empty chunk tells the view the shell has exited.
        let _ = out.send(InvokeResponseBody::Raw(Vec::new()));
    });
}

/// A login shell in `cwd`, or with `tmux` set, a client attached to that agent session (the session outlives the PTY).
#[tauri::command(async)]
pub fn terminal_open<R: Runtime>(
    app: AppHandle<R>,
    t: State<Terminals>,
    cwd: String,
    cols: u16,
    rows: u16,
    tmux: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> Res<u32> {
    let page = t.page.load(Ordering::Relaxed);
    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;
    let mut cmd = match &tmux {
        Some(name) => {
            let sessions = app
                .try_state::<crate::sessions::Sessions>()
                .ok_or("agent sessions are not running")?;
            let argv = sessions.attach_argv(name)?;
            let mut cmd = CommandBuilder::from_argv(argv.into_iter().map(Into::into).collect());
            // An app started from inside tmux would otherwise refuse to nest the client.
            cmd.env_remove("TMUX");
            cmd
        }
        None => {
            let mut cmd = CommandBuilder::new(&t.shell);
            cmd.arg("-l");
            cmd
        }
    };
    // The shell keeps PWD as given (symlinks unresolved) when it names the same folder as cwd.
    cmd.env("PWD", &cwd);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Apps started from Finder get no locale, which breaks UTF-8 in the shell.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    pump(reader, on_output);
    let id = t.next.fetch_add(1, Ordering::Relaxed);
    let session = Session {
        master: pair.master,
        writer: Arc::new(Mutex::new(writer)),
        child,
    };
    let mut sessions = t.sessions();
    if t.page.load(Ordering::Relaxed) != page {
        drop(sessions);
        kill(session);
        return Err("the page reloaded".into());
    }
    sessions.insert(id, session);
    Ok(id)
}

#[tauri::command(async)]
pub fn terminal_write(t: State<Terminals>, id: u32, data: String) -> Res<()> {
    let writer = t
        .sessions()
        .get(&id)
        .map(|s| s.writer.clone())
        .ok_or_else(|| format!("no terminal {id}"))?;
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn terminal_resize(t: State<Terminals>, id: u32, cols: u16, rows: u16) -> Res<()> {
    let sessions = t.sessions();
    let s = sessions
        .get(&id)
        .ok_or_else(|| format!("no terminal {id}"))?;
    s.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn terminal_close(t: State<Terminals>, id: u32) -> Res<()> {
    kill(t.take(id)?);
    Ok(())
}

#[cfg(test)]
mod ipc_tests;
