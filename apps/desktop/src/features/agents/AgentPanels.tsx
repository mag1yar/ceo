import { PlantIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  type OnSelectionChangeFunc,
  Panel,
  useOnSelectionChange,
  useReactFlow,
} from "@xyflow/react"
import { type ReactNode, useCallback, useEffect, useState } from "react"
import { toEdge, toNode } from "@/features/board/link"
import { store, type Usage } from "@/lib/store"
import { StatusIcon } from "./AgentNode"
import { useFocusedId } from "./AgentTerminals"
import { type AgentNode, isAgent, MODEL_LABEL, ROLE_LABEL } from "./agent"
import { STATUS_LABEL, useLive } from "./status"
import { buildTeam } from "./team"

export function AgentInspector({ projectId }: { projectId: string }) {
  const [agent, setAgent] = useState<AgentNode>()
  const onChange: OnSelectionChangeFunc = useCallback(
    ({ nodes }) =>
      setAgent(nodes.length === 1 && isAgent(nodes[0]) ? nodes[0] : undefined),
    []
  )
  useOnSelectionChange({ onChange })
  // Focus mode gives the board to the terminal.
  const focused = useFocusedId() !== undefined
  return agent && !focused ? (
    <Panel position="top-right">
      <Inspector key={agent.id} agent={agent} projectId={projectId} />
    </Panel>
  ) : null
}

function Inspector({
  agent,
  projectId,
}: {
  agent: AgentNode
  projectId: string
}) {
  const { status, action } = useLive(agent.id)
  const usage = useUsage(projectId, agent.id, status)
  const { name, model, branch, worktree } = agent.data
  return (
    <aside
      aria-label="Agent inspector"
      className="w-80 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <h2 className="truncate text-lg font-semibold">{name}</h2>
      <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
        <Row label="Role">{ROLE_LABEL[agent.type]}</Row>
        <Row label="Model">{MODEL_LABEL[model]}</Row>
        <Row label="Status">
          <span className="flex items-center gap-1.5">
            <StatusIcon status={status} />
            {STATUS_LABEL[status]}
          </span>
        </Row>
        <Row label="Doing">{action}</Row>
        <Row label="Branch" mono>
          {branch}
        </Row>
        <Row label="Worktree" mono>
          {worktree}
        </Row>
        {usage ? (
          <Row label="Tokens">
            <TokenCounts usage={usage} />
          </Row>
        ) : null}
      </dl>
    </aside>
  )
}

// The node's latest session; read again whenever its status moves, which is when a turn ends.
function useUsage(projectId: string, nodeId: string, status: string) {
  const [usage, setUsage] = useState<Usage>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: status is the refetch signal
  useEffect(() => {
    let current = true
    store.listUsage(projectId).then((list) => {
      if (current) setUsage(list.findLast((u) => u.nodeId === nodeId))
    }, console.error)
    return () => {
      current = false
    }
  }, [projectId, nodeId, status])
  return usage
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

function TokenCounts({ usage }: { usage: Usage }) {
  const counts = [
    ["in", usage.input],
    ["out", usage.output],
    ["read", usage.cacheRead],
    ["write", usage.cacheWrite1h + usage.cacheWrite5m],
  ] as const
  return (
    <span
      data-slot="usage"
      className="grid grid-cols-4 gap-2"
      title={counts
        .map(([k, v]) => `${k} ${v.toLocaleString("en")}`)
        .join(", ")}
    >
      {counts.map(([label, value]) => (
        <span key={label} className="flex flex-col">
          <span className="tabular-nums">{compact.format(value)}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </span>
      ))}
    </span>
  )
}

function Row({
  label,
  mono,
  children,
}: {
  label: string
  mono?: boolean
  children: ReactNode
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          mono ? "truncate font-mono text-xs leading-[18px]" : "min-w-0"
        }
        title={mono ? String(children) : undefined}
      >
        {children}
      </dd>
    </>
  )
}

// Dev builds only: drops a mock team beside whatever is already on the board.
export function SeedTeam({ projectId }: { projectId: string }) {
  const rf = useReactFlow()
  const [busy, setBusy] = useState(false)
  const seed = async () => {
    const existing = rf.getNodes()
    const b = existing.length ? rf.getNodesBounds(existing) : undefined
    const team = buildTeam(
      b ? { x: b.x + b.width + 900, y: b.y + b.height / 2 } : undefined
    )
    setBusy(true)
    try {
      await store.saveBoard(projectId, {
        upsertNodes: team.nodes,
        upsertEdges: team.edges,
      })
    } catch (e) {
      console.error("seed failed", e)
      return
    } finally {
      setBusy(false)
    }
    const nodes = team.nodes.map(toNode)
    rf.addNodes(nodes)
    rf.addEdges(team.edges.map(toEdge))
    rf.fitView({ nodes })
  }
  return (
    <Panel position="top-left">
      <Button variant="outline" size="sm" disabled={busy} onClick={seed}>
        <PlantIcon />
        Seed team
      </Button>
    </Panel>
  )
}
