import { expect, type Page, test } from "@playwright/test"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Call = { cmd: string; id?: number; data?: string; cols?: number }
type Hook = {
  e2e: {
    terminals: Record<string, import("@xterm/xterm").Terminal>
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

const agents = (page: Page) =>
  page.locator(
    ".react-flow__node-ceo, .react-flow__node-lead, .react-flow__node-member"
  )
const node = (page: Page, name: string) =>
  agents(page).filter({ has: page.getByText(name, { exact: true }) })
const idOf = (page: Page, name: string) =>
  node(page, name).getAttribute("data-id") as Promise<string>

// The xterm buffer as text, read through the e2e hook.
const buffer = (page: Page, id: string) =>
  page.evaluate((id) => {
    const b = (window as unknown as Hook).e2e.terminals[id].buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++)
      lines.push(b.getLine(i)?.translateToString(true) ?? "")
    return lines.join("\n")
  }, id)

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as Hook).e2e.terminalCalls ?? [])
const count = async (page: Page, cmd: string) =>
  (await calls(page)).filter((c) => c.cmd === cmd).length

const viewport = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => el.style.transform)

// Node id of the element holding the keyboard, if it is inside an agent's terminal.
const typingIn = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest("[data-slot=node-terminal]")
        ?.closest(".react-flow__node")
        ?.getAttribute("data-id") ?? null
  )

test("every agent node runs a terminal: overview, focus, keys and delete", async ({
  page,
}, info) => {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  await ipc(page, "project_create", { name: "term", path: "/tmp/term" })
  await ipc(page, "project_create", { name: "other", path: "/tmp/other" })
  await page.reload()
  const project = (name: string) =>
    page.locator("ul[aria-label=Projects] button", { hasText: name }).click()
  await project("term")
  await page.getByRole("button", { name: "Seed team" }).click()
  await expect(agents(page)).toHaveCount(12)

  // One terminal per agent, each opened in the project folder.
  await expect(page.locator("[data-slot=node-terminal] .xterm")).toHaveCount(12)
  await expect.poll(() => count(page, "terminal_open")).toBe(12)
  expect((await calls(page))[0]).toMatchObject({ cwd: "/tmp/term" })
  const ceo = await idOf(page, "CEO")
  const lead = await idOf(page, "Board")

  // Overview is read-only: neither a click nor direct keyboard focus lets keys through.
  // The terminal passes the pointer through, so this click lands on the node.
  const out = await node(page, "CEO")
    .locator("[data-slot=node-terminal]")
    .boundingBox()
  if (!out) throw new Error("no terminal")
  await page.mouse.click(out.x + out.width / 2, out.y + out.height / 2)
  await page.keyboard.type("ls")
  await page.evaluate(
    (id) => (window as unknown as Hook).e2e.terminals[id].focus(),
    ceo
  )
  await page.keyboard.type("ls")
  expect(await count(page, "terminal_write")).toBe(0)
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } })

  // Overview close enough to read: 100% around the centre, then three steps out.
  await page.keyboard.press("Meta+0")
  for (const zoom of ["83%", "69%", "58%"]) {
    await page.getByRole("button", { name: "Zoom out" }).click()
    await expect(page.getByRole("button", { name: "Zoom to 100%" })).toHaveText(
      zoom
    )
  }
  await expect(node(page, "CEO")).toContainText("/tmp/term $")
  await page.mouse.move(0, 0)
  await page.screenshot({
    path: info.outputPath("overview.png"),
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Fit board" }).click()
  // Wait out the fit animation: two equal reads in a row.
  let last = ""
  await expect
    .poll(async () => {
      const [prev, now] = [last, await viewport(page)]
      last = now
      return prev === now
    })
    .toBe(true)

  // A note on the board gives Cmd+Z something to undo.
  await page.keyboard.press("n")
  const notes = page.locator(".react-flow__node-note")
  await expect(notes).toHaveCount(1)
  await page.keyboard.press("Escape")
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 300 } })

  // Focus button: zoom to 100%, the node grows, the keyboard goes to its shell.
  const overview = await viewport(page)
  await node(page, "CEO")
    .getByRole("button", { name: "Focus terminal" })
    .click()
  await expect.poll(() => viewport(page)).toMatch(/scale\(1\)/)
  await expect.poll(() => typingIn(page)).toBe(ceo)
  const board = await page.locator("[data-slot=board]").boundingBox()
  const box = await node(page, "CEO").boundingBox()
  expect(box?.width).toBeGreaterThan((board?.width ?? 0) - 40)
  await expect
    .poll(async () =>
      (await calls(page)).some(
        (c) => c.cmd === "terminal_resize" && (c.cols ?? 0) > 100
      )
    )
    .toBe(true)
  // A smaller window shrinks the focused node with it.
  await page.setViewportSize({ width: 1100, height: 760 })
  await expect
    .poll(async () => {
      const b = await page.locator("[data-slot=board]").boundingBox()
      const n = await node(page, "CEO").boundingBox()
      return Math.round((b?.width ?? 0) - (n?.width ?? 0))
    })
    .toBe(32)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.keyboard.type("echo one")
  await page.keyboard.press("Enter")
  await expect.poll(() => buffer(page, ceo)).toContain("echo one")

  // Plain Escape reaches the shell and keeps focus; board keys stay with the terminal.
  await page.keyboard.press("Escape")
  await expect
    .poll(async () => (await calls(page)).some((c) => c.data === "\x1b"))
    .toBe(true)
  await page.keyboard.press("n")
  await page.keyboard.press("Meta+z")
  await page.keyboard.press("Backspace")
  await expect(notes).toHaveCount(1)
  await expect(agents(page)).toHaveCount(12)
  expect(await typingIn(page)).toBe(ceo)
  expect(await viewport(page)).toMatch(/scale\(1\)/)

  await page.mouse.move(0, 0)
  await page.screenshot({
    path: info.outputPath("focus.png"),
    animations: "disabled",
  })

  // Cmd+C copies a selection, Cmd+K clears, as in #8.
  await page.evaluate((id) => {
    const w = window as unknown as { copied?: string }
    navigator.clipboard.writeText = async (t: string) => {
      w.copied = t
    }
    ;(window as unknown as Hook).e2e.terminals[id].selectAll()
  }, ceo)
  await page.keyboard.press("Meta+c")
  await expect
    .poll(() => page.evaluate(() => (window as { copied?: string }).copied))
    .toContain("echo one")

  await page.keyboard.press("Meta+k")
  await expect.poll(() => buffer(page, ceo)).not.toContain("echo one")

  // Next and previous agent without zooming out.
  await page.keyboard.press("Meta+Shift+BracketRight")
  await expect.poll(() => typingIn(page)).toBe(lead)
  expect(await viewport(page)).toMatch(/scale\(1\)/)
  await page.keyboard.type("two")
  await expect.poll(() => buffer(page, lead)).toContain("two")
  await page.keyboard.press("Meta+Shift+BracketLeft")
  await expect.poll(() => typingIn(page)).toBe(ceo)

  // Cmd+Escape restores the overview.
  await page.keyboard.press("Meta+Escape")
  await expect.poll(() => viewport(page)).toBe(overview)
  expect(await typingIn(page)).toBe(null)

  // Header double click focuses; a click on the board outside the node leaves.
  await node(page, "Board").locator("header").dblclick()
  await expect.poll(() => typingIn(page)).toBe(lead)
  const area = await page.locator("[data-slot=board]").boundingBox()
  if (!area) throw new Error("no board")
  await page.mouse.click(area.x + 6, area.y + area.height / 2)
  await expect.poll(() => viewport(page)).toBe(overview)
  expect(await typingIn(page)).toBe(null)

  // Deleting a Member closes its PTY; undo brings the node back with a fresh shell.
  const member = await idOf(page, "Notes")
  const closes = await count(page, "terminal_close")
  await node(page, "Notes").locator("header").click()
  await page.keyboard.press("Backspace")
  await expect(agents(page)).toHaveCount(11)
  await expect.poll(() => count(page, "terminal_close")).toBe(closes + 1)
  expect(
    await page.evaluate(
      (id) => id in (window as unknown as Hook).e2e.terminals,
      member
    )
  ).toBe(false)
  await page.keyboard.press("Meta+z")
  await expect(agents(page)).toHaveCount(12)
  await expect.poll(() => count(page, "terminal_open")).toBe(13)

  // Another project and back: the shells and their scrollback stay.
  await project("other")
  await expect(agents(page)).toHaveCount(0)
  await project("term")
  await expect(agents(page)).toHaveCount(12)
  await expect(node(page, "Board")).toContainText("two")
  expect(await count(page, "terminal_open")).toBe(13)
  expect(await count(page, "terminal_close")).toBe(closes + 1)
})
