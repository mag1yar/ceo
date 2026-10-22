import { FolderSimplePlusIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { useProjects } from "./projects"

export function ProjectsEmpty() {
  const { add } = useProjects()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex max-w-xs flex-col gap-1.5">
        <h2 className="text-xl font-semibold">Start with a project folder</h2>
        <p className="text-sm text-muted-foreground">
          A project is a folder on your Mac, usually a git repository. Its CEO
          agent works there.
        </p>
      </div>
      <Button onClick={add}>
        <FolderSimplePlusIcon />
        Add project
      </Button>
    </div>
  )
}
