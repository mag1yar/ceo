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
import { ProjectList } from "@/features/projects/ProjectList"
import { ProjectPlaceholder } from "@/features/projects/ProjectPlaceholder"
import { ProjectsEmpty } from "@/features/projects/ProjectsEmpty"
import { Projects, useProjects } from "@/features/projects/projects"

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
            <h1 className="text-sm font-semibold">CEO</h1>
          </MainHeader>
          <ActiveProject />
        </Main>
        <SidebarTrigger />
      </AppShell>
    </Projects>
  )
}

function ActiveProject() {
  const { projects, activeId: projectId } = useProjects()
  return (
    <MainContent>
      {projects?.length === 0 && <ProjectsEmpty />}
      {projectId && (
        <ProjectPlaceholder key={projectId} projectId={projectId} />
      )}
    </MainContent>
  )
}
