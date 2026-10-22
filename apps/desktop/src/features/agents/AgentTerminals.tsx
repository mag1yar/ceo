import {
  type Node,
  useReactFlow,
  useStore,
  useStoreApi,
  type Viewport,
} from "@xyflow/react"
import { useEffect, useSyncExternalStore } from "react"
import { useCommand } from "@/features/commands/registry"
import { useProjects } from "@/features/projects/projects"
import { syncTerminals } from "@/features/terminal/terminals"
import { isAgent } from "./agent"
import { agentOrder } from "./team"

// Room left around the focused node, clear of the board's top and bottom panels.
const MARGIN = { x: 16, top: 56, bottom: 64 }

// The focused node's size: in memory only, never saved and never an undo step.
type Focus = { id: string; size: { width: number; height: number } }
let focus: Focus | undefined
const listeners = new Set<() => void>()
let controller:
  | { go: (id: string | undefined) => void; step: (by: number) => void }
  | undefined

function setFocus(next: Focus | undefined) {
  focus = next
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useFocus = (id: string) =>
  useSyncExternalStore(subscribe, () => (focus?.id === id ? focus : undefined))

export const focusedId = () => focus?.id

export const useFocusedId = () =>
  useSyncExternalStore(subscribe, () => focus?.id)

// The header button and double click: focus this agent, or leave focus if it already has it.
export function toggleFocus(id: string) {
  controller?.go(focus?.id === id ? undefined : id)
}

const exitFocus = () => controller?.go(undefined)
const nextAgent = () => controller?.step(1)
const previousAgent = () => controller?.step(-1)

const agentIds = (s: { nodes: Node[] }) =>
  s.nodes
    .filter(isAgent)
    .map((n) => n.id)
    .join(" ")

// Mounted inside <ReactFlow>: one shell per agent node, and the focus mode that zooms into one.
export function AgentTerminals({ projectId }: { projectId: string }) {
  const ids = useStore(agentIds)
  const flow = useStoreApi()
  const { projects } = useProjects()
  const cwd = projects?.find((p) => p.id === projectId)?.path
  useEffect(() => {
    // Read the store now, not the render: on mount it renders empty until React Flow copies the nodes in.
    const now = agentIds(flow.getState())
    if (cwd && now === ids)
      syncTerminals(projectId, cwd, ids ? ids.split(" ") : [])
  }, [projectId, cwd, ids, flow])
  useFocusMode()
  const focused = useFocusedId() !== undefined
  useCommand("focus.exit", focused ? exitFocus : undefined)
  useCommand("focus.next", focused ? nextAgent : undefined)
  useCommand("focus.previous", focused ? previousAgent : undefined)
  return null
}

function useFocusMode() {
  const rf = useReactFlow()
  const flow = useStoreApi()
  useEffect(() => {
    let back: Viewport | undefined
    // Linear, so moving to the next agent never zooms out on the way; eased out like the node's resize.
    const motion = () => ({
      duration: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : 300,
      interpolate: "linear" as const,
      ease: (t: number) => 1 - (1 - t) ** 3,
    })
    const element = (id: string) =>
      flow
        .getState()
        .domNode?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${CSS.escape(id)}"]`
        )

    // The node fills the board, also after the window or the sidebar resizes.
    const fill = () => {
      const { width, height } = flow.getState()
      return {
        width: Math.round(width - 2 * MARGIN.x),
        height: Math.round(height - MARGIN.top - MARGIN.bottom),
      }
    }

    function go(id: string | undefined) {
      if (!id) {
        if (!focus) return
        const left = focus.id
        setFocus(undefined)
        if (back) rf.setViewport(back, motion())
        // Keyboard stays on the board, on the node that had focus.
        element(left)?.focus({ preventScroll: true })
        return
      }
      const node = rf.getInternalNode(id)
      if (!node) return
      if (!focus) back = rf.getViewport()
      const { addSelectedNodes } = flow.getState()
      setFocus({ id, size: fill() })
      addSelectedNodes([id])
      const p = node.internals.positionAbsolute
      rf.setViewport(
        { x: MARGIN.x - p.x, y: MARGIN.top - p.y, zoom: 1 },
        motion()
      )
    }
    const unsubscribe = flow.subscribe((s, prev) => {
      if (focus && (s.width !== prev.width || s.height !== prev.height))
        setFocus({ id: focus.id, size: fill() })
    })

    function step(by: number) {
      const order = agentOrder(rf.getNodes().filter(isAgent))
      const i = order.findIndex((n) => n.id === focus?.id)
      const next = order[(i + by + order.length) % order.length]
      if (next) go(next.id)
    }

    controller = { go, step }
    function onPointerDown(e: PointerEvent) {
      if (focus && !element(focus.id)?.contains(e.target as Element))
        go(undefined)
    }
    // A press on the node's frame keeps the keyboard in the shell, or plain Esc reaches React Flow and unselects the node.
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Element
      if (
        focus &&
        element(focus.id)?.contains(t) &&
        !t.closest("[data-slot=node-terminal]")
      )
        e.preventDefault()
    }
    const dom = flow.getState().domNode
    dom?.addEventListener("pointerdown", onPointerDown, true)
    dom?.addEventListener("mousedown", onMouseDown, true)
    return () => {
      controller = undefined
      unsubscribe()
      dom?.removeEventListener("pointerdown", onPointerDown, true)
      dom?.removeEventListener("mousedown", onMouseDown, true)
      setFocus(undefined)
    }
  }, [rf, flow])
}
