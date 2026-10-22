import { listen } from "@tauri-apps/api/event"
import type { Edge, Node } from "@xyflow/react"
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react"
import { toEdge, toNode } from "@/features/board/link"
import type { BoardChanges, BoardEdge, BoardNode } from "@/lib/store"

// Rust emits this when the bus adds or removes board items: a spawned executor and its link to the CEO.
export const BOARD_EVENT = "board://changes"

type Change = Partial<BoardChanges> & { projectId: string }
type Saved = RefObject<{
  nodes: Map<string, BoardNode>
  edges: Map<string, BoardEdge>
}>

const ownedNode = (n: BoardNode) => n.type === "executor"
const ownedEdge = (e: BoardEdge) =>
  (e.data as { kind?: string } | null)?.kind === "spawn"

// Rust owns these items, so the board's diff-based save must never delete or revive them; undo and redo are corrected.
export function useSpawned(
  projectId: string,
  nodes: Node[],
  edges: Edge[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
  setEdges: Dispatch<SetStateAction<Edge[]>>,
  saved: Saved
) {
  const owned = useRef<{
    nodes: Map<string, BoardNode>
    edges: Map<string, BoardEdge>
    removed: Set<string>
  }>(null)
  owned.current ??= {
    nodes: new Map([...saved.current.nodes].filter(([, n]) => ownedNode(n))),
    edges: new Map([...saved.current.edges].filter(([, e]) => ownedEdge(e))),
    removed: new Set(),
  }

  useEffect(() => {
    const off = listen<Change>(BOARD_EVENT, ({ payload: c }) => {
      const o = owned.current
      if (c.projectId !== projectId || !o) return
      const s = saved.current
      const gone = new Set(c.deleteNodeIds)
      const goneEdge = (e: { id: string; source: string; target: string }) =>
        gone.has(e.source) ||
        gone.has(e.target) ||
        !!c.deleteEdgeIds?.includes(e.id)
      for (const map of [o.nodes, s.nodes])
        for (const id of gone) map.delete(id)
      for (const map of [o.edges, s.edges])
        for (const [id, e] of map)
          if (goneEdge(e)) {
            map.delete(id)
            o.removed.add(id)
          }
      for (const id of gone) o.removed.add(id)
      const addN = c.upsertNodes ?? []
      const addE = c.upsertEdges ?? []
      for (const n of addN)
        for (const map of [o.nodes, s.nodes]) map.set(n.id, n)
      for (const e of addE)
        for (const map of [o.edges, s.edges]) map.set(e.id, e)
      const newN = new Set(addN.map((n) => n.id))
      const newE = new Set(addE.map((e) => e.id))
      setNodes((ns) => [
        ...ns.filter((n) => !gone.has(n.id) && !newN.has(n.id)),
        ...addN.map(toNode),
      ])
      setEdges((es) => [
        ...es.filter((e) => !goneEdge(e) && !newE.has(e.id)),
        ...addE.map(toEdge),
      ])
    })
    return () => {
      off.then((f) => f()).catch(console.error)
    }
  }, [projectId, saved, setNodes, setEdges])

  useEffect(() => {
    const o = owned.current
    if (!o) return
    const lostN = [...o.nodes.values()].filter(
      (n) => !nodes.some((x) => x.id === n.id)
    )
    const lostE = [...o.edges.values()].filter(
      (e) => !edges.some((x) => x.id === e.id)
    )
    const dead = (x: { id: string; source?: string; target?: string }) =>
      o.removed.has(x.id) ||
      o.removed.has(x.source ?? "") ||
      o.removed.has(x.target ?? "")
    if (lostN.length || nodes.some(dead))
      setNodes((ns) => [...ns.filter((n) => !dead(n)), ...lostN.map(toNode)])
    if (lostE.length || edges.some(dead))
      setEdges((es) => [...es.filter((e) => !dead(e)), ...lostE.map(toEdge)])
  }, [nodes, edges, setNodes, setEdges])
}
