//! One git worktree per session; removal never forces, so git keeps any work it would lose.

use std::path::Path;
use std::process::Command;

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The commit HEAD points at, or None for a folder that is not a git checkout (or has no commit yet).
pub fn head(repo: &str) -> Option<String> {
    git(repo, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).ok()
}

/// Where `dir` sits inside its checkout, like `apps/web/`; empty at the root.
pub fn prefix(dir: &str) -> String {
    git(dir, &["rev-parse", "--show-prefix"]).unwrap_or_default()
}

pub fn add(repo: &str, path: &str, branch: &str, base: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    git(repo, &["worktree", "add", "-b", branch, path, base]).map(drop)
}

/// Removes the worktree, then the branch; an error names what git refused and left on disk.
pub fn remove(repo: &str, path: &str, branch: &str) -> Result<(), String> {
    if Path::new(path).exists() {
        git(repo, &["worktree", "remove", path])
            .map_err(|e| format!("kept worktree {path} and branch {branch}: {e}"))?;
    } else {
        // Deleted by hand: drop git's stale record so the branch is no longer checked out.
        git(repo, &["worktree", "prune"])?;
    }
    git(repo, &["branch", "-d", branch])
        .map(drop)
        .map_err(|e| format!("kept branch {branch}: {e}"))
}
