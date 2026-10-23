import {
  type Connection,
  type Edge,
  type InternalNode,
  type Node,
  Position,
  type XYPosition,
} from "@xyflow/react"
import { ROLE_LABEL, ROLES, type Role } from "@/features/agents/agent"
import type { BoardEdge, BoardNode } from "@/lib/store"

// `kind` tells plain links from later edge kinds; old links may still carry handle ids, which nothing reads now that ends float.
export type LinkData = {
  kind: "link"
  label?: string
  sourceHandle?: string | null
  targetHandle?: string | null
}
export type LinkEdge = Edge<LinkData, "link">

export function newLink(c: Connection): Edge {
  return toEdge({
    id: crypto.randomUUID(),
    source: c.source,
    target: c.target,
    data: { kind: "link" },
  })
}

export function toEdge(e: BoardEdge): Edge {
  const data = (e.data ?? { kind: "link" }) as LinkData
  return {
    id: e.id,
    // Only user links get the arrow and label; other kinds (agent hierarchy) are plain lines.
    type: data.kind === "link" ? "link" : "plain",
    source: e.source,
    target: e.target,
    ariaLabel: data.kind === "link" ? linkLabel(data.label) : "Team line",
    // Ends float, so stored handle ids (old `in`/`out` too) stay in data and React Flow takes any handle.
    data,
  }
}

export const linkLabel = (label?: string) => (label ? `Link: ${label}` : "Link")

// What VoiceOver calls the focused node; React Flow's default is no name at all.
export function nodeLabel(type: string, data: Record<string, unknown>) {
  if (ROLES.includes(type as Role))
    return `${data.name}, ${ROLE_LABEL[type as Role]}`
  if (type === "card") return String(data.title ?? "Card")
  return { note: "Note", diagram: "Diagram" }[type] ?? type
}

export function toNode(n: BoardNode): Node {
  const data = (n.data ?? {}) as Record<string, unknown>
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data,
    ariaLabel: nodeLabel(n.type, data),
    zIndex: n.z,
    ...(n.width != null && { width: n.width }),
    ...(n.height != null && { height: n.height }),
  }
}

export const toBoardEdge = (e: Edge): BoardEdge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  data: e.data,
})

export const sameEdge = (a: BoardEdge | undefined, b: BoardEdge) =>
  !!a && a.source === b.source && a.target === b.target && a.data === b.data

type Box = XYPosition & { width: number; height: number }

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

// Where the line from the box centre toward `to` leaves the outline, and through which side.
export function outlinePoint(b: Box, to: XYPosition) {
  const c = centre(b)
  const dx = to.x - c.x
  const dy = to.y - c.y
  const sx = Math.abs(dx) / (b.width / 2)
  const sy = Math.abs(dy) / (b.height / 2)
  const m = Math.max(sx, sy)
  const t = m ? 1 / m : 0
  const position =
    sx >= sy
      ? dx < 0
        ? Position.Left
        : Position.Right
      : dy < 0
        ? Position.Top
        : Position.Bottom
  return { x: c.x + dx * t, y: c.y + dy * t, position }
}

const boxOf = (n: InternalNode): Box | null =>
  n.measured.width && n.measured.height
    ? {
        ...n.internals.positionAbsolute,
        width: n.measured.width,
        height: n.measured.height,
      }
    : null

// Floating ends on the centre-to-centre line, in the shape getBezierPath takes; null until both are measured.
export function floatingEnds(source: InternalNode, target: InternalNode) {
  const a = boxOf(source)
  const b = boxOf(target)
  if (!a || !b) return null
  const s = outlinePoint(a, centre(b))
  const t = outlinePoint(b, centre(a))
  return {
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: s.position,
    targetX: t.x,
    targetY: t.y,
    targetPosition: t.position,
  }
}
