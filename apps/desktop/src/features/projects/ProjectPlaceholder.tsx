import { useProjects } from "./projects"

// Stands in for <Board projectId> until the board task (#5) lands.
export function ProjectPlaceholder({ projectId }: { projectId: string }) {
  const project = useProjects().projects?.find((p) => p.id === projectId)
  return (
    <div className="flex flex-1 animate-in flex-col items-center justify-center gap-1 duration-150 fade-in-0">
      <p className="text-lg font-semibold">{project?.name}</p>
      <p className="text-sm text-muted-foreground">{project?.path}</p>
    </div>
  )
}
