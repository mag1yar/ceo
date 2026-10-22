import type { NodeTypes } from "@xyflow/react"
import {
  CeoNode,
  ExecutorNode,
  LeadNode,
  MemberNode,
} from "@/features/agents/AgentNode"
import { DiagramNodeView } from "@/features/diagrams/DiagramNode"
import { CardNodeView } from "./CardNode"
import { NoteNodeView } from "./NoteNode"

// Module-level so React Flow never sees a new object; each node type adds one line here.
export const nodeTypes = {
  card: CardNodeView,
  note: NoteNodeView,
  diagram: DiagramNodeView,
  ceo: CeoNode,
  lead: LeadNode,
  member: MemberNode,
  executor: ExecutorNode,
} satisfies NodeTypes
