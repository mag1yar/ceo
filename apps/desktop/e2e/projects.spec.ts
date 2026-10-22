import { expect, type Page, test } from "@playwright/test"

// What the mocked folder dialog returns next, and which folders count as git repos.
function nextFolder(page: Page, folder: string, gitFolders: string[] = []) {
  return page.evaluate((e2e) => Object.assign(window, { e2e }), {
    folder,
    gitFolders,
  })
}

// shortcut: a fixed wait for CSS and motion animations to finish before a screenshot; poll getAnimations() if it flakes.
const settle = (page: Page) => page.waitForTimeout(500)

function storedNames(page: Page) {
  return page.evaluate(async () => {
    const url = "/src/lib/store/index.ts"
    const { store }: typeof import("../src/lib/store") = await import(url)
    return (await store.listProjects()).map((p) => p.name)
  })
}

test("projects: add, rename, reorder, switch and remove", async ({
  page,
}, info) => {
  await page.goto("/")
  const main = page.locator("[data-slot=main-content]")
  const list = page.getByRole("list", { name: "Projects" })
  const rows = list.getByRole("button")
  const names = list.locator("li .truncate")

  await expect(
    page.getByRole("heading", { name: "Start with a project folder" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Add project" })).toHaveCount(1)
  await settle(page)
  await page.screenshot({ path: info.outputPath("empty.png") })

  await nextFolder(page, "/Users/me/code/alpha", ["/Users/me/code/alpha"])
  await page.getByRole("button", { name: "Add project" }).click()
  await expect(names).toHaveText(["alpha"])
  await expect(rows.first()).toHaveAttribute("aria-current", "page")
  await expect(main.locator(".react-flow")).toBeVisible()

  await nextFolder(page, "/Users/me/notes")
  await page.getByRole("button", { name: "Add project" }).click()
  const warning = page.getByRole("alertdialog")
  await expect(warning).toContainText("“notes” is not a git repository")
  await settle(page)
  await page.screenshot({ path: info.outputPath("non-git-warning.png") })
  await warning.getByRole("button", { name: "Add anyway" }).click()
  await expect(warning).toBeHidden()
  await expect(list.getByRole("button", { name: "notes" })).toHaveAttribute(
    "aria-current",
    "page"
  )

  // The same folder again selects the existing project instead of adding a copy.
  await nextFolder(page, "/Users/me/code/alpha", ["/Users/me/code/alpha"])
  await page.getByRole("button", { name: "Add project" }).click()
  await expect(rows).toHaveCount(2)
  await expect(list.getByRole("button", { name: "alpha" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await page.mouse.move(800, 400)
  await settle(page)
  await page.screenshot({ path: info.outputPath("two-projects.png") })

  await list.getByRole("button", { name: "alpha" }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const input = page.getByRole("textbox", { name: "Project name" })
  await expect(input).toBeFocused()
  await input.fill("Alpha app")
  await input.press("Enter")
  await expect(list.getByRole("button", { name: "Alpha app" })).toBeFocused()
  expect(await storedNames(page)).toEqual(["Alpha app", "notes"])

  await list.getByRole("button", { name: "notes" }).click()
  await expect(list.getByRole("button", { name: "notes" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(page.locator("[data-slot=main-header] h1")).toHaveAttribute(
    "title",
    "/Users/me/notes"
  )

  // Pointer steps a frame apart, as a hand moves: motion reads drags once per frame.
  const from = await rows.nth(0).boundingBox()
  if (!from) throw new Error("rows are not laid out")
  const x = from.x + 40
  const y = from.y + from.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let dy = 4; dy <= 40; dy += 4) {
    await page.mouse.move(x, y + dy)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await expect(names).toHaveText(["notes", "Alpha app"])
  await expect.poll(() => storedNames(page)).toEqual(["notes", "Alpha app"])
  // The click that ends the drop does not switch projects.
  await expect(list.getByRole("button", { name: "notes" })).toHaveAttribute(
    "aria-current",
    "page"
  )

  await list.getByRole("button", { name: "notes" }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Remove from list…" }).click()
  const confirm = page.getByRole("alertdialog")
  await expect(confirm).toContainText("Files on disk are not touched")
  await confirm.getByRole("button", { name: "Remove" }).click()
  await expect(names).toHaveText(["Alpha app"])
  expect(await storedNames(page)).toEqual(["Alpha app"])
  // Removing the active project opens its neighbour.
  await expect(list.getByRole("button", { name: "Alpha app" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  await expect(main.locator(".react-flow")).toBeVisible()
})
