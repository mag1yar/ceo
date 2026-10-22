import type { NodeTypes } from "@xyflow/react"
import { CardNodeView } from "./CardNode"
import { NoteNodeView } from "./NoteNode"

// Module-level so React Flow never sees a new object; each node type adds one line here.
export const nodeTypes = {
  card: CardNodeView,
  note: NoteNodeView,
} satisfies NodeTypes
