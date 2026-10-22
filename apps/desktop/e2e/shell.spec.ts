import { expect, test } from "@playwright/test"

test("shell expands and collapses with Cmd+B", async ({ page }, info) => {
  await page.goto("/")
  const shell = page.locator("[data-slot=app-shell]")
  await expect(shell).toHaveAttribute("data-sidebar", "expanded")
  await expect(page.getByText("No projects yet")).toBeVisible()
  await page.screenshot({ path: info.outputPath("expanded.png") })

  await page.keyboard.press("Meta+KeyB")
  await expect(shell).toHaveAttribute("data-sidebar", "collapsed")
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible()
  await expect(page.locator("[data-slot=sidebar]")).toHaveJSProperty(
    "offsetWidth",
    0
  )
  await page.screenshot({ path: info.outputPath("collapsed.png") })

  await page.keyboard.press("Meta+KeyB")
  await expect(shell).toHaveAttribute("data-sidebar", "expanded")
})

test("sidebar width survives a reload", async ({ page }) => {
  await page.goto("/")
  const handle = page.getByRole("separator", { name: "Resize sidebar" })
  await expect(handle).toHaveAttribute("aria-valuenow", "256")
  await handle.focus()
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowRight")
  await expect(handle).toHaveAttribute("aria-valuenow", "288")

  await page.reload()
  await expect(handle).toHaveAttribute("aria-valuenow", "288")
  await expect(page.locator("[data-slot=sidebar]")).toHaveJSProperty(
    "offsetWidth",
    288
  )
})

test("store commands reach the in-memory IPC mock", async ({ page }) => {
  await page.goto("/")
  const result = await page.evaluate(async () => {
    const url = "/src/lib/store/index.ts"
    const { store }: typeof import("../src/lib/store") = await import(url)
    const p = await store.createProject("demo", "/tmp/demo")
    await store.saveBoard(p.id, {
      upsertNodes: [
        {
          id: "n1",
          type: "note",
          x: 0,
          y: 0,
          width: null,
          height: null,
          data: {},
          z: 0,
        },
      ],
    })
    return {
      list: await store.listProjects(),
      board: await store.loadBoard(p.id),
    }
  })
  expect(result.list.map((p) => p.name)).toEqual(["demo"])
  expect(result.board.nodes.map((n) => n.id)).toEqual(["n1"])
})
