import { describe, expect, it } from "vitest"
import type { AgentData } from "./agent"
import { agentOrder, buildTeam, NODE_SIZE } from "./team"

const team = buildTeam()
const nodes = team.nodes.map((n) => ({ ...n, data: n.data as AgentData }))

describe("buildTeam", () => {
  it("lays the seeded team out without overlapping nodes", () => {
    const gap = 40
    const boxes = nodes.map((n) => ({
      ...n,
      ...NODE_SIZE[n.type as "ceo"],
    }))
    for (const a of boxes)
      for (const b of boxes)
        if (a !== b)
          expect(
            a.x + a.width + gap <= b.x ||
              b.x + b.width + gap <= a.x ||
              a.y + a.height + gap <= b.y ||
              b.y + b.height + gap <= a.y,
            `${a.data.name} overlaps ${b.data.name}`
          ).toBe(true)
  })
})

describe("agentOrder", () => {
  it("goes CEO, then each Lead clockwise from the top followed by its Members", () => {
    const placed = nodes
      .map((n) => ({ ...n, position: { x: n.x, y: n.y } }))
      .reverse()
    const names = agentOrder(placed).map((n) => n.data.name)
    expect(names).toEqual([
      "CEO",
      "Board",
      "Notes",
      "Edges",
      "Agent nodes",
      "Terminal",
      "PTY",
      "xterm.js",
      "Storage",
      "Migrations",
      "Board IPC",
      "Store tests",
    ])
  })
})
