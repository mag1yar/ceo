import { expect, type Page, test } from "@playwright/test"
import { buildTeam } from "../src/features/agents/team"
import type { Message } from "../src/features/messages/messages"
import type { BoardEdge, BoardNode } from "../src/lib/store"
import { card, cards, recordFrames, summarize } from "./frames"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = {
  __TAURI_INTERNALS__: Ipc
  __ceoBus: { emit: (m: Message) => Promise<void> }
}
type Box = { x: number; y: number; width: number; height: number }

const plain = (source: string, target: string): BoardEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  data: { kind: "hierarchy" },
})

// Seeds a project through the IPC mock and reloads so the board mounts it; no viewport means fit view.
async function seed(
  page: Page,
  nodes: BoardNode[],
  edges: BoardEdge[],
  viewport?: object
) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const id = await page.evaluate(
    async ({ nodes, edges, viewport }) => {
      const ipc = (window as unknown as Win).__TAURI_INTERNALS__
      const p = (await ipc.invoke("project_create", {
        name: "messages",
        path: "/tmp/messages",
      })) as { id: string }
      await ipc.invoke("board_save", {
        projectId: p.id,
        changes: { upsertNodes: nodes, upsertEdges: edges, viewport },
      })
      return p.id
    },
    { nodes, edges, viewport }
  )
  await page.reload()
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length)
  return id
}

// Pushes one state change through the mocked `bus://message` event, as the Rust bus will.
function bus(page: Page, projectId: string) {
  let at = 1
  return (m: Pick<Message, "id" | "from" | "to"> & Partial<Message>) =>
    page.evaluate((m) => (window as unknown as Win).__ceoBus.emit(m), {
      projectId,
      thread: m.id,
      kind: "send",
      state: "sent",
      sentAt: at,
      waitingAt: at++,
      ...m,
    } as Message)
}

const signal = (page: Page, id: string) =>
  page.locator(`[data-slot=signal][data-message="${id}"]`)

const signalAnimations = (page: Page) =>
  page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            (a.effect as KeyframeEffect | null)?.target?.closest(
              "[data-slot=signals]"
            ) && a.playState === "running"
        ).length
  )

const centre = async (page: Page, sel: string) => {
  const b = (await page.locator(sel).boundingBox()) as Box
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
const nodeBox = async (page: Page, id: string) =>
  (await page
    .locator(`.react-flow__node[data-id="${id}"]`)
    .boundingBox()) as Box

// Cards a and b joined by a hierarchy edge, c and d with no edge to b, all at zoom 1.
const scene = (page: Page) =>
  seed(
    page,
    [
      card("a", 0, 0),
      card("b", 500, 0),
      card("c", 0, 300),
      card("d", 500, 300),
    ],
    [plain("a", "b")],
    { x: 100, y: 100, zoom: 1 }
  )

test("a signal travels the edge, waits at the receiver, then is absorbed", async ({
  page,
}) => {
  const send = bus(page, await scene(page))
  await send({ id: "m", from: "a", to: "b" })
  const dot = signal(page, "m")
  await expect(dot).toHaveAttribute("data-state", "sent")
  expect(await signalAnimations(page)).toBe(1)
  // Held at fixed moments of the flight, so the check does not race the clock.
  const seek = (progress: number) =>
    page.evaluate((progress) => {
      for (const a of document.getAnimations()) {
        a.pause()
        a.currentTime = progress * Number(a.effect?.getTiming().duration)
      }
    }, progress)
  const x = async () => (await centre(page, '[data-message="m"] span')).x
  const a = await nodeBox(page, "a")
  const b = await nodeBox(page, "b")
  await seek(0)
  const start = await x()
  expect(start - (a.x + a.width)).toBeGreaterThanOrEqual(-1)
  expect(start - (a.x + a.width)).toBeLessThan(4)
  await seek(0.5)
  const mid = await x()
  expect(mid).toBeGreaterThan(start + 50)
  expect(mid).toBeLessThan(b.x - 50)
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.play()
  })

  await send({ id: "m", from: "a", to: "b", state: "waiting" })
  await expect(dot).toHaveAttribute("data-state", "waiting")
  await expect.poll(() => signalAnimations(page)).toBe(0)
  // Stops just outside the receiver's left border, on the edge line.
  const stop = await centre(page, '[data-message="m"] span')
  expect(b.x - stop.x).toBeGreaterThan(8)
  expect(b.x - stop.x).toBeLessThan(20)
  expect(Math.abs(stop.y - (b.y + b.height / 2))).toBeLessThan(2)

  await send({ id: "m", from: "a", to: "b", state: "accepted" })
  await expect(dot).toHaveAttribute("data-state", "accepted")
  await expect(dot).toHaveCount(0)
  await expect(page.locator("[data-slot=signal]")).toHaveCount(0)
})

test("three waiting at one receiver fold into one marker with count 3, over a temporary path", async ({
  page,
}) => {
  const send = bus(page, await scene(page))
  for (const from of ["a", "c", "d"])
    await send({ id: from, from, to: "b", state: "waiting" })
  const shown = page.locator(
    "[data-slot=signal][data-state=waiting]:not([data-count='0'])"
  )
  await expect(shown).toHaveCount(1)
  await expect(shown).toHaveAttribute("data-count", "3")
  await expect(shown).toHaveText("3")
  for (const folded of await page
    .locator("[data-slot=signal][data-count='0']")
    .all())
    await expect(folded).toHaveCSS("opacity", "0")
  // c and d have no edge to b: one dashed path each while their messages live.
  const temp = page.locator("[data-slot=signal-path]")
  await expect(temp).toHaveCount(2)
  await expect(temp.first()).toHaveAttribute("stroke-dasharray", "4 4")

  await send({ id: "a", from: "a", to: "b", state: "accepted" })
  await expect(shown).toHaveText("2")
  await send({ id: "c", from: "c", to: "b", state: "accepted" })
  await expect(temp).toHaveCount(1)
  await expect(shown).toHaveAttribute("data-count", "1")
  await send({ id: "d", from: "d", to: "b", state: "accepted" })
  await expect(temp).toHaveCount(0)
  await expect(page.locator("[data-slot=signal]")).toHaveCount(0)
})

test("an ask is a diamond and its sender waits until the reply is accepted", async ({
  page,
}) => {
  const send = bus(page, await scene(page))
  await send({ id: "s", from: "c", to: "d" })
  await send({ id: "q", thread: "t", kind: "ask", from: "a", to: "b" })
  const look = (id: string) =>
    signal(page, id)
      .locator("span")
      .evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          rotate: s.rotate,
          radius: s.borderRadius,
          bg: s.backgroundColor,
        }
      })
  const ask = await look("q")
  const dot = await look("s")
  expect(ask.rotate).toBe("45deg")
  expect(dot.rotate).not.toBe("45deg")
  expect(ask.radius).not.toBe(dot.radius)
  expect(ask.bg).not.toBe(dot.bg)

  // The anchor is a zero-size point; the pill inside it is what shows.
  const waiting = page.locator("[data-slot=ask-waiting][data-node=a] span")
  await expect(waiting).toHaveText("Waiting for reply")
  await send({
    id: "q",
    thread: "t",
    kind: "ask",
    from: "a",
    to: "b",
    state: "waiting",
  })
  await send({
    id: "q",
    thread: "t",
    kind: "ask",
    from: "a",
    to: "b",
    state: "accepted",
  })
  await expect(signal(page, "q")).toHaveCount(0)
  await expect(waiting).toBeVisible()
  const reply = {
    id: "r",
    thread: "t",
    kind: "reply",
    from: "b",
    to: "a",
  } as const
  await send(reply)
  await send({ ...reply, state: "waiting" })
  await expect(waiting).toBeVisible()
  await send({ ...reply, state: "accepted" })
  await expect(waiting).toHaveCount(0)
})

test("reduced motion shows a still marker at the receiver end, no travel", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  const send = bus(page, await scene(page))
  await send({ id: "m", from: "a", to: "b" })
  await send({ id: "n", from: "c", to: "b" })
  await send({ id: "n", from: "c", to: "b", state: "waiting" })
  await send({ id: "o", from: "d", to: "b", state: "waiting" })
  await expect(signal(page, "m").locator("span")).toBeVisible()
  expect(await signalAnimations(page)).toBe(0)
  const b = await nodeBox(page, "b")
  const at = await centre(page, '[data-message="m"] span')
  expect(b.x - at.x).toBeGreaterThan(8)
  expect(b.x - at.x).toBeLessThan(20)
  await expect(page.locator("[data-slot=signal][data-count='2']")).toHaveText(
    "2"
  )
})

test("30 signals in flight while panning 300 cards: frame timing", async ({
  page,
}, info) => {
  // Long edges across a row (2200 flow px), so every signal is still travelling while frames are recorded.
  const from = [0, 20, 40].flatMap((row) =>
    Array.from({ length: 10 }, (_, i) => row + i)
  )
  const edges = from.map((i) => plain(`n${i}`, `n${i + 10}`))
  const projectId = await seed(page, cards(300), edges, {
    x: 50,
    y: 100,
    zoom: 0.5,
  })
  // All 30 in one task, as simultaneous bus events would land.
  const flight = (round: number) =>
    page.evaluate(
      (ms) =>
        Promise.all(ms.map((m) => (window as unknown as Win).__ceoBus.emit(m))),
      edges.map(
        (e): Message => ({
          id: `${e.id}-${round}`,
          projectId,
          from: e.source,
          to: e.target,
          thread: e.id,
          kind: "send",
          state: "sent",
          sentAt: round,
        })
      )
    )
  await flight(1)
  expect(await signalAnimations(page)).toBe(30)
  const still = summarize(
    await page.evaluate(recordFrames, { ms: 1000, pan: false })
  )
  await expect.poll(() => signalAnimations(page)).toBe(0)
  await flight(2)
  expect(await signalAnimations(page)).toBe(30)
  const pan = summarize(
    await page.evaluate(recordFrames, { ms: 1000, pan: true })
  )
  const summary = `30 signals: ${still}; 30 signals + pan 300 nodes: ${pan}`
  info.annotations.push({ type: "fps", description: summary })
  console.log(`[${info.project.name}] ${summary}`)
})

// One fitted team, as the owner sees it: transit, a waiting stack and an ask.
test("screenshots: a signal in transit, a waiting stack, an ask", async ({
  page,
}, info) => {
  const team = buildTeam()
  const send = bus(page, await seed(page, team.nodes, team.edges))
  const [ceo, ...rest] = team.nodes
  const leads = rest.filter((n) => n.type === "lead")
  const members = (lead: string) =>
    rest.filter((n) => (n.data as { leadId?: string }).leadId === lead)

  for (const lead of leads)
    await send({ id: `go-${lead.id}`, from: ceo.id, to: lead.id })
  // Hold every signal halfway so the shot is deterministic.
  await page.evaluate(() =>
    document.getAnimations().forEach((a) => {
      a.pause()
      a.currentTime = 400
    })
  )
  const board = page.locator("[data-slot=board]")
  await board.screenshot({ path: info.outputPath("signal-transit.png") })

  for (const lead of leads)
    await send({
      id: `go-${lead.id}`,
      from: ceo.id,
      to: lead.id,
      state: "accepted",
    })
  await expect(page.locator("[data-slot=signal]")).toHaveCount(0)
  for (const m of members(leads[0].id))
    await send({
      id: `r-${m.id}`,
      kind: "report",
      from: m.id,
      to: leads[0].id,
      state: "waiting",
    })
  await send({
    id: "q",
    kind: "ask",
    from: leads[1].id,
    to: ceo.id,
    state: "waiting",
  })
  await expect.poll(() => signalAnimations(page)).toBe(0)
  await board.screenshot({ path: info.outputPath("signal-stack-ask.png") })

  // Close-up of the ask and its blocked sender.
  const a = await nodeBox(page, leads[1].id)
  const c = await nodeBox(page, ceo.id)
  const x = Math.min(a.x, c.x) - 40
  const y = Math.min(a.y, c.y) - 40
  await page.screenshot({
    path: info.outputPath("signal-ask.png"),
    clip: {
      x,
      y,
      width: Math.max(a.x + a.width, c.x + c.width) + 40 - x,
      height: Math.max(a.y + a.height, c.y + c.height) + 40 - y,
    },
  })
})
