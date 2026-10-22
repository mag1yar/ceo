import type { EdgeTypes } from "@xyflow/react"
import { LinkEdgeView, PlainEdgeView } from "./LinkEdge"

// Module-level so React Flow never sees a new object; each edge kind adds one line here.
export const edgeTypes = {
  link: LinkEdgeView,
  plain: PlainEdgeView,
} satisfies EdgeTypes
