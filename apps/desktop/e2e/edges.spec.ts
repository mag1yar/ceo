import { expect, type Page, test } from "@playwright/test"
import type { Board, BoardEdge, BoardNode } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = { __TAURI_INTERNALS__: Ipc }
type Box = { x: number; y: number; width: number; height: number }

const ipc = (page: Page, cmd: string, args?: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (window as unknown as Win).__TAURI_INTERNALS__.invoke(
        cmd as string,
        args as object
      ),
    [cmd, args] as const
  )

const node = (
  id: string,
  type: string,
  x: number,
  y: number,
  size: { width: number; height: number } | null,
  data: unknown
): BoardNode => ({
  id,
  type,
  x,
  y,
  width: size?.width ?? null,
  height: size?.height ?? null,
  data,
  z: 0,
})
const NOTE = { width: 160, height: 100 }
const note = (id: string, x: number, y: number) =>
  node(id, "note", x, y, NOTE, { text: id, color: "default" })

// A project whose board holds the given nodes and edges at zoom 1, so flow and screen distances match.
async function seed(page: Page, nodes: BoardNode[], edges: BoardEdge[] = []) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const { id } = (await ipc(page, "project_create", {
    name: "edges",
    path: "/tmp/edges",
  })) as { id: string }
  await ipc(page, "board_save", {
    projectId: id,
    changes: {
      upsertNodes: nodes,
      upsertEdges: edges,
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  })
  await page.reload()
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length)
  return id
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

const nodeSel = (id: string) => `.react-flow__node[data-id="${id}"]`
const dot = (id: string, side: string) =>
  `${nodeSel(id)} .react-flow__handle[data-handleid="${side}"]`

// Drags from a side dot of one node and drops on the centre of another.
async function connect(page: Page, from: string, side: string, to: string) {
  const a = centre(await box(page, dot(from, side)))
  const b = centre(await box(page, nodeSel(to)))
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 10 })
  await page.mouse.up()
}

// First and last points of an edge path, in screen pixels.
async function ends(page: Page, edge: string) {
  const board = await box(page, "[data-slot=board]")
  const d = await page
    .locator(`${edge} .react-flow__edge-path`)
    .getAttribute("d")
  const n = (d ?? "").match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
  expect(n.length).toBeGreaterThanOrEqual(4)
  expect(n.every(Number.isFinite)).toBe(true)
  return {
    start: { x: n[0] + board.x, y: n[1] + board.y },
    end: { x: n[n.length - 2] + board.x, y: n[n.length - 1] + board.y },
  }
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(2)

test("connects from every side of a note and a diagram, drops anywhere, floats to the nearest side", async ({
  page,
}, info) => {
  const projectId = await seed(page, [
    note("s", 420, 40),
    node(
      "d",
      "diagram",
      420,
      300,
      { width: 300, height: 180 },
      {
        source: "flowchart LR\n  Idea --> Ship",
      }
    ),
    note("t1", 820, 20),
    note("t2", 820, 190),
    note("t3", 820, 360),
    note("t4", 820, 530),
    node("c", "card", 60, 600, null, { title: "card" }),
  ])
  const edges = page.locator(".react-flow__edge")
  const sides = ["top", "right", "bottom", "left"]

  // Hover shows the four dots; screenshot them.
  await page.locator(nodeSel("s")).hover()
  for (const side of sides)
    await expect(page.locator(dot("s", side))).toHaveCSS("opacity", "1")
  await page.screenshot({ path: info.outputPath("hover-dots.png") })

  // A connection in progress highlights the whole target node.
  const from = centre(await box(page, dot("d", "top")))
  const over = centre(await box(page, nodeSel("t1")))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(over.x, over.y, { steps: 10 })
  const target = page.locator(
    `${nodeSel("t1")} .react-flow__handle[data-handleid="body"]`
  )
  await expect(target).toHaveClass(/connectingto/)
  await expect(target).toHaveClass(/valid/)
  await page.screenshot({ path: info.outputPath("connecting.png") })
  await page.mouse.up()
  await expect(edges).toHaveCount(1)

  // Every side of the note and the diagram starts a link that lands on a target's centre; d's top made d -> t1 above.
  let count = 1
  for (const [i, side] of sides.entries()) {
    await connect(page, "s", side, `t${i + 1}`)
    await expect(edges).toHaveCount(++count)
    if (i === 0) continue
    await connect(page, "d", side, `t${i + 1}`)
    await expect(edges).toHaveCount(++count)
  }
  // The temporary card node shares the same dots.
  await connect(page, "c", "right", "t4")
  await expect(edges).toHaveCount(++count)
  expect(count).toBe(9)

  // A second link between the same two nodes from another dot is refused.
  await connect(page, "s", "left", "t1")
  await connect(page, "d", "bottom", "t1")
  await expect(edges).toHaveCount(9)
  await expect
    .poll(
      async () =>
        ((await ipc(page, "board_load", { projectId })) as Board).edges.length
    )
    .toBe(9)

  // t1 sits right of s: the link leaves s's right side and enters t1's left side.
  const s = await box(page, nodeSel("s"))
  let t1 = await box(page, nodeSel("t1"))
  const link = '[aria-label="Edge from s to t1"]'
  let e = await ends(page, link)
  near(e.start.x, s.x + s.width)
  near(e.end.x, t1.x)

  // Drag t1 to the far left: both ends move to the facing sides.
  const grip = centre(t1)
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x - 760, grip.y + 20, { steps: 12 })
  await page.mouse.up()
  t1 = await box(page, nodeSel("t1"))
  expect(t1.x + t1.width).toBeLessThan(s.x)
  e = await ends(page, link)
  near(e.start.x, s.x)
  near(e.end.x, t1.x + t1.width)

  // Click-to-connect: the source's own body stays clickable, every other node takes the drop.
  const body = (id: string) =>
    page.locator(`${nodeSel(id)} .react-flow__handle[data-handleid="body"]`)
  await page.locator(dot("t2", "left")).click()
  await expect(body("t2")).toHaveCSS("pointer-events", "none")
  await expect(body("t3")).toHaveCSS("pointer-events", "all")
  await page.locator(dot("t2", "left")).click()
})

test("a board saved with old handle ids renders every edge and keeps them as stored", async ({
  page,
}) => {
  const agent = (name: string, leadId?: string) => ({
    name,
    model: "sonnet",
    leadId,
    branch: `lead/${name}`,
    worktree: `~/ceo/worktrees/${name}`,
  })
  const old: BoardEdge[] = [
    {
      id: "e-notes",
      source: "a",
      target: "b",
      data: { kind: "link", sourceHandle: "right", targetHandle: "left" },
    },
    {
      id: "e-diagram",
      source: "b",
      target: "d",
      data: { kind: "link", sourceHandle: "bottom", targetHandle: "top" },
    },
    {
      id: "e-agents",
      source: "lead",
      target: "member",
      data: { kind: "link", sourceHandle: "out", targetHandle: "in" },
    },
    {
      id: "e-hierarchy",
      source: "lead",
      target: "member",
      data: { kind: "hierarchy" },
    },
  ]
  const projectId = await seed(
    page,
    [
      note("a", 40, 40),
      note("b", 400, 40),
      node(
        "d",
        "diagram",
        400,
        260,
        { width: 300, height: 180 },
        {
          source: "flowchart LR\n  A --> B",
        }
      ),
      node("lead", "lead", 40, 480, null, agent("lead")),
      node("member", "member", 500, 560, null, agent("member", "lead")),
    ],
    old
  )
  await expect(page.locator(".react-flow__edge")).toHaveCount(old.length)
  for (const e of old) {
    const path = page
      .locator(`.react-flow__edge[data-id="${e.id}"] .react-flow__edge-path`)
      .first()
    await expect(path).toHaveAttribute("d", /^M ?-?\d/)
  }
  // The old agent link ends on the outline: lead's right side, member's left side.
  const lead = await box(page, nodeSel("lead"))
  const member = await box(page, nodeSel("member"))
  const e = await ends(page, '.react-flow__edge[data-id="e-agents"]')
  near(e.start.x, lead.x + lead.width)
  near(e.end.x, member.x)

  // Moving a node saves it, while the untouched edges stay exactly as stored.
  const grip = centre(await box(page, nodeSel("a")))
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x + 30, grip.y + 30, { steps: 5 })
  await page.mouse.up()
  const load = async () =>
    (await ipc(page, "board_load", { projectId })) as Board
  await expect
    .poll(async () => (await load()).nodes.find((n) => n.id === "a")?.x)
    .toBeGreaterThan(40)
  const saved = (await load()).edges.toSorted((x, y) =>
    x.id.localeCompare(y.id)
  )
  expect(saved).toEqual(old.toSorted((x, y) => x.id.localeCompare(y.id)))
})
