import { PlantIcon, TerminalWindowIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  type Node,
  type OnSelectionChangeFunc,
  Panel,
  useOnSelectionChange,
  useReactFlow,
} from "@xyflow/react"
import { type ReactNode, useCallback, useState } from "react"
import { toEdge } from "@/features/board/link"
import { store } from "@/lib/store"
import { StatusIcon } from "./AgentNode"
import { type AgentNode, isAgent, MODEL_LABEL, ROLE_LABEL } from "./agent"
import { STATUS_LABEL, useLive } from "./status"
import { buildTeam } from "./team"

export function AgentInspector() {
  const [agent, setAgent] = useState<AgentNode>()
  const onChange: OnSelectionChangeFunc = useCallback(
    ({ nodes }) =>
      setAgent(nodes.length === 1 && isAgent(nodes[0]) ? nodes[0] : undefined),
    []
  )
  useOnSelectionChange({ onChange })
  return agent ? (
    <Panel position="top-right">
      <Inspector agent={agent} />
    </Panel>
  ) : null
}

function Inspector({ agent }: { agent: AgentNode }) {
  const { status, action } = useLive(agent.id)
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
      </dl>
      {/* Terminals arrive with #8. */}
      <Button variant="outline" className="mt-4 w-full" disabled>
        <TerminalWindowIcon />
        Open terminal
      </Button>
    </aside>
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
    const nodes: Node[] = team.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      data: n.data as Record<string, unknown>,
      zIndex: n.z,
    }))
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
