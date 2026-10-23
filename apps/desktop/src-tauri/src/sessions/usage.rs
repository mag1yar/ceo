//! Token use from Claude Code's JSONL transcript, read from where the last read stopped.

use super::{Res, memory};
use crate::store::{AgentSession, Store, Usage};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Where a transcript was read up to, and what the next turn is compared with.
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct Cursor {
    pub offset: u64,
    /// One response spans several lines with the same message id and usage; it counts once.
    pub last_id: Option<String>,
    /// Milliseconds of the last assistant turn.
    pub last_at: Option<i64>,
    /// The TTL the last cache write used.
    pub ttl_1h: bool,
}

#[derive(Default, Debug, PartialEq)]
pub struct Delta {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_1h: i64,
    pub cache_5m: i64,
    pub first_prompt: Option<i64>,
    pub misses: Vec<Value>,
    pub compactions: i64,
    pub context: Option<i64>,
}

/// `YYYY-MM-DDTHH:MM:SS(.mmm)Z` as Unix milliseconds.
pub fn millis(ts: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let secs = n(11..13)? * 3600 + n(14..16)? * 60 + n(17..19)?;
    let ms = match ts.get(19..20) {
        Some(".") => format!("{:0<3}", ts[20..].trim_end_matches('Z'))
            .get(..3)?
            .parse()
            .ok()?,
        _ => 0,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + secs) * 1000 + ms)
}

fn gap_label(ms: i64) -> String {
    let m = ms / 60_000;
    if m >= 60 {
        format!("{}h{}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

/// Reads the complete lines of `chunk` (the transcript from `cur.offset` on) and moves the cursor past them.
pub fn parse(chunk: &[u8], cur: &mut Cursor) -> Delta {
    let mut d = Delta::default();
    // A line still being written stays for the next read.
    let end = chunk.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    for line in chunk[..end].split(|&b| b == b'\n') {
        let Ok(e) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if e["type"] == "system" && e["subtype"] == "compact_boundary" {
            d.compactions += 1;
            continue;
        }
        let u = &e["message"]["usage"];
        if e["type"] != "assistant" || !u.is_object() {
            continue;
        }
        let id = e["message"]["id"].as_str().map(str::to_string);
        if id.is_some() && id == cur.last_id {
            continue;
        }
        let n = |v: &Value| v.as_i64().unwrap_or(0);
        let (input, read) = (n(&u["input_tokens"]), n(&u["cache_read_input_tokens"]));
        let write = n(&u["cache_creation_input_tokens"]);
        let (w1h, w5m) = match &u["cache_creation"] {
            c if c.is_object() => (
                n(&c["ephemeral_1h_input_tokens"]),
                n(&c["ephemeral_5m_input_tokens"]),
            ),
            _ => (0, write),
        };
        let prompt = input + read + write;
        let at = e["timestamp"].as_str().and_then(millis);
        match (cur.last_at, at) {
            (None, _) => {
                d.first_prompt = d.first_prompt.or(Some(prompt));
            }
            (Some(prev), Some(at)) => {
                let ttl = if cur.ttl_1h { 3_600_000 } else { 300_000 };
                // Near zero: under a tenth of the prompt came from the cache.
                if at - prev > ttl && read * 10 < prompt {
                    d.misses.push(json!({
                        "gap": gap_label(at - prev),
                        "ttl": if cur.ttl_1h { "1h" } else { "5m" },
                        "tokens": prompt,
                    }));
                }
            }
            _ => {}
        }
        if w1h > 0 {
            cur.ttl_1h = true;
        } else if w5m > 0 {
            cur.ttl_1h = false;
        }
        d.input += input;
        d.output += n(&u["output_tokens"]);
        d.cache_read += read;
        d.cache_1h += w1h;
        d.cache_5m += w5m;
        d.context = Some(prompt);
        cur.last_id = id;
        cur.last_at = at.or(cur.last_at);
    }
    cur.offset += end as u64;
    d
}

// Stop and a wave reset can read the same transcript at once.
static READING: Mutex<()> = Mutex::new(());

/// Adds the lines the transcript gained since the last read to the session's totals.
pub fn record<R: Runtime>(app: &AppHandle<R>, row: &AgentSession, path: &str) -> Res<Usage> {
    let _one = READING.lock().unwrap_or_else(|e| e.into_inner());
    let store = app.state::<Store>();
    let mut cur: Cursor = store
        .transcript_cursor(path)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut f = std::fs::File::open(path).map_err(|e| format!("{path}: {e}"))?;
    // A shorter file was rewritten, not appended to: skip what it holds, its tokens were counted already.
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < cur.offset {
        cur = Cursor {
            offset: len,
            ..Cursor::default()
        };
    }
    let mut chunk = vec![];
    f.seek(SeekFrom::Start(cur.offset))
        .and_then(|_| f.read_to_end(&mut chunk))
        .map_err(|e| e.to_string())?;
    let d = parse(&chunk, &mut cur);
    let task = store
        .load_board(&row.project_id)?
        .nodes
        .into_iter()
        .find(|n| n.id == row.node_id)
        .and_then(|n| n.data["name"].as_str().map(str::to_string))
        .unwrap_or_default();
    let base = Usage {
        session_id: row.id.clone(),
        project_id: row.project_id.clone(),
        node_id: row.node_id.clone(),
        role: row.role.clone(),
        task,
        ..Default::default()
    };
    let cursor = serde_json::to_string(&cur).map_err(|e| e.to_string())?;
    store.usage_add(
        base,
        |u| {
            u.input += d.input;
            u.output += d.output;
            u.cache_read += d.cache_read;
            u.cache_write_1h += d.cache_1h;
            u.cache_write_5m += d.cache_5m;
            u.first_prompt = u.first_prompt.or(d.first_prompt);
            u.idle_misses.extend(d.misses);
            u.compactions += d.compactions;
            u.context = d.context.or(u.context);
        },
        path,
        &cursor,
    )
}

/// On Stop and SessionEnd: the turn's tokens, and for the CEO a commit of whatever it changed in its memory.
pub fn after_turn<R: Runtime>(app: &AppHandle<R>, row: &AgentSession, event: &Value) {
    if let Some(path) = event["transcript_path"].as_str()
        && let Err(e) = record(app, row, path)
    {
        println!("usage: {e}");
    }
    // Off the hook's thread, so a slow or locked git never holds up Claude Code's Stop.
    if row.role == "ceo" && event["hook_event_name"] == "Stop" {
        let dir = memory::dir(app, &row.project_id);
        std::thread::spawn(move || {
            if let Err(e) = memory::commit(&dir) {
                println!("memory: {e}");
            }
        });
    }
}

/// The CEO's context size right before a wave reset, read fresh from its transcript.
pub fn wave_mark<R: Runtime>(app: &AppHandle<R>, row: &AgentSession) {
    let store = app.state::<Store>();
    let Ok(Some(u)) = store.usage(&row.id) else {
        return;
    };
    let u = u
        .transcript
        .as_deref()
        .and_then(|p| record(app, row, p).ok())
        .unwrap_or(u);
    if let Some(c) = u.context {
        let _ = store.usage_wave_context(&row.id, c);
    }
}
