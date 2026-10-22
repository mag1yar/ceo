import type { Connection, Edge } from "@xyflow/react"
import type { BoardEdge } from "@/lib/store"

// `kind` tells plain links from later edge kinds; handles live in data because BoardEdge has no columns for them.
export type LinkData = {
  kind: "link"
  label?: string
  sourceHandle?: string | null
  targetHandle?: string | null
}
export type LinkEdge = Edge<LinkData, "link">

export function newLink(c: Connection): LinkEdge {
  return toEdge({
    id: crypto.randomUUID(),
    source: c.source,
    target: c.target,
    data: {
      kind: "link",
      sourceHandle: c.sourceHandle,
      targetHandle: c.targetHandle,
    },
  })
}

export function toEdge(e: BoardEdge): LinkEdge {
  const data = (e.data ?? { kind: "link" }) as LinkData
  return {
    id: e.id,
    type: "link",
    source: e.source,
    target: e.target,
    sourceHandle: data.sourceHandle,
    targetHandle: data.targetHandle,
    data,
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
