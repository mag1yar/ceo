import { expect, type Page, test } from "@playwright/test"
import type { Board } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = { __TAURI_INTERNALS__: Ipc }

// An empty board for a fresh project at zoom 1.
async function emptyBoard(page: Page) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const id = await page.evaluate(async () => {
    const ipc = (window as unknown as Win).__TAURI_INTERNALS__
    const p = (await ipc.invoke("project_create", {
      name: "diagrams",
      path: "/tmp/diagrams",
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

// Fill of the first flowchart node shape and colour of its label.
const colours = (page: Page) =>
  page.locator("[data-slot=diagram] svg").evaluate((svg) => {
    const shape = svg.querySelector(".node :is(rect, path, polygon)")
    const label = svg.querySelector(".node .nodeLabel, .node text")
    return {
      fill: shape ? getComputedStyle(shape).fill : "",
      text: label ? getComputedStyle(label).color : "",
    }
  })

const viewport = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate((el) => getComputedStyle(el).transform)

const settle = (page: Page) => page.waitForTimeout(400)

test("diagrams: lazy mermaid, render, error keeps the last SVG, theme, reload", async ({
  page,
}, info) => {
  const mermaidRequests: string[] = []
  page.on("request", (r) => {
    if (/\/deps\/mermaid|mermaid\.core/.test(r.url()))
      mermaidRequests.push(r.url())
  })
  const projectId = await emptyBoard(page)
  await page.waitForLoadState("networkidle")
  expect(mermaidRequests).toEqual([])

  // Created from the toolbar with the example flowchart; only now does mermaid load.
  await page.getByRole("button", { name: "Diagram", exact: true }).click()
  const node = page.locator(".react-flow__node-diagram")
  await expect(node).toHaveCount(1)
  const svg = node.locator("[data-slot=diagram] svg")
  await expect(svg).toBeVisible({ timeout: 20000 })
  expect(mermaidRequests.length).toBeGreaterThan(0)
  for (const word of ["Idea", "Plan", "Ship"])
    await expect(svg).toContainText(word)
  const before = await colours(page)
  expect(before.fill).toMatch(/^rgb/)

  await settle(page)
  await page.screenshot({ path: info.outputPath("diagram.png") })

  // Double-click opens the source editor next to the preview.
  await node.locator("[data-slot=diagram]").dblclick()
  const editor = page.getByRole("textbox", { name: "Diagram source" })
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue(/^flowchart LR/)

  // Wheel inside the editor does not pan the board.
  const vp = await viewport(page)
  await editor.hover()
  await page.mouse.wheel(0, 200)
  expect(await viewport(page)).toBe(vp)

  // A syntax error shows under the editor while the last good SVG stays.
  await editor.fill("flowchart LR\n  Idea --> Plan\n  Plan --> (")
  const error = page.getByRole("alert")
  await expect(error).toContainText(/error/i)
  await expect(svg).toContainText("Ship")
  // Clicking into the error keeps the editor open.
  await error.click()
  await expect(editor).toHaveCount(1)
  await settle(page)
  await page.screenshot({ path: info.outputPath("diagram-error.png") })

  // Fixing it renders the new source; Cmd+Enter commits and closes.
  const fixed = "flowchart LR\n  Idea --> Plan\n  Plan --> Review"
  await editor.fill(fixed)
  await expect(error).toHaveCount(0)
  await expect(svg).toContainText("Review")
  await expect(svg).not.toContainText("Ship")
  await page.keyboard.press("Meta+Enter")
  await expect(editor).toHaveCount(0)
  await expect
    .poll(async () => (await stored(page, projectId)).nodes)
    .toMatchObject([{ type: "diagram", data: { source: fixed } }])

  // The diagram follows the colour scheme.
  const scheme = info.project.name === "dark" ? "dark" : "light"
  const fixedColours = await colours(page)
  await page.emulateMedia({
    colorScheme: scheme === "dark" ? "light" : "dark",
  })
  await expect.poll(() => colours(page)).not.toEqual(fixedColours)
  const flipped = await colours(page)
  expect(flipped.fill).not.toBe(fixedColours.fill)
  expect(flipped.text).not.toBe(fixedColours.text)
  await page.emulateMedia({ colorScheme: scheme })
  await expect.poll(() => colours(page)).toEqual(fixedColours)

  // The source survives a reload.
  await page.reload()
  await expect(svg).toContainText("Review", { timeout: 20000 })
  await node.locator("[data-slot=diagram]").dblclick()
  await expect(editor).toHaveValue(fixed)
})
