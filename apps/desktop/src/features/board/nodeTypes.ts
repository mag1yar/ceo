import type { NodeTypes } from "@xyflow/react"
import { CeoNode, LeadNode, MemberNode } from "@/features/agents/AgentNode"
import { CardNodeView } from "./CardNode"

// Module-level so React Flow never sees a new object; each node type adds one line here.
export const nodeTypes = {
  card: CardNodeView,
  ceo: CeoNode,
  lead: LeadNode,
  member: MemberNode,
} satisfies NodeTypes
