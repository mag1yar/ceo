import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useCallback, useSyncExternalStore } from "react"
import type { AgentSession } from "@/lib/store"

export const STATUSES = ["idle", "working", "waiting", "error", "done"] as const
export type Status = (typeof STATUSES)[number]
export type Live = { status: Status; action: string }

// Two of each status, handed out round-robin, so any team of five or more shows all of them.
const POOL: Live[] = [
  { status: "working", action: "Running the gate" },
  { status: "waiting", action: "Asks the Lead about scope" },
  { status: "idle", action: "No task yet" },
  { status: "done", action: "Merged into the Lead branch" },
  { status: "error", action: "Clippy failed in store.rs" },
  { status: "working", action: "Editing Board.tsx" },
  { status: "waiting", action: "Needs your approval to merge" },
  { status: "idle", action: "Waiting for the next wave" },
  { status: "done", action: "Report sent to the CEO" },
  { status: "error", action: "Tests failed: 2 of 48" },
]

const TICK_MS = 3000

// Mock source, in memory and keyed by node id, so ticks never touch the board or its saves.
const live = new Map<string, Live>()
// Nodes backed by a claude session: status from its hooks, never from the mock pool.
const real = new Map<string, Live>()
const watchers = new Map<string, Set<() => void>>()
let handed = 0
let timer: number | undefined
let started = false

type Change = { nodeId: string; status: Status; action: string }

function setReal({ nodeId, status, action }: Change) {
  real.set(nodeId, { status, action })
  for (const cb of watchers.get(nodeId) ?? []) cb()
}

// Lazily, on the first mounted node: events first, so the initial list never overwrites a newer change.
function start() {
  started = true
  listen<Change>("session-status", (e) => setReal(e.payload)).catch(
    console.error
  )
  invoke<AgentSession[]>("session_list")
    .then((list) => {
      for (const s of list)
        if (!real.has(s.nodeId)) setReal({ ...s, status: s.status as Status })
    })
    .catch(console.error)
}

function get(id: string) {
  const session = real.get(id)
  if (session) return session
  let entry = live.get(id)
  if (!entry) {
    entry = POOL[handed++ % POOL.length]
    live.set(id, entry)
  }
  return entry
}

// Swaps two watched agents' states: statuses keep changing while the mix stays whole.
function tick() {
  const ids = [...watchers.keys()].filter((id) => !real.has(id))
  if (ids.length < 2) return
  const a = ids[Math.floor(Math.random() * ids.length)]
  const others = ids.filter((id) => get(id).status !== get(a).status)
  const b = others[Math.floor(Math.random() * others.length)]
  if (!b) return
  const swap = get(a)
  live.set(a, get(b))
  live.set(b, swap)
  for (const id of [a, b]) for (const cb of watchers.get(id) ?? []) cb()
}

function watch(id: string, cb: () => void) {
  if (!started) start()
  const set = watchers.get(id) ?? new Set()
  watchers.set(id, set.add(cb))
  timer ??= window.setInterval(tick, TICK_MS)
  return () => {
    set.delete(cb)
    if (!set.size) watchers.delete(id)
    if (!watchers.size) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export function useLive(id: string) {
  const subscribe = useCallback((cb: () => void) => watch(id, cb), [id])
  return useSyncExternalStore(subscribe, () => get(id))
}

export const STATUS_LABEL: Record<Status, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
  error: "Error",
  done: "Done",
}
