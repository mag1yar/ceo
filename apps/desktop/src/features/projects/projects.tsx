import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type Project, store } from "@/lib/store"

type ProjectsContextValue = {
  /** null until the first load, so launch never flashes the empty state. */
  projects: Project[] | null
  activeId: string | null
  select: (id: string) => void
  add: () => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  /** Local order while dragging; `saveOrder` persists it. */
  reorder: (projects: Project[]) => void
  saveOrder: () => void
  move: (id: string, delta: number) => void
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null)

export function useProjects() {
  const context = use(ProjectsContext)
  if (!context) throw new Error("useProjects must be used inside <Projects>")
  return context
}

export const folderName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Last opened wins; with nothing opened yet, the first in list order. */
export function lastActive(projects: Project[]) {
  const opened = projects.filter((p) => p.lastOpenedAt !== null)
  if (!opened.length) return projects[0]?.id ?? null
  return opened.reduce((a, b) =>
    (b.lastOpenedAt ?? 0) > (a.lastOpenedAt ?? 0) ? b : a
  ).id
}

export function Projects({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [nonGitPath, setNonGitPath] = useState<string | null>(null)
  // Keeps the title while the dialog animates out after the path clears.
  const shownPath = useRef(nonGitPath)
  if (nonGitPath) shownPath.current = nonGitPath
  const latest = useRef<Project[]>([])
  latest.current = projects ?? []

  const reload = useCallback(async () => {
    const list = await store.listProjects()
    setProjects(list)
    setActiveId((id) =>
      id && list.some((p) => p.id === id) ? id : lastActive(list)
    )
  }, [])

  useEffect(() => {
    reload().catch(console.error)
  }, [reload])

  // Any failed write re-reads the store, so the list never shows what was not saved.
  const sync = useCallback(
    (write: Promise<unknown>) =>
      write.catch((e) => {
        console.error(e)
        return reload().catch(console.error)
      }),
    [reload]
  )

  const select = useCallback(
    (id: string) => {
      if (id === activeId) return
      setActiveId(id)
      sync(store.touchProject(id))
    },
    [activeId, sync]
  )

  const create = useCallback(
    async (path: string) => {
      const project = await store.createProject(folderName(path), path)
      setProjects((list) => [...(list ?? []), project])
      select(project.id)
    },
    [select]
  )

  const add = useCallback(() => {
    const pick = async () => {
      const path = await open({ directory: true, title: "Add project" })
      if (typeof path !== "string") return
      const existing = latest.current.find((p) => p.path === path)
      if (existing) return select(existing.id)
      if (await invoke<boolean>("project_is_git", { path })) return create(path)
      setNonGitPath(path)
    }
    sync(pick())
  }, [create, select, sync])

  const rename = useCallback(
    (id: string, name: string) => {
      const project = latest.current.find((p) => p.id === id)
      if (!project || project.name === name) return
      setProjects((list) =>
        (list ?? []).map((p) => (p.id === id ? { ...p, name } : p))
      )
      sync(store.updateProject(id, name, project.path))
    },
    [sync]
  )

  const remove = useCallback(
    (id: string) => {
      const list = latest.current
      const index = list.findIndex((p) => p.id === id)
      const rest = list.filter((p) => p.id !== id)
      setProjects(rest)
      sync(store.deleteProject(id))
      if (id !== activeId) return
      const next = rest[Math.min(index, rest.length - 1)]
      if (next) select(next.id)
      else setActiveId(null)
    },
    [activeId, select, sync]
  )

  const reorder = useCallback((next: Project[]) => {
    latest.current = next
    setProjects(next)
  }, [])

  const saveOrder = useCallback(() => {
    sync(store.reorderProjects(latest.current.map((p) => p.id)))
  }, [sync])

  const move = useCallback(
    (id: string, delta: number) => {
      const list = [...latest.current]
      const from = list.findIndex((p) => p.id === id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= list.length) return
      list.splice(to, 0, ...list.splice(from, 1))
      latest.current = list
      setProjects(list)
      saveOrder()
    },
    [saveOrder]
  )

  const value = useMemo(
    () => ({
      projects,
      activeId,
      select,
      add,
      rename,
      remove,
      reorder,
      saveOrder,
      move,
    }),
    [projects, activeId, select, add, rename, remove, reorder, saveOrder, move]
  )

  return (
    <ProjectsContext value={value}>
      {children}
      <AlertDialog
        open={nonGitPath !== null}
        onOpenChange={(open) => !open && setNonGitPath(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              “{folderName(shownPath.current ?? "")}” is not a git repository
            </AlertDialogTitle>
            <AlertDialogDescription>
              Agents work in git worktrees, so they need a repository. You can
              add the folder now and run <code>git init</code> in it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (nonGitPath) sync(create(nonGitPath))
                setNonGitPath(null)
              }}
            >
              Add anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProjectsContext>
  )
}
