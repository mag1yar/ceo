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
import { useEffect } from "react"
import { Board } from "@/features/board/Board"
import { ProjectList } from "@/features/projects/ProjectList"
import { ProjectsEmpty } from "@/features/projects/ProjectsEmpty"
import { Projects, useProjects } from "@/features/projects/projects"
import { pruneTerminals } from "@/features/terminal/terminals"

export function App() {
  return (
    <Projects>
      <AppShell>
        <Sidebar>
          <SidebarHeader />
          <SidebarContent>
            <ProjectList />
          </SidebarContent>
        </Sidebar>
        <Main>
          <MainHeader>
            <ProjectTitle />
          </MainHeader>
          <ActiveProject />
        </Main>
        <SidebarTrigger />
      </AppShell>
    </Projects>
  )
}

function ProjectTitle() {
  const { projects, activeId } = useProjects()
  const project = projects?.find((p) => p.id === activeId)
  return (
    <h1 className="truncate text-sm font-semibold" title={project?.path}>
      {project?.name ?? "CEO"}
    </h1>
  )
}

function ActiveProject() {
  const { projects, activeId: projectId } = useProjects()
  useEffect(() => {
    if (projects) pruneTerminals(projects.map((p) => p.id))
  }, [projects])
  return (
    <MainContent>
      {projects?.length === 0 && <ProjectsEmpty />}
      {projectId && <Board key={projectId} projectId={projectId} />}
    </MainContent>
  )
}
