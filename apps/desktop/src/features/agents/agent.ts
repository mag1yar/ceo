import type { Node } from "@xyflow/react"

// An executor is spawned by the CEO through the bus (#19) and leaves the board once its report is accepted.
export const ROLES = ["ceo", "lead", "member", "executor"] as const
export type Role = (typeof ROLES)[number]
export type Model = "haiku" | "sonnet" | "opus"

// Persisted identity only; live status comes from the in-memory source in status.ts.
export type AgentData = {
  name: string
  model: Model
  // A member's Lead; a Lead's team is its own id.
  leadId?: string
  branch: string
  worktree: string
}

export type AgentNode = Node<AgentData, Role>

export const isAgent = (n: Node | undefined): n is AgentNode =>
  ROLES.includes(n?.type as Role)

export const ROLE_LABEL: Record<Role, string> = {
  ceo: "CEO",
  lead: "Lead",
  member: "Member",
  executor: "Executor",
}

export const MODEL_LABEL: Record<Model, string> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
}
