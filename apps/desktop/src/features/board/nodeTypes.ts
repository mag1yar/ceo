import type { NodeTypes } from "@xyflow/react"
import { CardNodeView } from "./CardNode"

// Module-level so React Flow never sees a new object; each node type adds one line here.
export const nodeTypes = {
  card: CardNodeView,
} satisfies NodeTypes
