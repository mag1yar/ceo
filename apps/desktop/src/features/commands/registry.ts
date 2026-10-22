import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowsInIcon,
  CornersOutIcon,
  FlowArrowIcon,
  FolderPlusIcon,
  type Icon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassPlusIcon,
  NoteIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react"
import { useEffect, useSyncExternalStore } from "react"

// Letters and digits match the physical key (`code`), so shortcuts work on non-Latin layouts; `key` is for a character like "?".
export type Shortcut = {
  code?: string
  key?: string
  meta?: boolean
  shift?: boolean
}

export type Command = {
  id: string
  title: string
  /** The help dialog section and the app menu the command sits in. */
  group: "Project" | "View" | "Board" | "Help"
  icon: Icon
  shortcuts?: Shortcut[]
  /** Fires while typing too: focus mode keys work inside the focused terminal. */
  anywhere?: boolean
  /** Holding the keys repeats the command. */
  repeats?: boolean
  /** Left out of the app menu: Edit > Undo and Redo own Cmd+Z there, so text fields keep their own undo. */
  menu?: false
}

const cmd = (code: string, shift = false): Shortcut => ({
  code,
  meta: true,
  shift,
})

export const COMMANDS: Command[] = [
  {
    id: "project.add",
    title: "Add project…",
    group: "Project",
    icon: FolderPlusIcon,
  },
  {
    id: "palette",
    title: "Command palette",
    group: "View",
    icon: MagnifyingGlassIcon,
    shortcuts: [cmd("KeyK")],
  },
  {
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    group: "View",
    icon: SidebarSimpleIcon,
    shortcuts: [cmd("KeyB")],
  },
  {
    id: "board.fit",
    title: "Fit board",
    group: "View",
    icon: CornersOutIcon,
    shortcuts: [{ code: "Digit1", shift: true }],
  },
  {
    id: "board.zoom100",
    title: "Zoom to 100%",
    group: "View",
    icon: MagnifyingGlassPlusIcon,
    shortcuts: [cmd("Digit0")],
  },
  {
    id: "focus.exit",
    title: "Exit terminal focus",
    group: "View",
    icon: ArrowsInIcon,
    shortcuts: [cmd("Escape")],
    anywhere: true,
    repeats: true,
  },
  {
    id: "focus.next",
    title: "Next agent",
    group: "View",
    icon: ArrowRightIcon,
    shortcuts: [cmd("BracketRight", true)],
    anywhere: true,
    repeats: true,
  },
  {
    id: "focus.previous",
    title: "Previous agent",
    group: "View",
    icon: ArrowLeftIcon,
    shortcuts: [cmd("BracketLeft", true)],
    anywhere: true,
    repeats: true,
  },
  {
    id: "note.new",
    title: "New note",
    group: "Board",
    icon: NoteIcon,
    shortcuts: [{ code: "KeyN" }],
  },
  {
    id: "diagram.new",
    title: "New diagram",
    group: "Board",
    icon: FlowArrowIcon,
  },
  {
    id: "board.undo",
    title: "Undo",
    group: "Board",
    icon: ArrowCounterClockwiseIcon,
    shortcuts: [cmd("KeyZ")],
    repeats: true,
    menu: false,
  },
  {
    id: "board.redo",
    title: "Redo",
    group: "Board",
    icon: ArrowClockwiseIcon,
    shortcuts: [cmd("KeyZ", true)],
    repeats: true,
    menu: false,
  },
  {
    id: "help",
    title: "Keyboard shortcuts",
    group: "Help",
    icon: KeyboardIcon,
    shortcuts: [cmd("Slash"), { key: "?" }],
  },
]

export const GROUPS = ["Project", "View", "Board", "Help"] as const

export function matches(s: Shortcut, e: KeyboardEvent) {
  if (e.ctrlKey || e.altKey || !!s.meta !== e.metaKey) return false
  // A character already carries its Shift.
  if (s.key) return e.key === s.key
  return e.code === s.code && !!s.shift === e.shiftKey
}

const KEY_LABELS: Record<string, string> = {
  Escape: "Esc",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
}

/** Keycaps for a shortcut, for example ["⌘", "⇧", "]"]. */
export function keys(s: Shortcut) {
  const key =
    s.key ?? KEY_LABELS[s.code ?? ""] ?? s.code?.replace(/^(Key|Digit)/, "")
  return [s.meta && "⌘", s.shift && "⇧", key].filter(Boolean) as string[]
}

/** Tauri accelerator, only for Cmd shortcuts: a bare key in the menu would fire while typing. */
export function accelerator(s: Shortcut | undefined) {
  if (!s?.meta || !s.code) return undefined
  return ["Cmd", s.shift && "Shift", s.code].filter(Boolean).join("+")
}

export const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.matches("input, textarea, select"))

// Menus own their typeahead, and an open dialog owns the keyboard even before its focus lands.
const inOverlay = (t: EventTarget | null) =>
  (t instanceof Element && !!t.closest("[role=menu]")) ||
  !!document.querySelector(
    "[role=dialog][data-open], [role=alertdialog][data-open]"
  )

// Run functions bound by the components that own the state; a command without one is unavailable.
const handlers = new Map<string, () => void>()
const listeners = new Set<() => void>()
let available: Command[] = []

function changed() {
  available = COMMANDS.filter((c) => handlers.has(c.id))
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Binds the run function of command `id` while mounted; `undefined` makes it unavailable. */
export function useCommand(id: string, run: (() => void) | undefined) {
  useEffect(() => {
    if (!run) return
    handlers.set(id, run)
    changed()
    return () => {
      if (handlers.get(id) === run) handlers.delete(id)
      changed()
    }
  }, [id, run])
}

export const useAvailableCommands = () =>
  useSyncExternalStore(subscribe, () => available)

export const runCommand = (id: string) => handlers.get(id)?.()

// When the page last saw each command's keys, handled or not.
const seen = new Map<string, number>()

export function onKeyDown(e: KeyboardEvent) {
  const command = COMMANDS.find((c) => c.shortcuts?.some((s) => matches(s, e)))
  if (!command) return
  seen.set(command.id, performance.now())
  const run = handlers.get(command.id)
  if (!run || (e.repeat && !command.repeats)) return
  if (!command.anywhere && (isTyping(e.target) || inOverlay(e.target))) return
  e.preventDefault()
  // Capture phase: the focused terminal never sees the focus mode keys.
  if (command.anywhere) e.stopPropagation()
  run()
}

// WebKit hands the menu every Cmd key the page left uncancelled (measured in #10), so a fresh keydown means the page already decided.
export function runFromMenu(id: string) {
  // The hidden app's specs read which menu actions arrived.
  ;(window as { e2e?: { menu?: string[] } }).e2e?.menu?.push(id)
  if (performance.now() - (seen.get(id) ?? Number.NEGATIVE_INFINITY) < 500)
    return
  runCommand(id)
}
