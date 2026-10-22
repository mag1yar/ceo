import { expect, type Page, test } from "@playwright/test"
import type { Board } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = { __TAURI_INTERNALS__: Ipc }

// An empty board for a fresh project at zoom 1, so screen and flow distances match.
async function emptyBoard(page: Page) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const id = await page.evaluate(async () => {
    const ipc = (window as unknown as Win).__TAURI_INTERNALS__
    const p = (await ipc.invoke("project_create", {
      name: "notes",
      path: "/tmp/notes",
    })) as { id: string }
    await ipc.invoke("board_save", {
      projectId: p.id,
      changes: { viewport: { x: 0, y: 0, zoom: 1 } },
    })
    return p.id
  })
  await page.reload()
  await expect(page.locator(".react-flow__pane")).toBeVisible()
  return id
}

const stored = (page: Page, projectId: string) =>
  page.evaluate(
    (projectId) =>
      (window as unknown as Win).__TAURI_INTERNALS__.invoke("board_load", {
        projectId,
      }) as Promise<Board>,
    projectId
  )

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

// shortcut: a fixed wait for entry transitions before a screenshot; poll getAnimations() if it flakes.
const settle = (page: Page) => page.waitForTimeout(400)

test("notes: create three ways, edit markdown, resize, recolour, link with a label, undo, reload", async ({
  page,
}, info) => {
  const projectId = await emptyBoard(page)
  const board = await box(page, "[data-slot=board]")
  const at = (x: number, y: number) => ({ x: board.x + x, y: board.y + y })
  const notes = page.locator(".react-flow__node-note")
  const edges = page.locator(".react-flow__edge")
  const editor = page.getByRole("textbox", { name: "Note text" })

  // 1. Double-click on the empty board opens a new note in edit mode; Esc leaves it.
  await page.mouse.dblclick(at(200, 200).x, at(200, 200).y)
  await expect(notes).toHaveCount(1)
  await expect(editor).toBeFocused()
  await page.keyboard.type("# Plan\n\n- one\n- two")
  await page.keyboard.press("Escape")
  await expect(editor).toHaveCount(0)
  const plan = notes.filter({ hasText: "Plan" })
  await expect(plan.getByRole("heading", { name: "Plan" })).toBeVisible()
  await expect(plan.getByRole("listitem")).toHaveText(["one", "two"])

  // Double-click edits in place; a click outside leaves.
  await plan.getByRole("heading").dblclick()
  await expect(editor).toHaveValue("# Plan\n\n- one\n- two")
  await page.keyboard.type("\n- three")
  await page.mouse.click(at(900, 600).x, at(900, 600).y)
  await expect(plan.getByRole("listitem")).toHaveCount(3)

  // 2. N at the board centre; shortcuts stay off while the note is being edited.
  await page.keyboard.press("n")
  await expect(notes).toHaveCount(2)
  await expect(editor).toBeFocused()
  await page.keyboard.type("Second n")
  await expect(notes).toHaveCount(2)
  await page.keyboard.press("Escape")
  const second = notes.filter({ hasText: "Second n" })
  await expect(second).toBeVisible()

  // 3. The toolbar button, after a pan so it lands clear of the second note.
  await page.mouse.move(at(900, 600).x, at(900, 600).y)
  await page.mouse.wheel(0, -260)
  await page.getByRole("button", { name: "Note", exact: true }).click()
  await expect(notes).toHaveCount(3)
  await page.keyboard.type("Third")
  await page.keyboard.press("Escape")
  const third = notes.filter({ hasText: "Third" })

  // Resize the third note from its bottom-right corner.
  await third.click()
  const before = await third.boundingBox()
  const corner = await box(
    page,
    ".react-flow__node-note.selected .react-flow__resize-control.handle.bottom.right"
  )
  await page.mouse.move(
    corner.x + corner.width / 2,
    corner.y + corner.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(corner.x + 80, corner.y + 50, { steps: 5 })
  await page.mouse.up()
  const resized = await third.boundingBox()
  expect(resized?.width).toBeGreaterThan((before?.width ?? 0) + 60)
  expect(resized?.height).toBeGreaterThan((before?.height ?? 0) + 30)

  // Recolour the first note from its toolbar.
  await plan.click()
  await page.getByRole("button", { name: "yellow colour" }).click()
  await expect(plan.locator("[data-color]")).toHaveAttribute(
    "data-color",
    "yellow"
  )

  // Link the first note to the second: drag from its right edge to the second's left edge.
  await plan.hover()
  const from = await box(page, `${await sel(plan)} .react-flow__handle-right`)
  const to = await box(page, `${await sel(second)} .react-flow__handle-left`)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 10,
  })
  await page.mouse.up()
  await expect(edges).toHaveCount(1)

  // Double-click the edge to label it.
  await page.locator(".react-flow__edge-interaction").dblclick()
  await page.getByRole("textbox", { name: "Edge label" }).fill("depends on")
  await page.keyboard.press("Enter")
  const label = page.locator("[data-slot=edge-label]")
  await expect(label).toHaveText("depends on")
  await expect
    .poll(async () => (await stored(page, projectId)).edges)
    .toMatchObject([{ data: { kind: "link", label: "depends on" } }])

  // Delete the edge, then undo and redo the edge and its label.
  // Clicking the label selects its edge.
  await label.click()
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1)
  await page.keyboard.press("Delete")
  await expect(edges).toHaveCount(0)
  await page.keyboard.press("Meta+KeyZ")
  await expect(label).toHaveText("depends on")
  await page.keyboard.press("Meta+KeyZ")
  await expect(edges).toHaveCount(1)
  await expect(label).toHaveCount(0)
  await page.keyboard.press("Meta+KeyZ")
  await expect(edges).toHaveCount(0)
  await page.keyboard.press("Meta+Shift+KeyZ")
  await page.keyboard.press("Meta+Shift+KeyZ")
  await expect(label).toHaveText("depends on")

  // Undo and redo note creation.
  await page.mouse.click(at(900, 600).x, at(900, 600).y)
  await page.keyboard.press("n")
  await page.keyboard.press("Escape")
  await expect(notes).toHaveCount(4)
  await page.keyboard.press("Meta+KeyZ")
  await expect(notes).toHaveCount(3)
  await page.keyboard.press("Meta+Shift+KeyZ")
  await expect(notes).toHaveCount(4)
  await page.keyboard.press("Meta+KeyZ")
  await expect(notes).toHaveCount(3)
  await expect(edges).toHaveCount(1)

  await plan.click()
  await settle(page)
  await page.screenshot({ path: info.outputPath("notes.png") })

  // Everything survives a reload: notes, size, colour, the edge and its label.
  const size = await third.boundingBox()
  await expect
    .poll(async () => (await stored(page, projectId)).nodes.length)
    .toBe(3)
  await page.reload()
  await expect(notes).toHaveCount(3)
  await expect(plan.getByRole("heading", { name: "Plan" })).toBeVisible()
  await expect(plan.getByRole("listitem")).toHaveCount(3)
  await expect(plan.locator("[data-color]")).toHaveAttribute(
    "data-color",
    "yellow"
  )
  expect(await third.boundingBox()).toEqual(size)
  await expect(edges).toHaveCount(1)
  await expect(label).toHaveText("depends on")
  const saved = await stored(page, projectId)
  expect(saved.edges).toHaveLength(1)
  expect(saved.edges[0].data).toMatchObject({ kind: "link" })
})

// A stable selector for a node found by its text.
async function sel(node: ReturnType<Page["locator"]>) {
  return `.react-flow__node[data-id="${await node.getAttribute("data-id")}"]`
}
