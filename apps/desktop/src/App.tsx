import {
  AppShell,
  Main,
  MainContent,
  MainHeader,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarTrigger,
} from "@workspace/ui/components/app-shell"
import { useEffect, useState } from "react"
import { Board } from "@/features/board/Board"
import { store } from "@/lib/store"

export function App() {
  const [projectId, setProjectId] = useState<string>()
  useEffect(() => {
    store.listProjects().then((ps) => setProjectId(ps[0]?.id), console.error)
  }, [])
  return (
    <AppShell>
      <Sidebar>
        <SidebarHeader />
        <SidebarContent>
          {/* Slot: project list (#4). */}
          <p className="px-2 pt-1 pb-1.5 text-xs font-semibold text-sidebar-muted-foreground">
            Projects
          </p>
          <p className="px-2 text-sm text-sidebar-muted-foreground">
            No projects yet
          </p>
        </SidebarContent>
      </Sidebar>
      <Main>
        <MainHeader>
          <h1 className="text-sm font-semibold">CEO</h1>
        </MainHeader>
        <MainContent className="items-center justify-center">
          {/* Slot: board (#5). */}
          {projectId ? (
            <Board key={projectId} projectId={projectId} />
          ) : (
            <p className="text-sm text-muted-foreground">No project selected</p>
          )}
        </MainContent>
      </Main>
      <SidebarTrigger />
    </AppShell>
  )
}
