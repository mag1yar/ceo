import { expect, type Page, test } from "@playwright/test"
import type { Board } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Box = { x: number; y: number; width: number; height: number }

const ipc = (page: Page, cmd: string, args?: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: Ipc }
      ).__TAURI_INTERNALS__.invoke(cmd as string, args as object),
    [cmd, args] as const
  )

const STATUSES = ["idle", "working", "waiting", "error", "done"]
const agents = (page: Page) =>
  page.locator(
    ".react-flow__node-ceo, .react-flow__node-lead, .react-flow__node-member"
  )
const node = (page: Page, name: string) =>
  agents(page).filter({ has: page.getByText(name, { exact: true }) })

// Creates an empty project, then seeds the team through the dev-only control.
async function seedTeam(page: Page, { freeze }: { freeze: boolean }) {
  // Holds the 3 s status timer still so assertions and screenshots see one fixed mix.
  if (freeze)
    await page.addInitScript(() => {
      const setInterval = window.setInterval
      window.setInterval = ((fn: TimerHandler, ms?: number, ...a: unknown[]) =>
        ms === 3000 ? 0 : setInterval(fn, ms, ...a)) as typeof setInterval
    })
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const { id } = (await ipc(page, "project_create", {
    name: "agents",
    path: "/tmp/agents",
  })) as { id: string }
  await page.reload()
  await page.getByRole("button", { name: "Seed team" }).click()
  await expect(agents(page)).toHaveCount(12)
  await expect(page.locator(".react-flow__edge")).toHaveCount(11)
  return id
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
const dist = (a: Box, b: Box) =>
  Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y)
const box = async (page: Page, id: string) =>
  (await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .boundingBox()) as Box

function union(boxes: Box[], pad: number) {
  const x = Math.min(...boxes.map((b) => b.x)) - pad
  const y = Math.min(...boxes.map((b) => b.y)) - pad
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + pad
  const btm = Math.max(...boxes.map((b) => b.y + b.height)) + pad
  return { x, y, width: r - x, height: btm - y }
}

test("seeds a radial team with every status, inspects an agent and refuses Member to CEO", async ({
  page,
}, info) => {
  const projectId = await seedTeam(page, { freeze: true })
  const board = (await ipc(page, "board_load", { projectId })) as Board
  const byType = (t: string) => board.nodes.filter((n) => n.type === t)
  const [ceo] = byType("ceo")
  const leads = byType("lead")
  expect(leads).toHaveLength(3)
  expect(
    board.edges.every((e) => (e.data as { kind: string }).kind === "hierarchy")
  ).toBe(true)

  // CEO at the centre: every Lead sits at the same distance from it.
  const ceoBox = await box(page, ceo.id)
  const leadBoxes = await Promise.all(leads.map((l) => box(page, l.id)))
  const radii = leadBoxes.map((l) => dist(ceoBox, l))
  expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(4)
  // Each Member is nearer its own Lead than any other Lead, and 2-3 per team.
  for (const [i, lead] of leads.entries()) {
    const team = byType("member").filter(
      (m) => (m.data as { leadId: string }).leadId === lead.id
    )
    expect(team.length).toBeGreaterThanOrEqual(2)
    expect(team.length).toBeLessThanOrEqual(3)
    for (const m of team) {
      const mb = await box(page, m.id)
      const own = dist(mb, leadBoxes[i])
      for (const [j, other] of leadBoxes.entries())
        if (j !== i) expect(own).toBeLessThan(dist(mb, other))
    }
  }

  for (const s of STATUSES)
    await expect(page.locator(`[data-status=${s}]`).first()).toBeVisible()
  const shot = { animations: "disabled" } as const
  await page
    .locator("[data-slot=board]")
    .screenshot({ ...shot, path: info.outputPath("team.png") })

  // Close-up: zoom in on one agent of each status and frame them.
  const pick = async () =>
    Promise.all(
      STATUSES.map(
        async (s) =>
          (await page
            .locator(`.react-flow__node:has([data-status=${s}])`)
            .first()
            .boundingBox()) as Box
      )
    )
  let picked = union(await pick(), 24)
  await page.mouse.move(centre(picked).x, centre(picked).y)
  await page.keyboard.down("Meta")
  for (let i = 0; i < 20 && picked.height < 600; i++) {
    await page.mouse.wheel(0, -40)
    picked = union(await pick(), 24)
  }
  await page.keyboard.up("Meta")
  // Then pan them to the middle of the board so nothing is cut off.
  const area = (await page.locator("[data-slot=board]").boundingBox()) as Box
  await page.mouse.wheel(
    centre(picked).x - centre(area).x,
    centre(picked).y - centre(area).y
  )
  await expect
    .poll(async () => centre(union(await pick(), 24)).y)
    .toBeCloseTo(centre(area).y, 0)
  picked = union(await pick(), 24)
  await page.screenshot({
    ...shot,
    path: info.outputPath("statuses.png"),
    clip: picked,
  })
  await page.getByRole("button", { name: "Fit board" }).click()

  // The inspector shows the selected agent.
  await node(page, "Notes").click()
  const inspector = page.getByRole("complementary", { name: "Agent inspector" })
  await expect(inspector.getByRole("heading")).toHaveText("Notes")
  await expect(inspector).toContainText("Member")
  await expect(inspector).toContainText("Sonnet")
  await expect(inspector).toContainText("lead/board/notes")
  await expect(inspector).toContainText("~/ceo/worktrees/board-notes")
  const status = await node(page, "Notes")
    .locator("[data-status]")
    .getAttribute("data-status")
  await expect(inspector).toContainText(
    `Status${status?.replace(/^./, (c) => c.toUpperCase())}`
  )
  await expect(
    inspector.getByRole("button", { name: "Open terminal" })
  ).toBeDisabled()
  await page.screenshot({ ...shot, path: info.outputPath("inspector.png") })
  await node(page, "Board").click()
  await expect(inspector.getByRole("heading")).toHaveText("Board")
  await expect(inspector).toContainText("Lead")
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } })
  await expect(inspector).toHaveCount(0)

  // Drag from a Member's handle: isValidConnection marks only its own Lead and teammates valid.
  const handle = (name: string, kind: "source" | "target") =>
    node(page, name).locator(`.react-flow__handle.${kind}`)
  async function tryConnect(from: string, to: string) {
    const a = (await handle(from, "source").boundingBox()) as Box
    const b = (await handle(to, "target").boundingBox()) as Box
    await page.mouse.move(centre(a).x, centre(a).y)
    await page.mouse.down()
    await page.mouse.move(centre(b).x, centre(b).y, { steps: 8 })
    const target = handle(to, "target")
    await expect(target).toHaveClass(/connectingto/)
    const valid = await target.evaluate((el) => el.classList.contains("valid"))
    await page.mouse.up()
    return valid
  }
  expect(await tryConnect("Notes", "CEO")).toBe(false)
  expect(await tryConnect("Notes", "Terminal")).toBe(false)
  expect(await tryConnect("Notes", "Board")).toBe(true)
  expect(await tryConnect("Notes", "Edges")).toBe(true)
  expect(await tryConnect("Board", "Terminal")).toBe(true)
  expect(await tryConnect("CEO", "Board")).toBe(true)
  // 11 seeded hierarchy edges plus the four valid links drawn above.
  await expect(page.locator(".react-flow__edge")).toHaveCount(15)
})

test("statuses change on a timer while all five stay on the board", async ({
  page,
}) => {
  await seedTeam(page, { freeze: false })
  const snapshot = () =>
    agents(page).evaluateAll((els) =>
      els.map((el) =>
        el.querySelector("[data-status]")?.getAttribute("data-status")
      )
    )
  const before = await snapshot()
  await expect.poll(snapshot, { timeout: 10000 }).not.toEqual(before)
  const after = await snapshot()
  for (const s of STATUSES) expect(after).toContain(s)
})

test("keeps a dragged agent's position and the hierarchy edges after reload", async ({
  page,
}) => {
  const projectId = await seedTeam(page, { freeze: true })
  const target = node(page, "Store tests")
  const id = (await target.getAttribute("data-id")) as string
  const start = (await target.boundingBox()) as Box
  await page.mouse.move(start.x + 20, start.y + 10)
  await page.mouse.down()
  await page.mouse.move(start.x - 100, start.y + 140, { steps: 8 })
  await page.mouse.up()
  const saved = async () =>
    ((await ipc(page, "board_load", { projectId })) as Board).nodes.find(
      (n) => n.id === id
    )
  const seeded = await saved()
  const moved = (await target.boundingBox()) as Box
  expect(Math.round(moved.x)).not.toBe(Math.round(start.x))
  await expect.poll(async () => (await saved())?.x).not.toBe(seeded?.x)
  const position = await saved()

  await page.reload()
  await expect(agents(page)).toHaveCount(12)
  await expect(page.locator(".react-flow__edge")).toHaveCount(11)
  expect(await saved()).toEqual(position)
  const transform = await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform))
  // Computed transforms are single precision.
  expect(transform.e).toBeCloseTo(position?.x ?? Number.NaN, 3)
  expect(transform.f).toBeCloseTo(position?.y ?? Number.NaN, 3)
})
