import { TerminalWindowIcon } from "@phosphor-icons/react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import { type ComponentProps, useRef } from "react"
import { useOpenTerminal } from "@/features/terminal/terminals"

// The agent node's own frame, with a context menu that opens a terminal for it.
export function AgentMenu({
  name,
  ...props
}: ComponentProps<"div"> & { name: string }) {
  // Focus belongs to the new terminal, not back on the node.
  const opened = useRef(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger {...props} />
      <ContextMenuContent
        finalFocus={() => {
          const keep = !opened.current
          opened.current = false
          return keep
        }}
      >
        <OpenTerminalItem name={name} onOpen={() => (opened.current = true)} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

// Mounted only while the menu is open, so nodes do not subscribe to the project list.
function OpenTerminalItem({
  name,
  onOpen,
}: {
  name: string
  onOpen: () => void
}) {
  const openTerminal = useOpenTerminal()
  return (
    <ContextMenuItem
      disabled={!openTerminal}
      onClick={() => {
        onOpen()
        openTerminal?.(name)
      }}
    >
      <TerminalWindowIcon />
      Open terminal
    </ContextMenuItem>
  )
}
