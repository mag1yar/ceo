// Loaded only by `vite --mode e2e`: stands in for the Rust backend with an in-memory store.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks"
import type { Board, BoardChanges, Project } from "@/lib/store"

const projects: Project[] = []
const boards = new Map<string, Board>()

function project(id: string) {
  const p = projects.find((p) => p.id === id)
  if (!p) throw "Query returned no rows"
  return p
}

function board(projectId: string) {
  const b = boards.get(projectId) ?? { viewport: {}, nodes: [], edges: [] }
  boards.set(projectId, b)
  return b
}

mockWindows("main")
mockIPC((cmd, payload) => {
  const a = (payload ?? {}) as Record<string, string> & {
    ids: string[]
    changes: Partial<BoardChanges>
  }
  switch (cmd) {
    case "project_list":
      return [...projects].sort((x, y) => x.position - y.position)
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
    case "project_delete":
      projects.splice(projects.indexOf(project(a.id)), 1)
      boards.delete(a.id)
      return null
    case "project_reorder":
      a.ids.forEach((id, i) => {
        project(id).position = i
      })
      return null
    case "board_load":
      return board(a.projectId)
    case "board_save": {
      const b = board(a.projectId)
      const c = a.changes
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
})
