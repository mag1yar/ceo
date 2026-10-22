import "@xyflow/react/dist/base.css"
import { CornersOutIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  applyEdgeChanges,
  applyNodeChanges,
  ConnectionMode,
  type Edge,
  type Node,
  type OnBeforeDelete,
  type OnConnect,
  type OnEdgesChange,
  type OnMove,
  type OnNodesChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useStoreApi,
  type Viewport,
} from "@xyflow/react"
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { AgentInspector, SeedTeam } from "@/features/agents/AgentPanels"
import { AgentTerminals, focusedId } from "@/features/agents/AgentTerminals"
import { useIsValidConnection } from "@/features/agents/canConnect"
import { newDiagram } from "@/features/diagrams/diagram"
import {
  type BoardChanges,
  type Board as BoardData,
  type BoardNode,
  store,
} from "@/lib/store"
import { BoardToolbar } from "./BoardToolbar"
import { edgeTypes } from "./edgeTypes"
import { LinkConnectionLine } from "./LinkEdge"
import { newLink, sameEdge, toBoardEdge, toEdge } from "./link"
import { nodeTypes } from "./nodeTypes"
import { newNote } from "./note"

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
  const [edges, setEdges] = useState<Edge[]>(() => initial.edges.map(toEdge))
  const [viewport] = useState(() => asViewport(initial.viewport))
  const rf = useReactFlow()
  const flow = useStoreApi()
  const isValidConnection = useIsValidConnection()

  // Last persisted state; a flush sends only what differs from it.
  const saved = useRef({
    nodes: new Map(nodes.map((n) => [n.id, toBoard(n)])),
    edges: new Map(edges.map((e) => [e.id, toBoardEdge(e)])),
    viewport,
  })
  const latest = useRef({ nodes, edges, viewport })
  const timer = useRef<number>(undefined)
  const closed = useRef(false)

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const prev = saved.current
    const next = new Map(latest.current.nodes.map((n) => [n.id, toBoard(n)]))
    const nextEdges = new Map(
      latest.current.edges.map((e) => [e.id, toBoardEdge(e)])
    )
    const vp = latest.current.viewport
    const changes: Partial<BoardChanges> = {}
    const nodeDiff = diff(prev.nodes, next, sameNode)
    const edgeDiff = diff(prev.edges, nextEdges, sameEdge)
    if (nodeDiff.upsert.length) changes.upsertNodes = nodeDiff.upsert
    if (nodeDiff.gone.length) changes.deleteNodeIds = nodeDiff.gone
    if (edgeDiff.upsert.length) changes.upsertEdges = edgeDiff.upsert
    if (edgeDiff.gone.length) changes.deleteEdgeIds = edgeDiff.gone
    if (vp && !sameViewport(prev.viewport, vp)) changes.viewport = vp
    if (Object.keys(changes).length === 0) return
    saved.current = { nodes: next, edges: nextEdges, viewport: vp }
    store.saveBoard(projectId, changes).catch((e) => {
      console.error("board save failed", e)
      // Put this batch's entries back to what the store still holds, then retry.
      const now = saved.current
      revert(now.nodes, prev.nodes, nodeDiff)
      revert(now.edges, prev.edges, edgeDiff)
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
    latest.current.edges = edges
    schedule()
  }, [nodes, edges, schedule])

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

  // Undo history: snapshots of nodes and edges taken before each gesture, edit, create and delete.
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const moving = useRef(false)
  const record = useCallback(() => {
    const { nodes, edges } = latest.current
    past.current = [...past.current.slice(-99), { nodes, edges }]
    future.current = []
  }, [])
  const onBeforeDelete: OnBeforeDelete = useCallback(
    async ({ nodes, edges }) => {
      // A stray Backspace after clicking the focused node's header must not kill its shell.
      if (nodes.some((n) => n.id === focusedId())) return false
      if (nodes.length || edges.length) record()
      return true
    },
    [record]
  )

  // A drag or resize streams dragging/resizing:true changes and ends with false; an arrow-key nudge is a lone dragging:false.
  // Replace changes are data edits (note text, colour, edge label), one per editing session.
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const gesture = changes.filter(
        (c) =>
          c.type === "position" ||
          (c.type === "dimensions" && c.resizing !== undefined)
      )
      if (gesture.length) {
        if (!moving.current) record()
        moving.current = gesture.some(
          (c) =>
            (c.type === "position" && c.dragging) ||
            (c.type === "dimensions" && c.resizing)
        )
      }
      if (changes.some((c) => c.type === "replace")) record()
      setNodes((ns) => applyNodeChanges(changes, ns))
    },
    [record]
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      if (changes.some((c) => c.type === "replace")) record()
      setEdges((es) => applyEdgeChanges(changes, es))
    },
    [record]
  )

  const onConnect: OnConnect = useCallback(
    (c) => {
      const link = newLink(c)
      // Ends float, so which dots were used does not make a second link different.
      const twin = latest.current.edges.some(
        (e) =>
          e.source === link.source &&
          e.target === link.target &&
          e.type === link.type
      )
      if (c.source === c.target || twin) return
      record()
      setEdges((es) => [...es, link])
    },
    [record]
  )

  const addNote = useCallback(
    (at: { x: number; y: number }) => {
      const note = newNote(at)
      record()
      setNodes((ns) => [...ns, note])
    },
    [record]
  )
  const addNoteAtCenter = useCallback(() => {
    const { width, height, transform } = flow.getState()
    const [x, y, zoom] = transform
    addNote({ x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom })
  }, [addNote, flow])
  const addDiagram = useCallback(() => {
    const { width, height, transform } = flow.getState()
    const [x, y, zoom] = transform
    const diagram = newDiagram({
      x: (width / 2 - x) / zoom,
      y: (height / 2 - y) / zoom,
    })
    record()
    setNodes((ns) => [...ns, diagram])
  }, [flow, record])
  const onDoubleClick = useCallback(
    (e: MouseEvent) => {
      if ((e.target as Element).classList.contains("react-flow__pane"))
        addNote(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    },
    [addNote, rf]
  )

  useEffect(() => {
    const step = (from: Snapshot[], to: Snapshot[]) => {
      const snapshot = from.pop()
      if (!snapshot) return
      const { nodes, edges } = latest.current
      to.push({ nodes, edges })
      Object.assign(latest.current, snapshot)
      setNodes(snapshot.nodes)
      setEdges(snapshot.edges)
    }
    // A bare letter must not fire from a sidebar menu's typeahead, only from the board or nothing focused.
    const onBoard = (t: EventTarget | null) =>
      t === document.body ||
      (t instanceof Node && !!flow.getState().domNode?.contains(t))
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.shiftKey && !e.metaKey && e.code === "Digit1") rf.fitView()
      else if (e.metaKey && !e.shiftKey && e.code === "Digit0") rf.zoomTo(1)
      else if (e.code === "KeyN" && !e.repeat && plain(e) && onBoard(e.target))
        addNoteAtCenter()
      else if (e.metaKey && e.code === "KeyZ")
        e.shiftKey
          ? step(future.current, past.current)
          : step(past.current, future.current)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [rf, flow, addNoteAtCenter])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      connectionMode={ConnectionMode.Loose}
      connectionLineComponent={LinkConnectionLine}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onDoubleClick={onDoubleClick}
      isValidConnection={isValidConnection}
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
      className="[--xy-attribution-background-color:transparent] [--xy-selection-background-color:color-mix(in_oklch,var(--primary)_8%,transparent)] [--xy-selection-border:1px_solid_color-mix(in_oklch,var(--primary)_60%,transparent)] [--xy-edge-stroke:var(--muted-foreground)] [--xy-edge-stroke-selected:var(--primary)] [--xy-edge-stroke-width:1.5] [--xy-connectionline-stroke:var(--primary)] [--xy-connectionline-stroke-width:1.5]"
    >
      <DotGrid />
      <ZoomControls />
      <BoardToolbar onAddNote={addNoteAtCenter} onAddDiagram={addDiagram} />
      <AgentInspector />
      <AgentTerminals projectId={projectId} />
      {import.meta.env.DEV && <SeedTeam projectId={projectId} />}
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

type Snapshot = { nodes: Node[]; edges: Edge[] }

function diff<T>(
  prev: Map<string, T>,
  next: Map<string, T>,
  same: (a: T | undefined, b: T) => boolean
) {
  return {
    upsert: [...next]
      .filter(([id, v]) => !same(prev.get(id), v))
      .map(([, v]) => v),
    gone: [...prev.keys()].filter((id) => !next.has(id)),
  }
}

function revert<T extends { id: string }>(
  now: Map<string, T>,
  prev: Map<string, T>,
  { upsert, gone }: { upsert: T[]; gone: string[] }
) {
  for (const id of [...upsert.map((v) => v.id), ...gone]) {
    const old = prev.get(id)
    old ? now.set(id, old) : now.delete(id)
  }
}

const sameViewport = (a: Viewport | undefined, b: Viewport) =>
  !!a && a.x === b.x && a.y === b.y && a.zoom === b.zoom

function asViewport(v: unknown): Viewport | undefined {
  const { x, y, zoom } = (v ?? {}) as Partial<Viewport>
  return [x, y, zoom].every(Number.isFinite) ? (v as Viewport) : undefined
}

const plain = (e: KeyboardEvent) =>
  !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey

const mod = (v: number, m: number) => ((v % m) + m) % m

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.matches("input, textarea, select"))
