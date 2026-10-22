import { FlowArrowIcon, NoteIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { Panel } from "@xyflow/react"

export function BoardToolbar({
  onAddNote,
  onAddDiagram,
}: {
  onAddNote: () => void
  onAddDiagram: () => void
}) {
  return (
    <Panel
      position="bottom-center"
      className="flex items-center gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm"
    >
      <Button variant="ghost" size="sm" onClick={onAddNote}>
        <NoteIcon />
        Note
      </Button>
      <Button variant="ghost" size="sm" onClick={onAddDiagram}>
        <FlowArrowIcon />
        Diagram
      </Button>
    </Panel>
  )
}
