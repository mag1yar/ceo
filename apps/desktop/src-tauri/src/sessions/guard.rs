//! PreToolUse guard for Bash: finds every git and gh invocation in a command, through wrappers, shells and substitutions.

/// Why the command is refused, or None to let it run.
pub fn deny(command: &str) -> Option<String> {
    commands(command, 0).into_iter().find_map(|c| check(&c))
}

const WRAPPERS: &[&str] = &[
    "env", "sudo", "command", "exec", "nohup", "time", "nice", "xargs", "timeout", "builtin",
];
const KEYWORDS: &[&str] = &[
    "!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for",
];
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish"];

/// Simple commands as word lists; shell `-c` strings, `eval` and `$(...)` or backtick bodies are split too.
fn commands(src: &str, depth: u8) -> Vec<Vec<String>> {
    if depth > 4 {
        return vec![];
    }
    let mut out = vec![];
    // Substitutions run even inside double quotes; scanning the raw text over-matches only inside single quotes, which errs toward deny.
    for inner in substitutions(src) {
        out.extend(commands(&inner, depth + 1));
    }
    for words in split(src) {
        let mut i = 0;
        // Leading assignments, keywords and wrappers with their flags and numbers.
        while let Some(w) = words.get(i) {
            let name = base(w);
            if KEYWORDS.contains(&w.as_str()) || is_assignment(w) {
                i += 1;
            } else if WRAPPERS.contains(&name) {
                // Wrapper options may take values (`sudo -u me`), so jump to a git, gh or shell further on.
                let inner = words[i + 1..].iter().position(|w| {
                    let n = base(w);
                    n == "git" || n == "gh" || n == "eval" || SHELLS.contains(&n)
                });
                i += 1;
                match inner {
                    Some(at) => i += at,
                    None => {
                        while words.get(i).is_some_and(|w| {
                            w.starts_with('-') || is_assignment(w) || w.parse::<f64>().is_ok()
                        }) {
                            i += 1;
                        }
                    }
                }
            } else {
                break;
            }
        }
        let rest = &words[i.min(words.len())..];
        let Some(first) = rest.first() else { continue };
        let name = base(first);
        if SHELLS.contains(&name) {
            // `sh -c 'cmd'`, also combined flags like `-lc`.
            if let Some(at) = rest
                .iter()
                .position(|w| w.starts_with('-') && !w.starts_with("--") && w.contains('c'))
                && let Some(script) = rest.get(at + 1)
            {
                out.extend(commands(script, depth + 1));
            }
        } else if name == "eval" {
            out.extend(commands(&rest[1..].join(" "), depth + 1));
        }
        // `... | xargs git`: the subcommand comes from stdin, so it counts as computed.
        if rest.len() == 1 && words[..i].iter().any(|w| base(w) == "xargs") {
            out.push(vec![first.clone(), "$(xargs)".into()]);
        }
        out.push(rest.to_vec());
    }
    out
}

fn check(words: &[String]) -> Option<String> {
    let name = base(words.first()?);
    if name == "gh" {
        return Some("gh is not allowed in agent sessions: the owner publishes".into());
    }
    if name != "git" {
        return None;
    }
    // Global options before the subcommand; some take a value.
    let mut i = 1;
    while let Some(w) = words.get(i) {
        match w.as_str() {
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" | "--exec-path"
            | "--config-env" => {
                if w == "-c" && words.get(i + 1).is_some_and(|v| v.starts_with("alias.")) {
                    return Some("git aliases set on the command line are not allowed".into());
                }
                i += 2;
            }
            w if w.starts_with('-') => i += 1,
            _ => break,
        }
    }
    let sub = words.get(i)?.as_str();
    // Known only when the shell runs it: `git $p`, `git $(echo push)`.
    if sub.contains('$') {
        return Some("git with a computed subcommand is not allowed".into());
    }
    let args = &words[i + 1..];
    let has = |f: &str| args.iter().any(|a| a == f);
    // Short flags may be combined, like `-fd`.
    let short = |c: char| {
        args.iter()
            .any(|a| a.starts_with('-') && !a.starts_with("--") && a.contains(c))
    };
    let why = match sub {
        "push" => "git push is not allowed: the owner pushes",
        "reset" if has("--hard") => "git reset --hard is not allowed: it drops work",
        "branch"
            if short('D')
                || ((has("--delete") || short('d')) && (has("--force") || short('f'))) =>
        {
            "force-deleting a branch is not allowed"
        }
        "worktree"
            if args.first().is_some_and(|a| a == "remove") && (has("--force") || short('f')) =>
        {
            "git worktree remove --force is not allowed"
        }
        "clean" => "git clean is not allowed: it deletes untracked work",
        _ => return None,
    };
    Some(why.into())
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn is_assignment(w: &str) -> bool {
    w.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// Bodies of `$(...)` and backticks, nesting included.
fn substitutions(src: &str) -> Vec<String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' && chars.get(i + 1) == Some(&'(') {
            let (mut depth, start) = (1, i + 2);
            let mut j = start;
            while j < chars.len() && depth > 0 {
                match chars[j] {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            out.push(
                chars[start..j.saturating_sub(1).max(start)]
                    .iter()
                    .collect(),
            );
            i = start;
        } else if chars[i] == '`' {
            let end = chars[i + 1..]
                .iter()
                .position(|&c| c == '`')
                .map(|p| i + 1 + p);
            let end = end.unwrap_or(chars.len());
            out.push(chars[i + 1..end].iter().collect());
            i = end + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Words of each simple command, with quotes and backslashes resolved, split at `; & | && || ( )` and newlines.
fn split(src: &str) -> Vec<Vec<String>> {
    let mut cmds = vec![];
    let (mut words, mut word, mut in_word) = (vec![], String::new(), false);
    let mut it = src.chars().peekable();
    let end_word = |words: &mut Vec<String>, word: &mut String, in_word: &mut bool| {
        if *in_word {
            words.push(std::mem::take(word));
            *in_word = false;
        }
    };
    while let Some(c) = it.next() {
        match c {
            '\'' => {
                in_word = true;
                for c in it.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                in_word = true;
                while let Some(c) = it.next() {
                    match c {
                        '"' => break,
                        '\\' => {
                            if let Some(n) = it.next() {
                                word.push(n);
                            }
                        }
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                in_word = true;
                if let Some(n) = it.next()
                    && n != '\n'
                {
                    word.push(n);
                }
            }
            ';' | '&' | '|' | '(' | ')' | '\n' | '`' => {
                end_word(&mut words, &mut word, &mut in_word);
                if !words.is_empty() {
                    cmds.push(std::mem::take(&mut words));
                }
            }
            c if c.is_whitespace() => end_word(&mut words, &mut word, &mut in_word),
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    end_word(&mut words, &mut word, &mut in_word);
    if !words.is_empty() {
        cmds.push(words);
    }
    cmds
}
