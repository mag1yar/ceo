import "@xyflow/react/dist/base.css"
import { CornersOutIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  applyNodeChanges,
  type Node,
  type OnBeforeDelete,
  type OnMove,
  type OnNodesChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Viewport,
} from "@xyflow/react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type BoardChanges,
  type Board as BoardData,
  type BoardNode,
  store,
} from "@/lib/store"
import { nodeTypes } from "./nodeTypes"

const SAVE_DELAY = 400
const GRID_GAP = 20
const MULTI_SELECT_KEYS = ["Shift", "Meta"]
const DELETE_KEYS = ["Backspace", "Delete"]
const MIDDLE_BUTTON_PAN = [1]

export function Board({ projectId }: { projectId: string }) {
  const [board, setBoard] = useState<BoardData>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    store.loadBoard(projectId).then(
      (b) => live && setBoard(b),
      (e) => {
        console.error("board load failed", e)
        if (live) setFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [projectId])

  return (
    <div data-slot="board" className="relative min-h-0 flex-1 self-stretch">
      {failed ? (
        <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
          Could not load the board
        </p>
      ) : (
        board && (
          <ReactFlowProvider>
            <Canvas projectId={projectId} initial={board} />
          </ReactFlowProvider>
        )
      )}
    </div>
  )
}

function Canvas({
  projectId,
  initial,
}: {
  projectId: string
  initial: BoardData
}) {
  const [nodes, setNodes] = useState(() => initial.nodes.map(toNode))
  const [viewport] = useState(() => asViewport(initial.viewport))
  const rf = useReactFlow()

  // Last persisted state; a flush sends only what differs from it.
  const saved = useRef({
    nodes: new Map(nodes.map((n) => [n.id, toBoard(n)])),
    viewport,
  })
  const latest = useRef({ nodes, viewport })
  const timer = useRef<number>(undefined)
  const closed = useRef(false)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const prev = saved.current
    const next = new Map(latest.current.nodes.map((n) => [n.id, toBoard(n)]))
    const vp = latest.current.viewport
    const changes: Partial<BoardChanges> = {}
    const upsert = [...next.values()].filter(
      (n) => !sameNode(prev.nodes.get(n.id), n)
    )
    const gone = [...prev.nodes.keys()].filter((id) => !next.has(id))
    if (upsert.length) changes.upsertNodes = upsert
    if (gone.length) changes.deleteNodeIds = gone
    if (vp && !sameViewport(prev.viewport, vp)) changes.viewport = vp
    if (Object.keys(changes).length === 0) return
    saved.current = { nodes: next, viewport: vp }
    store.saveBoard(projectId, changes).catch((e) => {
      console.error("board save failed", e)
      // Put this batch's entries back to what the store still holds, then retry.
      const now = saved.current
      for (const id of [...upsert.map((n) => n.id), ...gone]) {
        const old = prev.nodes.get(id)
        old ? now.nodes.set(id, old) : now.nodes.delete(id)
      }
      if (changes.viewport) now.viewport = prev.viewport
      if (!closed.current) timer.current = window.setTimeout(flush, SAVE_DELAY)
    })
  }, [projectId])

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, SAVE_DELAY)
  }, [flush])

  useEffect(() => {
    latest.current.nodes = nodes
    schedule()
  }, [nodes, schedule])

  useEffect(() => {
    closed.current = false
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      closed.current = true
      flush()
    }
  }, [flush])

  const onMoveEnd: OnMove = useCallback(
    (_, vp) => {
      latest.current.viewport = vp
      schedule()
    },
    [schedule]
  )

  // Undo history: snapshots of the node list taken before each move gesture and delete.
  const past = useRef<Node[][]>([])
  const future = useRef<Node[][]>([])
  const moving = useRef(false)
  const record = useCallback(() => {
    past.current = [...past.current.slice(-99), latest.current.nodes]
    future.current = []
  }, [])
  const onBeforeDelete: OnBeforeDelete = useCallback(
    async ({ nodes }) => {
      if (nodes.length) record()
      return true
    },
    [record]
  )

  // A drag streams dragging:true changes and ends with dragging:false; an arrow-key nudge is a lone dragging:false.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const moves = changes.filter((c) => c.type === "position")
      if (moves.length) {
        if (!moving.current) record()
        moving.current = moves.some((c) => c.dragging)
      }
      setNodes((ns) => applyNodeChanges(changes, ns))
    },
    [record]
  )

  useEffect(() => {
    const step = (from: Node[][], to: Node[][]) => {
      const snapshot = from.pop()
      if (!snapshot) return
      to.push(latest.current.nodes)
      latest.current.nodes = snapshot
      setNodes(snapshot)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.shiftKey && !e.metaKey && e.code === "Digit1") rf.fitView()
      else if (e.metaKey && !e.shiftKey && e.code === "Digit0") rf.zoomTo(1)
      else if (e.metaKey && e.code === "KeyZ")
        e.shiftKey
          ? step(future.current, past.current)
          : step(past.current, future.current)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [rf])

  return (
    <ReactFlow
      nodes={nodes}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
      defaultViewport={viewport}
      fitView={!viewport}
      minZoom={0.1}
      maxZoom={4}
      panOnScroll
      panOnScrollSpeed={1}
      panOnDrag={MIDDLE_BUTTON_PAN}
      selectionOnDrag
      multiSelectionKeyCode={MULTI_SELECT_KEYS}
      deleteKeyCode={DELETE_KEYS}
      zoomOnDoubleClick={false}
      onMoveEnd={onMoveEnd}
      onBeforeDelete={onBeforeDelete}
      attributionPosition="bottom-left"
      className="[--xy-attribution-background-color:transparent] [--xy-selection-background-color:color-mix(in_oklch,var(--primary)_8%,transparent)] [--xy-selection-border:1px_solid_color-mix(in_oklch,var(--primary)_60%,transparent)]"
    >
      <DotGrid />
      <ZoomControls />
    </ReactFlow>
  )
}

// Screen-space dots on whole device pixels with the gap kept in 16..32px, so the grid never shimmers.
function DotGrid() {
  const [x, y, zoom] = useStore((s) => s.transform)
  const dpr = window.devicePixelRatio || 1
  const snap = (v: number) => Math.round(v * dpr) / dpr
  let gap = GRID_GAP * zoom
  while (gap < 16) gap *= 2
  while (gap >= 32) gap /= 2
  gap = snap(gap)
  return (
    <div
      aria-hidden
      className="react-flow__background absolute inset-0 text-foreground/20"
      style={{
        backgroundImage:
          "radial-gradient(circle, currentColor 1px, transparent 1.5px)",
        backgroundSize: `${gap}px ${gap}px`,
        backgroundPosition: `${snap(mod(x, gap))}px ${snap(mod(y, gap))}px`,
      }}
    />
  )
}

function ZoomControls() {
  const rf = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const options = () => ({
    duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
  })
  return (
    <Panel
      position="bottom-right"
      className="flex items-center gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom out"
        onClick={() => rf.zoomOut(options())}
      >
        <MinusIcon />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Zoom to 100%"
        className="w-13 px-0 tabular-nums"
        onClick={() => rf.zoomTo(1, options())}
      >
        {Math.round(zoom * 100)}%
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Zoom in"
        onClick={() => rf.zoomIn(options())}
      >
        <PlusIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Fit board"
        onClick={() => rf.fitView(options())}
      >
        <CornersOutIcon />
      </Button>
    </Panel>
  )
}

function toNode(n: BoardNode): Node {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    data: (n.data ?? {}) as Record<string, unknown>,
    zIndex: n.z,
    ...(n.width != null && { width: n.width }),
    ...(n.height != null && { height: n.height }),
  }
}

function toBoard(n: Node): BoardNode {
  return {
    id: n.id,
    type: n.type ?? "default",
    x: n.position.x,
    y: n.position.y,
    width: n.width ?? null,
    height: n.height ?? null,
    data: n.data,
    z: n.zIndex ?? 0,
  }
}

const sameNode = (a: BoardNode | undefined, b: BoardNode) =>
  !!a &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.z === b.z &&
  a.type === b.type &&
  a.data === b.data

const sameViewport = (a: Viewport | undefined, b: Viewport) =>
  !!a && a.x === b.x && a.y === b.y && a.zoom === b.zoom

function asViewport(v: unknown): Viewport | undefined {
  const { x, y, zoom } = (v ?? {}) as Partial<Viewport>
  return [x, y, zoom].every(Number.isFinite) ? (v as Viewport) : undefined
}

const mod = (v: number, m: number) => ((v % m) + m) % m

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.matches("input, textarea, select"))
