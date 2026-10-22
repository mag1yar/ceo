import { ArrowsInSimpleIcon, ArrowsOutSimpleIcon } from "@phosphor-icons/react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import { type ComponentProps, useRef } from "react"
import { toggleFocus } from "./AgentTerminals"

// The agent node's own frame, with a context menu that focuses its terminal.
export function AgentMenu({
  nodeId,
  focused,
  ...props
}: ComponentProps<"div"> & { nodeId: string; focused: boolean }) {
  // Keyboard focus belongs to the terminal after entering focus, not back on the node.
  const toggled = useRef(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger {...props} />
      <ContextMenuContent
        finalFocus={() => {
          const keep = !toggled.current
          toggled.current = false
          return keep
        }}
      >
        <ContextMenuItem
          onClick={() => {
            toggled.current = true
            toggleFocus(nodeId)
          }}
        >
          {focused ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
          {focused ? "Exit focus" : "Focus terminal"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
