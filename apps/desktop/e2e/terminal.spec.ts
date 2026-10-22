import { expect, type Page, test } from "@playwright/test"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Call = { cmd: string; id?: number; cols?: number; rows?: number }
type Hook = {
  e2e: {
    terminals: Record<number, import("@xterm/xterm").Terminal>
    terminalCalls?: Call[]
  }
}

const ipc = (page: Page, cmd: string, args?: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: Ipc }
      ).__TAURI_INTERNALS__.invoke(cmd as string, args as object),
    [cmd, args] as const
  )

// The xterm buffer as text, read through the e2e hook (the canvas has no DOM text).
const buffer = (page: Page, key: number) =>
  page.evaluate((key) => {
    const b = (window as unknown as Hook).e2e.terminals[key].buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++)
      lines.push(b.getLine(i)?.translateToString(true) ?? "")
    return lines.join("\n")
  }, key)

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as Hook).e2e.terminalCalls ?? [])

const focusedIn = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement?.closest(s), selector)

const dock = (page: Page) => page.locator("[data-slot=terminal-dock]")
const panel = (page: Page, key: number) => page.locator(`#terminal-${key}`)
const agent = (page: Page, type: string) =>
  page.locator(`.react-flow__node-${type}`).first()

test("opens terminals from an agent, types, switches, hides, resizes and closes", async ({
  page,
}, info) => {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  await ipc(page, "project_create", { name: "term", path: "/tmp/term" })
  await page.reload()
  await page.evaluate(() => {
    ;(window as unknown as Hook).e2e = { terminals: {} }
  })
  await page.getByRole("button", { name: "Seed team" }).click()
  await expect(page.locator(".react-flow__node-member")).not.toHaveCount(0)

  // From the inspector.
  await agent(page, "ceo").click()
  await page.getByRole("button", { name: "Open terminal" }).click()
  const tabs = dock(page).getByRole("tab")
  await expect(tabs).toHaveCount(1)
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true")
  await expect(panel(page, 1)).toBeVisible()
  await expect.poll(() => focusedIn(page, "#terminal-1")).toBe(true)
  // Focus moved into the terminal: typing reaches the (mock) PTY and its echo comes back.
  await page.keyboard.type("echo one")
  await page.keyboard.press("Enter")
  await expect.poll(() => buffer(page, 1)).toContain("echo one")
  expect((await calls(page))[0]).toMatchObject({
    cmd: "terminal_open",
    cwd: "/tmp/term",
  })

  // From the node context menu.
  await agent(page, "lead").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Open terminal" }).click()
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
  await expect(panel(page, 1)).toBeHidden()
  await expect(panel(page, 2)).toBeVisible()
  await expect.poll(() => focusedIn(page, "#terminal-2")).toBe(true)
  await page.keyboard.type("two")
  await expect.poll(() => buffer(page, 2)).toContain("two")
  expect(await buffer(page, 1)).not.toContain("two")

  await page.mouse.move(0, 0)
  await page.screenshot({
    path: info.outputPath("dock-two-tabs.png"),
    animations: "disabled",
  })

  // Switch back: the first terminal shows and takes the keyboard.
  await tabs.first().click()
  await expect(panel(page, 1)).toBeVisible()
  await expect(panel(page, 2)).toBeHidden()
  await expect.poll(() => focusedIn(page, "#terminal-1")).toBe(true)
  await page.keyboard.type("!")
  await expect.poll(() => buffer(page, 1)).toContain("!")

  // Cmd+K clears the scrollback; Cmd+C with a selection copies it.
  await page.keyboard.type("keep")
  await page.evaluate(() => {
    const w = window as unknown as { copied?: string }
    navigator.clipboard.writeText = async (t: string) => {
      w.copied = t
    }
    ;(window as unknown as Hook).e2e.terminals[1].selectAll()
  })
  await page.keyboard.press("Meta+c")
  await expect
    .poll(() => page.evaluate(() => (window as { copied?: string }).copied))
    .toContain("echo one")
  // A paste event goes through xterm to the PTY.
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "pasted")
    document
      .querySelector("#terminal-1 textarea")
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  })
  await expect.poll(() => buffer(page, 1)).toContain("pasted")

  // Hiding keeps the terminal and its scrollback; focus returns to the board.
  await dock(page).getByRole("button", { name: "Hide terminals" }).click()
  await expect(panel(page, 1)).toBeHidden()
  await expect(tabs).toHaveCount(2)
  expect(await focusedIn(page, "[data-slot=terminal-dock]")).toBe(false)
  await page.keyboard.press("Control+Backquote")
  await expect(panel(page, 1)).toBeVisible()
  await expect.poll(() => focusedIn(page, "#terminal-1")).toBe(true)
  expect(await buffer(page, 1)).toContain("echo one")

  await page.keyboard.press("Meta+k")
  await expect.poll(() => buffer(page, 1)).not.toContain("echo one")

  // Dragging the top edge up grows the dock; the fit addon resizes the PTY.
  const rowsBefore = await page.evaluate(
    () => (window as unknown as Hook).e2e.terminals[1].rows
  )
  const handle = page.locator("[data-slot=terminal-resize-handle]")
  const h = await handle.boundingBox()
  if (!h) throw new Error("no resize handle")
  await page.mouse.move(h.x + 200, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 200, h.y - 150, { steps: 6 })
  await page.mouse.up()
  await expect
    .poll(async () =>
      (await calls(page)).some(
        (c) =>
          c.cmd === "terminal_resize" &&
          c.id === 1 &&
          (c.rows ?? 0) > rowsBefore
      )
    )
    .toBe(true)
  const stored = await page.evaluate(() =>
    Number(localStorage.getItem("ceo.terminal.height"))
  )
  expect(stored).toBeGreaterThan(280 + 100)

  const closed = (id: number) =>
    expect
      .poll(async () =>
        (await calls(page)).some(
          (c) => c.cmd === "terminal_close" && c.id === id
        )
      )
      .toBe(true)
  const close = (name: string) =>
    dock(page)
      .getByRole("button", { name: `Close ${name}` })
      .click()

  // Closing a background tab kills its PTY and leaves the selection alone.
  await tabs.nth(1).hover()
  await close("Board")
  await expect(tabs).toHaveCount(1)
  await closed(2)
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true")

  // Closing the selected tab moves to its neighbour.
  await page.getByRole("button", { name: "Open terminal" }).click()
  await expect(tabs).toHaveCount(2)
  await tabs.first().click()
  await close("CEO")
  await closed(1)
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true")
  await expect(panel(page, 3)).toBeVisible()

  // Removing the project takes its terminals with it.
  await page
    .locator("ul[aria-label=Projects] button")
    .first()
    .click({ button: "right" })
  await page.getByRole("menuitem", { name: "Remove from list…" }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove" })
    .click()
  await expect(dock(page)).toHaveCount(0)
  await closed(3)
})
