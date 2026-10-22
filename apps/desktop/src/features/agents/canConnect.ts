import { type IsValidConnection, type Node, useReactFlow } from "@xyflow/react"
import { useCallback } from "react"
import { isAgent } from "./agent"

const teamOf = (n: Node) =>
  n.type === "lead" ? n.id : (n.data as { leadId?: string }).leadId

// Hierarchy rule: CEO-Lead, Lead-Lead, and within one team Lead-Member and Member-Member.
export function canConnect(source?: Node, target?: Node) {
  if (!source || !target || source.id === target.id) return false
  if (!isAgent(source) || !isAgent(target)) return true
  const roles = new Set([source.type, target.type])
  if (roles.has("ceo")) return roles.has("lead")
  if (roles.has("member")) {
    const team = teamOf(source)
    return !!team && team === teamOf(target)
  }
  return true
}

export function useIsValidConnection(): IsValidConnection {
  const { getNode } = useReactFlow()
  return useCallback(
    (c) => canConnect(getNode(c.source), getNode(c.target)),
    [getNode]
  )
}
