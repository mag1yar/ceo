import { expect, type Page, test } from "@playwright/test"
import type { BoardNode } from "../src/lib/store"
import { card, cards, recordFrames, summarize } from "./frames"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = { __TAURI_INTERNALS__: Ipc; __saves: unknown[] }

const three = [card("a", 0, 0), card("b", 300, 0), card("c", 0, 200)]

// Seeds through the IPC mock, then reloads so the app mounts the board for the first project.
async function seed(page: Page, nodes: BoardNode[], viewport: object) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  await page.evaluate(
    async ({ nodes, viewport }) => {
      const ipc = (window as unknown as Win).__TAURI_INTERNALS__
      const p = (await ipc.invoke("project_create", {
        name: "board",
        path: "/tmp/board",
      })) as { id: string }
      await ipc.invoke("board_save", {
        projectId: p.id,
        changes: { upsertNodes: nodes, viewport },
      })
    },
    { nodes, viewport }
  )
  await page.reload()
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length)
}

// Reads the live transform React Flow applies, not app state.
async function matrix(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform))
}

async function viewport(page: Page) {
  const m = await matrix(page, ".react-flow__viewport")
  return { x: m.e, y: m.f, zoom: m.a }
}

async function position(page: Page, id: string) {
  const m = await matrix(page, `.react-flow__node[data-id="${id}"]`)
  return { x: m.e, y: m.f }
}

const zoomOf = async (page: Page) => (await viewport(page)).zoom
const selected = (page: Page) => page.locator(".react-flow__node.selected")

test("navigates like Miro: wheel, pinch, Cmd+wheel, space+drag, shortcuts, buttons", async ({
  page,
}, info) => {
  await seed(page, three, { x: 100, y: 100, zoom: 1 })
  const board = (await page.locator("[data-slot=board]").boundingBox()) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  const empty = { x: board.x + board.width - 150, y: board.y + 40 }
  await page.mouse.move(empty.x, empty.y)

  // Two-finger trackpad scroll arrives as a plain wheel event and pans 1:1.
  await page.mouse.wheel(60, 40)
  await expect.poll(() => viewport(page)).toEqual({ x: 40, y: 60, zoom: 1 })

  // Cmd+wheel zooms, clamped to 10%..400%.
  await page.keyboard.down("Meta")
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -500)
  await expect.poll(() => zoomOf(page)).toBe(4)
  await expect(page.getByRole("button", { name: "Zoom to 100%" })).toHaveText(
    "400%"
  )
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 500)
  await expect.poll(() => zoomOf(page)).toBe(0.1)
  await expect(page.getByRole("button", { name: "Zoom to 100%" })).toHaveText(
    "10%"
  )
  await page.keyboard.up("Meta")

  // Cmd+0 resets to 100%.
  await page.keyboard.press("Meta+Digit0")
  await expect.poll(() => zoomOf(page)).toBe(1)

  // A trackpad pinch reaches WebKit as a wheel event with ctrlKey set.
  await page.locator(".react-flow__pane").dispatchEvent("wheel", {
    deltaY: -50,
    ctrlKey: true,
    clientX: empty.x,
    clientY: empty.y,
  })
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1)
  await page.keyboard.press("Meta+Digit0")

  // Space+drag pans.
  const before = await viewport(page)
  await page.keyboard.down("Space")
  await page.mouse.move(empty.x, empty.y)
  await page.mouse.down()
  await page.mouse.move(empty.x - 120, empty.y + 80, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up("Space")
  await expect
    .poll(() => viewport(page))
    .toEqual({ x: before.x - 120, y: before.y + 80, zoom: 1 })
  await expect(selected(page)).toHaveCount(0)

  // Shift+1 fits every card into view.
  await page.mouse.wheel(3000, 3000)
  await expect(page.locator(".react-flow__node").first()).not.toBeInViewport()
  await page.keyboard.press("Shift+Digit1")
  for (const node of await page.locator(".react-flow__node").all())
    await expect(node).toBeInViewport({ ratio: 1 })

  // Zoom buttons in the corner.
  await page.keyboard.press("Meta+Digit0")
  await page.getByRole("button", { name: "Zoom in" }).click()
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.2)
  await page.getByRole("button", { name: "Zoom out" }).click()
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1)
  await page.getByRole("button", { name: "Zoom in" }).click()
  await page.getByRole("button", { name: "Zoom to 100%" }).click()
  await expect.poll(() => zoomOf(page)).toBe(1)
  await page.mouse.wheel(3000, 3000)
  await page.getByRole("button", { name: "Fit board" }).click()
  for (const node of await page.locator(".react-flow__node").all())
    await expect(node).toBeInViewport({ ratio: 1 })

  await page.getByText("Card a").click()
  await page.screenshot({ path: info.outputPath("board.png") })
})

test("selects with a marquee and Shift-click, deletes, undoes and redoes", async ({
  page,
}) => {
  await seed(page, three, { x: 100, y: 100, zoom: 1 })
  const board = await page.locator("[data-slot=board]").boundingBox()
  if (!board) throw new Error("no board")
  const at = (x: number, y: number) => ({ x: board.x + x, y: board.y + y })

  // Marquee around a and b (screen 100..576 x 100..140), not c (y 300).
  const from = at(60, 60)
  const to = at(640, 220)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await page.mouse.up()
  await expect(selected(page)).toHaveCount(2)
  await expect(page.locator('.react-flow__node[data-id="c"]')).not.toHaveClass(
    /selected/
  )

  // Click the pane to clear, then click a and Shift-click c.
  await page.mouse.click(at(700, 400).x, at(700, 400).y)
  await expect(selected(page)).toHaveCount(0)
  await page.getByText("Card a").click()
  await page.getByText("Card c").click({ modifiers: ["Shift"] })
  await expect(selected(page)).toHaveCount(2)
  await expect(page.locator('.react-flow__node[data-id="b"]')).not.toHaveClass(
    /selected/
  )

  // Shortcuts stay off while typing.
  await page.evaluate(() =>
    document.body.append(document.createElement("input"))
  )
  await page.locator("body > input").focus()
  await page.keyboard.press("Delete")
  await page.keyboard.press("Shift+Digit1")
  await page.keyboard.press("Meta+KeyZ")
  await expect(page.locator(".react-flow__node")).toHaveCount(3)
  expect(await viewport(page)).toEqual({ x: 100, y: 100, zoom: 1 })
  await page.locator("body > input").evaluate((el) => el.remove())

  await page.keyboard.press("Delete")
  await expect(page.locator(".react-flow__node")).toHaveCount(1)
  await page.keyboard.press("Meta+KeyZ")
  await expect(page.locator(".react-flow__node")).toHaveCount(3)
  await page.keyboard.press("Meta+Shift+KeyZ")
  await expect(page.locator(".react-flow__node")).toHaveCount(1)
  await page.keyboard.press("Meta+KeyZ")
  await expect(page.locator(".react-flow__node")).toHaveCount(3)

  // A drag is one undo step.
  await page.mouse.click(at(700, 400).x, at(700, 400).y)
  await page.getByText("Card b").hover()
  await page.mouse.down()
  await page.mouse.move(at(600, 300).x, at(600, 300).y, { steps: 5 })
  await page.mouse.up()
  expect(await position(page, "b")).not.toEqual({ x: 300, y: 0 })
  await page.keyboard.press("Meta+KeyZ")
  await expect.poll(() => position(page, "b")).toEqual({ x: 300, y: 0 })

  // An arrow-key nudge of the focused selection is its own undo step.
  await page.getByText("Card b").click()
  await page.keyboard.press("ArrowRight")
  await expect.poll(() => position(page, "b")).toEqual({ x: 305, y: 0 })
  await page.keyboard.press("Meta+KeyZ")
  await expect.poll(() => position(page, "b")).toEqual({ x: 300, y: 0 })
})

test("saves in debounced batches and restores viewport and nodes after reload", async ({
  page,
}) => {
  await seed(page, three, { x: 100, y: 100, zoom: 1 })
  await page.evaluate(() => {
    const w = window as unknown as Win
    const invoke = w.__TAURI_INTERNALS__.invoke
    w.__saves = []
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "board_save") w.__saves.push(args)
      return invoke(cmd, args)
    }
  })
  const saves = () =>
    page.evaluate(() => (window as unknown as Win).__saves) as Promise<
      { changes: { upsertNodes?: BoardNode[]; viewport?: object } }[]
    >

  // About a second of dragging, 30 frames: no writes until the drag settles, then one.
  await page.getByText("Card a").hover()
  await page.mouse.down()
  const a = await page.getByText("Card a").boundingBox()
  if (!a) throw new Error("no card")
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(a.x + 10 + i * 5, a.y + 10 + i * 3)
    await page.waitForTimeout(30)
  }
  expect(await saves()).toHaveLength(0)
  await page.mouse.up()
  await expect.poll(async () => (await saves()).length).toBe(1)
  const [drag] = await saves()
  expect(drag.changes.upsertNodes?.map((n) => n.id)).toEqual(["a"])
  expect(drag.changes.viewport).toBeUndefined()
  const moved = await position(page, "a")

  await page.mouse.move(a.x + 400, a.y + 300)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(20, 10)
  await expect.poll(async () => (await saves()).length).toBe(2)
  const panned = await viewport(page)
  expect(panned).toEqual({ x: -100, y: 0, zoom: 1 })

  await page.reload()
  await expect(page.locator(".react-flow__node")).toHaveCount(3)
  expect(await viewport(page)).toEqual(panned)
  expect(await position(page, "a")).toEqual(moved)
  expect(await position(page, "b")).toEqual({ x: 300, y: 0 })
})

test("pans 300 cards and reports frame timing", async ({ page }, info) => {
  await seed(page, cards(300), { x: 50, y: 100, zoom: 0.5 })
  const before = await viewport(page)
  const idle = summarize(
    await page.evaluate(recordFrames, { ms: 1000, pan: false })
  )
  const pan = summarize(
    await page.evaluate(recordFrames, { ms: 3000, pan: true })
  )
  const summary = `idle: ${idle}; pan 300 nodes: ${pan}`
  info.annotations.push({ type: "fps", description: summary })
  console.log(`[${info.project.name}] ${summary}`)
  // Report only: WebKit caps rAF at 30 fps when the machine is busy, so a threshold would flake.
  // The circle ends where it began whenever the frame count is a multiple of 60, so one straight step proves the save.
  await page.evaluate(() =>
    document
      .querySelector(".react-flow__pane")
      ?.dispatchEvent(
        new WheelEvent("wheel", { deltaX: 40, bubbles: true, cancelable: true })
      )
  )
  // The viewport saves on a debounce after the pan ends.
  await expect.poll(() => viewport(page)).not.toEqual(before)
})
