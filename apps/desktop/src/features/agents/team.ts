// No path aliases here: the wdio specs import this file directly.
import type { BoardEdge, BoardNode } from "../../lib/store"
import type { AgentData, Model, Role } from "./agent"

// Rendered sizes, so the layout can place node centres rather than corners. Each fits an 80x12 terminal at 100%.
const AGENT_SIZE = { width: 624, height: 280 }
export const NODE_SIZE: Record<Role, { width: number; height: number }> = {
  ceo: AGENT_SIZE,
  lead: AGENT_SIZE,
  member: AGENT_SIZE,
  executor: AGENT_SIZE,
}

const LEAD_RADIUS = 800
const MEMBER_RADIUS = 960
const MEMBER_SPREAD = 0.8

type Point = { x: number; y: number }

// CEO at the centre, Leads evenly on a circle, each Lead's Members fanned outward around it.
export function radialLayout(
  teamSizes: number[],
  centre: Point = { x: 0, y: 0 }
) {
  const leads = teamSizes.map((size, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / teamSizes.length
    const at = polar(centre, LEAD_RADIUS, angle)
    const members = Array.from({ length: size }, (_, j) =>
      polar(at, MEMBER_RADIUS, angle + MEMBER_SPREAD * (j - (size - 1) / 2))
    )
    return { at, members }
  })
  return { ceo: centre, leads }
}

const polar = (o: Point, r: number, a: number) => ({
  x: o.x + r * Math.cos(a),
  y: o.y + r * Math.sin(a),
})

type Placed = {
  id: string
  type?: string
  position: Point
  data: { leadId?: string }
}

// Focus order: the CEO, then each Lead clockwise from the top followed by its Members, then the rest.
export function agentOrder<T extends Placed>(nodes: T[]): T[] {
  const ceo = nodes.find((n) => n.type === "ceo")
  const o = (ceo ?? nodes[0])?.position
  if (!o) return []
  const angle = (n: T) =>
    (Math.atan2(n.position.x - o.x, o.y - n.position.y) + 2 * Math.PI) %
    (2 * Math.PI)
  const around = nodes.toSorted((a, b) => angle(a) - angle(b))
  const out = ceo ? [ceo] : []
  // Members sweep clockwise across their Lead's direction, which may straddle the top.
  const rel = (n: T, lead: T) =>
    ((angle(n) - angle(lead) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI
  for (const lead of around.filter((n) => n.type === "lead"))
    out.push(
      lead,
      ...around
        .filter((m) => m.type === "member" && m.data.leadId === lead.id)
        .sort((a, b) => rel(a, lead) - rel(b, lead))
    )
  return [...out, ...around.filter((n) => !out.includes(n))]
}

const TEAMS: { name: string; model: Model; members: [string, Model][] }[] = [
  {
    name: "Board",
    model: "opus",
    members: [
      ["Notes", "sonnet"],
      ["Edges", "haiku"],
      ["Agent nodes", "sonnet"],
    ],
  },
  {
    name: "Terminal",
    model: "sonnet",
    members: [
      ["PTY", "sonnet"],
      ["xterm.js", "haiku"],
    ],
  },
  {
    name: "Storage",
    model: "sonnet",
    members: [
      ["Migrations", "haiku"],
      ["Board IPC", "sonnet"],
      ["Store tests", "haiku"],
    ],
  },
]

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")

// Mock team: 1 CEO, 3 Leads, 2-3 Members each, wired with hierarchy edges.
export function buildTeam(centre?: Point) {
  const layout = radialLayout(
    TEAMS.map((t) => t.members.length),
    centre
  )
  const nodes: BoardNode[] = []
  const edges: BoardEdge[] = []
  const add = (type: Role, at: Point, data: AgentData) => {
    const { width, height } = NODE_SIZE[type]
    const id = crypto.randomUUID()
    nodes.push({
      id,
      type,
      x: Math.round(at.x - width / 2),
      y: Math.round(at.y - height / 2),
      width: null,
      height: null,
      data,
      z: 0,
    })
    return id
  }
  const link = (source: string, target: string) =>
    edges.push({
      id: crypto.randomUUID(),
      source,
      target,
      data: { kind: "hierarchy" },
    })

  const ceo = add("ceo", layout.ceo, {
    name: "CEO",
    model: "opus",
    branch: "ceo/integration",
    worktree: "~/ceo/worktrees/ceo",
  })
  TEAMS.forEach((team, i) => {
    const { at, members } = layout.leads[i]
    const lead = add("lead", at, {
      name: team.name,
      model: team.model,
      branch: `lead/${slug(team.name)}`,
      worktree: `~/ceo/worktrees/${slug(team.name)}`,
    })
    link(ceo, lead)
    team.members.forEach(([name, model], j) => {
      const branch = `lead/${slug(team.name)}/${slug(name)}`
      link(
        lead,
        add("member", members[j], {
          name,
          model,
          leadId: lead,
          branch,
          worktree: `~/ceo/worktrees/${slug(team.name)}-${slug(name)}`,
        })
      )
    })
  })
  return { nodes, edges }
}
