// Loaded only by `vite --mode e2e`: stands in for the Rust backend with an in-memory store.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks"
import type { Board, BoardChanges, Project } from "@/lib/store"

// Snapshot in sessionStorage so specs can check persistence across page.reload().
const KEY = "ceo.e2e.mock-ipc"
const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "{}")
const projects: Project[] = saved.projects ?? []
const boards = new Map<string, Board>(saved.boards)

function project(id: string) {
  const p = projects.find((p) => p.id === id)
  if (!p) throw "Query returned no rows"
  return p
}

function board(projectId: string) {
  return boards.get(projectId) ?? { viewport: {}, nodes: [], edges: [] }
}

const byId = (x: { id: string }, y: { id: string }) =>
  x.id < y.id ? -1 : x.id > y.id ? 1 : 0

mockWindows("main")
// Copies, like real IPC: callers must never hold references into the mock store.
mockIPC((cmd, payload) => {
  const result = structuredClone(handle(cmd, payload))
  sessionStorage.setItem(KEY, JSON.stringify({ projects, boards: [...boards] }))
  return result
})

// Mirrors the Rust store's ordering and errors so headless specs see what the real app does.
function handle(cmd: string, payload: unknown) {
  const a = (payload ?? {}) as Record<string, string> & {
    ids: string[]
    changes: Partial<BoardChanges>
  }
  switch (cmd) {
    case "project_list":
      return [...projects].sort(
        (x, y) => x.position - y.position || x.createdAt - y.createdAt
      )
    case "project_create": {
      const p: Project = {
        id: crypto.randomUUID(),
        name: a.name,
        path: a.path,
        position: Math.max(-1, ...projects.map((p) => p.position)) + 1,
        createdAt: Date.now(),
        lastOpenedAt: null,
      }
      projects.push(p)
      return p
    }
    case "project_update":
      return Object.assign(project(a.id), { name: a.name, path: a.path })
    case "project_touch":
      return Object.assign(project(a.id), { lastOpenedAt: Date.now() })
    case "project_delete": {
      const i = projects.findIndex((p) => p.id === a.id)
      if (i >= 0) projects.splice(i, 1)
      boards.delete(a.id)
      return null
    }
    case "project_reorder":
      a.ids.forEach((id, i) => {
        const p = projects.find((p) => p.id === id)
        if (p) p.position = i
      })
      return null
    case "board_load": {
      const b = board(a.projectId)
      return {
        ...b,
        nodes: [...b.nodes].sort((x, y) => x.z - y.z || byId(x, y)),
        edges: [...b.edges].sort(byId),
      }
    }
    case "board_save": {
      const c = a.changes
      // Validate before mutating: the Rust batch is one transaction.
      if (!projects.some((p) => p.id === a.projectId))
        throw "FOREIGN KEY constraint failed"
      if (c.upsertNodes?.some((n) => n.type === ""))
        throw "CHECK constraint failed: type <> ''"
      const b = board(a.projectId)
      boards.set(a.projectId, b)
      if (c.viewport) b.viewport = c.viewport
      const gone = new Set(c.deleteNodeIds)
      b.nodes = b.nodes.filter((n) => !gone.has(n.id))
      b.edges = b.edges.filter(
        (e) =>
          !c.deleteEdgeIds?.includes(e.id) &&
          !gone.has(e.source) &&
          !gone.has(e.target)
      )
      for (const n of c.upsertNodes ?? [])
        b.nodes = [...b.nodes.filter((x) => x.id !== n.id), n]
      for (const e of c.upsertEdges ?? [])
        b.edges = [...b.edges.filter((x) => x.id !== e.id), e]
      return null
    }
    default:
      throw `mock-ipc: no handler for ${cmd}`
  }
}
