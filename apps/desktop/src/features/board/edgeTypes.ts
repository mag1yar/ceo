import type { EdgeTypes } from "@xyflow/react"
import { LinkEdgeView } from "./LinkEdge"

// Module-level so React Flow never sees a new object; each edge kind adds one line here.
export const edgeTypes = {
  link: LinkEdgeView,
} satisfies EdgeTypes
