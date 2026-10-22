import { NoteIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { Panel } from "@xyflow/react"

export function BoardToolbar({ onAddNote }: { onAddNote: () => void }) {
  return (
    <Panel
      position="bottom-center"
      className="flex items-center gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm"
    >
      <Button variant="ghost" size="sm" onClick={onAddNote}>
        <NoteIcon />
        Note
      </Button>
    </Panel>
  )
}
