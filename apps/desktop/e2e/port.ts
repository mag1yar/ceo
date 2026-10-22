// shortcut: two worktrees collide 1 time in 500; --strictPort then fails loudly, set E2E_PORT / TAURI_WEBDRIVER_PORT by hand.
export function worktreePort(base: number) {
  let hash = 0
  for (const c of import.meta.dirname)
    hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return base + (hash % 500)
}
