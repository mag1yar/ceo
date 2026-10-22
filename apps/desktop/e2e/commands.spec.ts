import { expect, type Page, test } from "@playwright/test"
import { COMMANDS } from "../src/features/commands/registry"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Hook = {
  e2e: { terminals: Record<string, import("@xterm/xterm").Terminal> }
}

const ipc = (page: Page, cmd: string, args?: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: Ipc }
      ).__TAURI_INTERNALS__.invoke(cmd as string, args as object),
    [cmd, args] as const
  )

// shortcut: a fixed wait for the dialog fade before a screenshot; poll getAnimations() if it flakes.
const settle = (page: Page) => page.waitForTimeout(300)

async function open(page: Page, ...names: string[]) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  for (const name of names)
    await ipc(page, "project_create", { name, path: `/tmp/${name}` })
  await page.reload()
  await expect(page.locator(".react-flow")).toBeVisible()
}

const palette = (page: Page) =>
  page.getByRole("dialog", { name: "Command palette" })
const help = (page: Page) =>
  page.getByRole("dialog", { name: "Keyboard shortcuts" })
const shell = (page: Page) => page.locator("[data-slot=app-shell]")
const notes = (page: Page) => page.locator(".react-flow__node-note")
const diagrams = (page: Page) => page.locator(".react-flow__node-diagram")
const zoom = (page: Page) => page.getByRole("button", { name: "Zoom to 100%" })
const row = (page: Page, name: string) =>
  page.locator("ul[aria-label=Projects] button", { hasText: name })
// Hands the keyboard back to the board, out of any editor.
const toBoard = (page: Page) =>
  page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } })

async function run(page: Page, query: string) {
  await page.keyboard.press("Meta+KeyK")
  await expect(palette(page)).toBeVisible()
  await page.keyboard.type(query)
  await page.keyboard.press("Enter")
  await expect(palette(page)).toBeHidden()
}

test("Cmd+K palette filters and runs every command", async ({ page }, info) => {
  await open(page, "alpha", "beta")
  await expect(row(page, "alpha")).toHaveAttribute("aria-current", "page")

  await page.keyboard.press("Meta+KeyK")
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole("option")).toContainText([
    "Add project…",
    "Toggle sidebar",
    "Fit board",
    "alpha",
    "beta",
  ])
  // Rows carry their shortcut as keycaps; the palette does not list itself.
  await expect(
    palette(page).getByRole("option", { name: "Toggle sidebar" })
  ).toContainText("⌘B")
  await expect(
    palette(page).getByRole("option", { name: "Command palette" })
  ).toHaveCount(0)
  await settle(page)
  await page.screenshot({ path: info.outputPath("palette.png") })

  // Typing filters; Enter runs the top match.
  await page.keyboard.type("bet")
  await expect(palette(page).getByRole("option")).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(palette(page)).toBeHidden()
  await expect(row(page, "beta")).toHaveAttribute("aria-current", "page")

  // Cmd+K again closes it from its own input.
  await page.keyboard.press("Meta+KeyK")
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press("Meta+KeyK")
  await expect(palette(page)).toBeHidden()

  await run(page, "new note")
  await expect(notes(page)).toHaveCount(1)
  await toBoard(page)
  await run(page, "new diagram")
  await expect(diagrams(page)).toHaveCount(1)
  await toBoard(page)

  await page.getByRole("button", { name: "Zoom out" }).click()
  await page.getByRole("button", { name: "Zoom out" }).click()
  const zoomedOut = await zoom(page).textContent()
  await run(page, "fit board")
  await expect(zoom(page)).not.toHaveText(zoomedOut ?? "")
  await run(page, "zoom to 100")
  await expect(zoom(page)).toHaveText("100%")

  await run(page, "undo")
  await expect(diagrams(page)).toHaveCount(0)
  await run(page, "redo")
  await expect(diagrams(page)).toHaveCount(1)

  await run(page, "toggle sidebar")
  await expect(shell(page)).toHaveAttribute("data-sidebar", "collapsed")
  await run(page, "toggle sidebar")
  await expect(shell(page)).toHaveAttribute("data-sidebar", "expanded")

  // The mocked folder dialog picks the next folder.
  await page.evaluate(() =>
    Object.assign(window, {
      e2e: {
        ...(window as unknown as Hook).e2e,
        folder: "/tmp/gamma",
        gitFolders: ["/tmp/gamma"],
      },
    })
  )
  await run(page, "add project")
  await expect(row(page, "gamma")).toHaveAttribute("aria-current", "page")
})

test("shortcuts run the same commands; ? and Cmd+/ list the registry", async ({
  page,
}, info) => {
  await open(page, "alpha")

  await page.keyboard.press("Meta+KeyB")
  await expect(shell(page)).toHaveAttribute("data-sidebar", "collapsed")
  await page.keyboard.press("Meta+KeyB")
  await expect(shell(page)).toHaveAttribute("data-sidebar", "expanded")

  await page.keyboard.press("KeyN")
  await expect(notes(page)).toHaveCount(1)
  await toBoard(page)
  await page.keyboard.press("Meta+KeyZ")
  await expect(notes(page)).toHaveCount(0)
  await page.keyboard.press("Meta+Shift+KeyZ")
  await expect(notes(page)).toHaveCount(1)

  await page.getByRole("button", { name: "Zoom out" }).click()
  await page.keyboard.press("Meta+Digit0")
  await expect(zoom(page)).toHaveText("100%")
  await page.keyboard.press("Shift+Digit1")
  await expect(zoom(page)).not.toHaveText("100%")

  await page.keyboard.press("Meta+Digit0")
  await page.keyboard.press("Shift+Slash")
  await expect(help(page)).toBeVisible()
  for (const c of COMMANDS.filter((c) => c.shortcuts))
    await expect(help(page)).toContainText(c.title)
  await expect(help(page).getByRole("listitem")).toHaveCount(
    COMMANDS.filter((c) => c.shortcuts).length
  )
  await settle(page)
  await page.screenshot({ path: info.outputPath("help.png") })
  await page.keyboard.press("Escape")
  await expect(help(page)).toBeHidden()

  await page.keyboard.press("Meta+Slash")
  await expect(help(page)).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(help(page)).toBeHidden()
})

test("shortcuts stay out of the way while typing", async ({ page }) => {
  await open(page, "alpha")
  // Every app shortcut that the field would otherwise lose.
  async function pressAll() {
    for (const key of [
      "Meta+KeyK",
      "Meta+KeyB",
      "Shift+Slash",
      "Meta+Slash",
      "KeyN",
      "Shift+Digit1",
    ])
      await page.keyboard.press(key)
  }
  async function nothingHappened(nodes: number) {
    await expect(palette(page)).toBeHidden()
    await expect(help(page)).toBeHidden()
    await expect(shell(page)).toHaveAttribute("data-sidebar", "expanded")
    await expect(page.locator(".react-flow__node")).toHaveCount(nodes)
  }

  // Project rename input.
  await row(page, "alpha").dblclick()
  const rename = page.getByRole("textbox", { name: "Project name" })
  await expect(rename).toBeFocused()
  await pressAll()
  await nothingHappened(0)
  await expect(rename).toHaveValue(/\?n!$/)
  await page.keyboard.press("Escape")

  // Note editor.
  await toBoard(page)
  await page.keyboard.press("KeyN")
  await page.locator(".react-flow__node-note").dblclick()
  const note = page.getByRole("textbox", { name: "Note text" })
  await expect(note).toBeFocused()
  await pressAll()
  await nothingHappened(1)
  await expect(note).toHaveValue(/\?n!$/)
  await page.keyboard.press("Escape")

  // Diagram editor.
  await toBoard(page)
  await page.getByRole("button", { name: "Diagram", exact: true }).click()
  await diagrams(page).locator("[data-slot=diagram]").dblclick()
  const source = page.getByRole("textbox", { name: "Diagram source" })
  await expect(source).toBeFocused()
  await pressAll()
  await nothingHappened(2)
  await page.keyboard.press("Escape")

  // A focused terminal: Cmd+K clears it and the palette stays closed.
  await toBoard(page)
  await page.getByRole("button", { name: "Seed team" }).click()
  const ceo = page
    .locator(".react-flow__node-ceo")
    .filter({ has: page.getByText("CEO", { exact: true }) })
  await ceo.getByRole("button", { name: "Focus terminal" }).click()
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea")
      )
    )
    .toBe(true)
  const id = (await ceo.getAttribute("data-id")) as string
  const buffer = () =>
    page.evaluate((id) => {
      const b = (window as unknown as Hook).e2e.terminals[id].buffer.active
      const lines: string[] = []
      for (let i = 0; i < b.length; i++)
        lines.push(b.getLine(i)?.translateToString(true) ?? "")
      return lines.join("\n")
    }, id)
  await page.keyboard.type("echo kept")
  await page.keyboard.press("Enter")
  await expect.poll(buffer).toContain("echo kept")
  const nodes = await page.locator(".react-flow__node").count()
  await page.keyboard.press("Meta+KeyK")
  await expect.poll(buffer).not.toContain("echo kept")
  await pressAll()
  await nothingHappened(nodes)
  // The focus mode keys still work inside it.
  await page.keyboard.press("Meta+Escape")
  await expect(
    ceo.getByRole("button", { name: "Focus terminal" })
  ).toBeVisible()
})
