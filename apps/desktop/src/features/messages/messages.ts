// Contract for the agent bus (#19): the Rust side emits the Tauri event `bus://message`
// with the whole Message as its payload on every state change (sent -> waiting -> accepted).
// `from` and `to` are agent node ids on the project's board; times are ms since the epoch.
// `message_list` returns what is still on the board after an app restart.
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { useEffect, useSyncExternalStore } from "react"

export const BUS_EVENT = "bus://message"

export type MessageKind = "report" | "ask" | "reply" | "send"
export type MessageState = "sent" | "waiting" | "accepted"

export type Message = {
  id: string
  projectId: string
  from: string
  to: string
  thread: string
  kind: MessageKind
  state: MessageState
  sentAt: number
  waitingAt?: number
  acceptedAt?: number
  body?: string
  deliveredVia?: "typed" | "post_tool_use" | "stop" | null
}

// `live` is what the board draws; `asking` holds senders still waiting for a reply to an ask.
export type Messages = { live: Message[]; asking: string[] }

// An accepted message stays this long so its signal can play the absorb, then it goes.
export const LEAVE_MS = 400

const RANK: Record<MessageState, number> = { sent: 0, waiting: 1, accepted: 2 }
const KINDS: MessageKind[] = ["report", "ask", "reply", "send"]
const EMPTY: Messages = { live: [], asking: [] }

type Project = {
  live: Map<string, Message>
  // ask id -> the ask, until a reply in its thread is accepted
  asks: Map<string, Message>
  // shortcut: accepted ids are kept for the session to drop late duplicates; prune once #19 persists messages.
  done: Set<string>
  snapshot: Messages
}

const projects = new Map<string, Project>()
const listeners = new Set<() => void>()
let listening = false

function project(id: string) {
  let p = projects.get(id)
  if (!p) {
    p = { live: new Map(), asks: new Map(), done: new Set(), snapshot: EMPTY }
    projects.set(id, p)
  }
  return p
}

function publish(p: Project) {
  p.snapshot = {
    live: [...p.live.values()],
    asking: [...new Set([...p.asks.values()].map((a) => a.from))],
  }
  for (const fn of listeners) fn()
}

const isMessage = (m: Partial<Message>): m is Message =>
  ["id", "projectId", "from", "to", "thread"].every(
    (k) => typeof m[k as keyof Message] === "string"
  ) &&
  KINDS.includes(m.kind as MessageKind) &&
  Object.hasOwn(RANK, m.state as string) &&
  typeof m.sentAt === "number"

// Ignores malformed payloads and anything that would move a message back a state.
export function receive(m: Partial<Message>) {
  if (!isMessage(m)) return console.warn("bus: bad message", m)
  const p = project(m.projectId)
  const old = p.live.get(m.id)
  if (p.done.has(m.id) || (old && RANK[old.state] >= RANK[m.state])) return
  p.live.set(m.id, m)
  if (m.kind === "ask" && !old) p.asks.set(m.id, m)
  if (m.state === "accepted") {
    p.done.add(m.id)
    if (m.kind === "reply")
      for (const [id, a] of p.asks) if (a.thread === m.thread) p.asks.delete(id)
    setTimeout(() => {
      p.live.delete(m.id)
      publish(p)
    }, LEAVE_MS)
  }
  publish(p)
}

function subscribe(fn: () => void) {
  if (!listening) {
    listening = true
    listen<Message>(BUS_EVENT, (e) => receive(e.payload)).catch((e) => {
      listening = false
      console.error("bus listen failed", e)
    })
  }
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export const messagesOf = (projectId: string) =>
  projects.get(projectId)?.snapshot ?? EMPTY

const fetched = new Set<string>()

// Once per project; events that came first stay, since receive never moves a message back.
function load(projectId: string) {
  if (fetched.has(projectId)) return
  fetched.add(projectId)
  invoke<Message[]>("message_list", { projectId })
    .then((list) => {
      for (const m of list) receive(m)
    })
    .catch((e) => {
      fetched.delete(projectId)
      console.error("message list failed", e)
    })
}

export function useMessages(projectId: string) {
  useEffect(() => load(projectId), [projectId])
  return useSyncExternalStore(subscribe, () => messagesOf(projectId))
}
