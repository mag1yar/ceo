import { Channel, invoke } from "@tauri-apps/api/core"
import { FitAddon } from "@xterm/addon-fit"
import { type ITheme, Terminal } from "@xterm/xterm"
import { useSyncExternalStore } from "react"
import { useProjects } from "@/features/projects/projects"

export type Tab = {
  key: number
  projectId: string
  title: string
  term: Terminal
  fit: FitAddon
  exited: boolean
}

type State = {
  tabs: Tab[]
  // Selected tab per project.
  active: Record<string, number>
  shown: boolean
}

let state: State = { tabs: [], active: {}, shown: true }
const listeners = new Set<() => void>()
let seq = 0
// Closes the PTY behind each tab, through that tab's ordered command chain.
const ptys = new Map<number, () => void>()
// Where focus goes back to when the dock hides.
let returnTo: Element | null = null

function set(next: Partial<State>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  for (const t of state.tabs) t.term.options.theme = theme()
})

export function useTerminals() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state
  )
}

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

function rememberFocus() {
  const el = document.activeElement
  if (!el?.closest("[data-slot=terminal-dock], [role=menu]")) returnTo = el
}

export function openTerminal(projectId: string, cwd: string, title: string) {
  const key = ++seq
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement)
      .getPropertyValue("--font-mono")
      .trim(),
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    // Lifts ANSI colours that would vanish on the light background.
    minimumContrastRatio: 4.5,
    macOptionIsMeta: true,
    scrollback: 5000,
    theme: theme(),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const tab: Tab = { key, projectId, title, term, fit, exited: false }

  const output = new Channel<ArrayBuffer>((bytes) => {
    // Output still in flight when the tab closed.
    if (!ptys.has(key)) return
    if (bytes.byteLength) term.write(new Uint8Array(bytes))
    else markExited(key)
  })
  let queue: Promise<number | undefined> = invoke<number>("terminal_open", {
    cwd,
    cols: term.cols,
    rows: term.rows,
    onOutput: output,
  }).catch((e) => {
    term.write(`\x1b[31m${e}\x1b[0m\r\n`)
    markExited(key)
    return undefined
  })
  // One chain keeps writes and resizes in order: async commands may otherwise overtake each other.
  const send = (cmd: string, args: object) => {
    queue = queue.then(async (id) => {
      if (id !== undefined)
        await invoke(cmd, { id, ...args }).catch(console.error)
      return id
    })
  }
  term.onData((data) => send("terminal_write", { data }))
  term.onResize(({ cols, rows }) => send("terminal_resize", { cols, rows }))
  ptys.set(key, () => send("terminal_close", {}))

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true
    if (e.ctrlKey && e.code === "Backquote") return false
    if (!e.metaKey) return true
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

  // Specs set window.e2e to read the buffer of a canvas-rendered terminal.
  const e2e = (window as { e2e?: { terminals?: Record<number, Terminal> } }).e2e
  if (e2e) e2e.terminals = { ...e2e.terminals, [key]: term }

  rememberFocus()
  set({
    tabs: [...state.tabs, tab],
    active: { ...state.active, [projectId]: key },
    shown: true,
  })
  focusSoon(tab)
}

function markExited(key: number) {
  set({
    tabs: state.tabs.map((t) => (t.key === key ? { ...t, exited: true } : t)),
  })
}

export function selectTerminal(key: number) {
  const tab = state.tabs.find((t) => t.key === key)
  if (!tab) return
  if (!state.shown) rememberFocus()
  set({ active: { ...state.active, [tab.projectId]: key }, shown: true })
  focusSoon(tab)
}

export function closeTerminal(key: number) {
  const tab = state.tabs.find((t) => t.key === key)
  if (!tab) return
  ptys.get(key)?.()
  ptys.delete(key)
  const wasActive = state.active[tab.projectId] === key
  const siblings = state.tabs.filter((t) => t.projectId === tab.projectId)
  const i = siblings.indexOf(tab)
  const next = siblings[i + 1] ?? siblings[i - 1]
  const active = { ...state.active }
  if (wasActive && next) active[tab.projectId] = next.key
  else if (!next) delete active[tab.projectId]
  set({ tabs: state.tabs.filter((t) => t !== tab), active })
  tab.term.dispose()
  if (!next) restoreFocus()
  else if (wasActive) focusSoon(next)
}

export function setShown(projectId: string, shown: boolean) {
  if (shown === state.shown) return
  if (shown) rememberFocus()
  else restoreFocus()
  set({ shown })
  const tab = state.tabs.find((t) => t.key === state.active[projectId])
  if (shown && tab) focusSoon(tab)
}

// Store updates render synchronously before the next frame, so the view is visible by then.
function focusSoon(tab: Tab) {
  requestAnimationFrame(() => tab.term.focus())
}

function restoreFocus() {
  const el = document.activeElement
  if (!el?.closest("[data-slot=terminal-dock]")) return
  if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus()
  else (el as HTMLElement).blur()
}

// Opens a shell in the active project's folder, titled after the agent it came from.
export function useOpenTerminal() {
  const { projects, activeId } = useProjects()
  const project = projects?.find((p) => p.id === activeId)
  return project
    ? (title: string) => openTerminal(project.id, project.path, title)
    : undefined
}
