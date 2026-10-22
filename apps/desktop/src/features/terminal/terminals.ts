import { Channel, invoke } from "@tauri-apps/api/core"
import { FitAddon } from "@xterm/addon-fit"
import { type ITheme, Terminal } from "@xterm/xterm"
import { useCallback, useSyncExternalStore } from "react"
import type { AgentSession } from "@/lib/store"

export type Session = {
  projectId: string
  term: Terminal
  fit: FitAddon
  close: () => void
}

// One shell per agent node, keyed by node id: it outlives the node's mount and the board's.
const sessions = new Map<string, Session>()
const watchers = new Map<string, Set<() => void>>()

const notify = (id: string) => {
  for (const cb of watchers.get(id) ?? []) cb()
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const s of sessions.values()) s.term.options.theme = theme()
})

const token = (name: string) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(`--terminal-${name}`)
    .trim()

export function theme(): ITheme {
  return {
    background: token("background"),
    foreground: token("foreground"),
    cursor: token("cursor"),
    cursorAccent: token("background"),
    selectionBackground: token("selection"),
  }
}

type Hook = { e2e?: { terminals?: Record<string, Terminal> } }

function open(id: string, projectId: string, cwd: string): Session {
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim(),
    fontSize: 12,
    lineHeight: 1.2,
    cols: 80,
    rows: 12,
    // Overview is read-only; focus mode turns input on.
    disableStdin: true,
    cursorBlink: true,
    // Lifts ANSI colours that would vanish on the light background.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    scrollback: 5000,
    theme: theme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  let live = true

  const output = new Channel<ArrayBuffer>((bytes) => {
    // Output still in flight when the session closed.
    if (!live) return
    if (bytes.byteLength) term.write(new Uint8Array(bytes))
    else term.write("\r\n\x1b[2m[process exited]\x1b[0m")
  })
  // A CEO node attaches to its claude session in tmux; other nodes get a login shell.
  let queue: Promise<number | undefined> = invoke<AgentSession | null>(
    "session_ensure",
    { projectId, nodeId: id, cols: term.cols, rows: term.rows }
  )
    .then((session) =>
      invoke<number>("terminal_open", {
        cwd,
        cols: term.cols,
        rows: term.rows,
        tmux: session?.tmuxName ?? null,
        onOutput: output,
      })
    )
    .catch((e) => {
      term.write(`\x1b[31m${e}\x1b[0m\r\n`)
      return undefined
    })
  // One chain keeps writes and resizes in order: async commands may otherwise overtake each other.
  const send = (cmd: string, args: object) => {
    queue = queue.then(async (pty) => {
      if (pty !== undefined)
        await invoke(cmd, { id: pty, ...args }).catch(console.error)
      return pty
    })
  }
  term.onData((data) => send("terminal_write", { data }))
  term.onResize(({ cols, rows }) => send("terminal_resize", { cols, rows }))

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.metaKey) return true
    if (e.key === "k") {
      term.clear()
      return false
    }
    if (e.key === "c" && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(console.error)
      return false
    }
    return true
  })

  // Specs read the buffer through window.e2e: the terminal has no stable DOM text.
  const e2e = (window as Hook).e2e
  if (e2e) e2e.terminals = { ...e2e.terminals, [id]: term }

  return {
    projectId,
    term,
    fit,
    close: () => {
      live = false
      send("terminal_close", {})
      // The node is gone, so its session, worktree and branch go too (git keeps unsaved work).
      // Also when session_ensure failed half way: Rust ignores nodes without a session.
      queue = queue.then(async (pty) => {
        await invoke("session_delete", { projectId, nodeId: id }).catch(
          console.error
        )
        return pty
      })
      term.dispose()
      delete (window as Hook).e2e?.terminals?.[id]
    },
  }
}

function close(id: string) {
  sessions.get(id)?.close()
  sessions.delete(id)
  notify(id)
}

// Opens a shell for every agent node of the project that lacks one and closes those whose node is gone.
export function syncTerminals(projectId: string, cwd: string, ids: string[]) {
  const keep = new Set(ids)
  for (const [id, s] of sessions)
    if (s.projectId === projectId && !keep.has(id)) close(id)
  for (const id of ids)
    if (!sessions.has(id)) {
      sessions.set(id, open(id, projectId, cwd))
      notify(id)
    }
}

// A project removed from the list takes its shells with it.
export function pruneTerminals(projectIds: string[]) {
  const keep = new Set(projectIds)
  for (const [id, s] of sessions) if (!keep.has(s.projectId)) close(id)
}

export const getSession = (id: string) => sessions.get(id)

export function useSession(id: string) {
  const subscribe = useCallback(
    (cb: () => void) => {
      const set = watchers.get(id) ?? new Set()
      watchers.set(id, set.add(cb))
      return () => {
        set.delete(cb)
        if (!set.size) watchers.delete(id)
      }
    },
    [id]
  )
  return useSyncExternalStore(subscribe, () => sessions.get(id))
}
