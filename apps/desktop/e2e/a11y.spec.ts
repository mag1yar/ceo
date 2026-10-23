import { expect, type Page, test } from "@playwright/test"
import { buildTeam } from "../src/features/agents/team"
import type { BoardEdge, BoardNode } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }

const ipc = (page: Page, cmd: string, args?: object) =>
  page.evaluate(
    ([cmd, args]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: Ipc }
      ).__TAURI_INTERNALS__.invoke(cmd as string, args as object),
    [cmd, args] as const
  )

const team = buildTeam()
const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
const member = team.nodes.find((n) => n.type === "member") as BoardNode
const note = (id: string, x: number, color: string, text: string) => ({
  id,
  type: "note",
  x,
  y: 360,
  width: 220,
  height: 140,
  data: { text, color },
  z: 0,
})
// One of each board item: two agents and their team line, notes on light and dark tints, a diagram and a labelled link.
const nodes: BoardNode[] = [
  { ...ceo, x: 0, y: 0 },
  { ...member, x: 700, y: 0 },
  note("empty", 0, "yellow", ""),
  note("plan", 260, "purple", "# Plan\n- one\n- two"),
  {
    id: "chart",
    type: "diagram",
    x: 520,
    y: 360,
    width: 360,
    height: 200,
    data: { source: "flowchart LR\n  Idea --> Ship" },
    z: 0,
  },
]
const edges: BoardEdge[] = [
  { id: "team", source: ceo.id, target: member.id, data: { kind: "team" } },
  {
    id: "link",
    source: "empty",
    target: "plan",
    data: { kind: "link", label: "depends on" },
  },
]

async function seedBoard(page: Page) {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const p = (await ipc(page, "project_create", {
    name: "audit",
    path: "/tmp/audit",
  })) as { id: string }
  await ipc(page, "board_save", {
    projectId: p.id,
    changes: {
      upsertNodes: nodes,
      upsertEdges: edges,
      viewport: { x: 40, y: 80, zoom: 0.6 },
    },
  })
  await page.reload()
  await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length)
  await expect(page.locator("[data-slot=diagram] svg")).toBeVisible()
}

// Runs in the page: every visible text below WCAG AA against what is really behind it.
// The sidebar sits on native vibrancy, which a headless page cannot draw, so a neutral sidebar material stands in.
function contrastFailures() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D
  // The browser parses any CSS colour (oklch, color-mix results) into sRGB for us.
  const rgba = (color: string) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "#0000"
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (top: number[], bottom: number[]) =>
    [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]))
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const sidebar = dark ? [48, 48, 48] : [232, 232, 232]
  const page = dark ? [30, 30, 30] : [255, 255, 255]

  function background(el: Element) {
    const layers: number[][] = []
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
      if (e.matches("[data-slot=sidebar]")) {
        layers.push([...sidebar, 1])
        break
      }
    }
    let base = page
    for (const layer of layers.reverse()) base = over(layer, base)
    return base
  }

  const skip =
    ".xterm, [data-slot=diagram] svg, .sr-only, :disabled, [aria-disabled=true], [data-disabled]"
  const failures: string[] = []
  let checked = 0
  for (const el of document.body.querySelectorAll("*")) {
    const own = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
    )
    if (!own || el.closest(skip)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight)
      continue
    if (
      !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
      continue
    const style = getComputedStyle(el)
    let opacity = 1
    for (let e: Element | null = el; e; e = e.parentElement)
      opacity *= Number(getComputedStyle(e).opacity)
    const fg = rgba(style.color)
    fg[3] *= opacity
    const bg = background(el)
    const value = ratio(over(fg, bg), bg)
    const size = Number.parseFloat(style.fontSize)
    const large =
      size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
    checked++
    if (value < (large ? 3 : 4.5))
      failures.push(
        `"${el.textContent?.trim().slice(0, 40)}" ${value.toFixed(2)}:1 (${style.color})`
      )
  }
  return { checked, failures }
}

async function expectContrast(page: Page, screen: string) {
  const { checked, failures } = await page.evaluate(contrastFailures)
  console.log(
    `[${test.info().project.name}] contrast ${screen}: ${checked} texts, ${failures.length} below AA`
  )
  expect(checked).toBeGreaterThan(0)
  expect(failures, screen).toEqual([])
}

const FOCUSABLE =
  'a[href], button, input, textarea, [tabindex]:not([tabindex="-1"])'

// Runs in the page: each focusable element's look (outline, ring, background, border, down two levels) before the next Tab.
function rememberLooks(selector: string) {
  const look = (el: Element, depth: number): string => {
    const s = getComputedStyle(el)
    const own = [
      s.outlineStyle,
      s.outlineWidth,
      s.stroke,
      s.strokeWidth,
      s.boxShadow,
      s.backgroundColor,
      s.borderColor,
    ].join("|")
    if (!depth) return own
    return [own, ...[...el.children].map((c) => look(c, depth - 1))].join("/")
  }
  const w = window as unknown as {
    looks: WeakMap<Element, string>
    look: typeof look
  }
  w.look = look
  w.looks = new WeakMap()
  for (const el of document.querySelectorAll(selector))
    w.looks.set(el, look(el, 2))
}

type Stop = { name: string; visible: boolean; tag: string }

// Tabs through the page; every stop must look different from its unfocused self and have an accessible name.
async function tabWalk(page: Page, steps: number) {
  const stops: Stop[] = []
  for (let i = 0; i < steps; i++) {
    await page.evaluate(rememberLooks, FOCUSABLE)
    await page.keyboard.press("Tab")
    // Rings and handle bars transition in over --duration-fast to --duration-base.
    await page.waitForTimeout(260)
    const focused = page.locator(":focus")
    await expect(focused).toHaveCount(1)
    await expect(focused).toHaveAccessibleName(/\S/)
    const name = (await focused.evaluate((el) => {
      const label = el.getAttribute("aria-label")
      // Visible text without aria-hidden parts (the project initials).
      const copy = el.cloneNode(true) as Element
      for (const hidden of copy.querySelectorAll("[aria-hidden]"))
        hidden.remove()
      return label ?? copy.textContent?.trim().slice(0, 40) ?? ""
    })) as string
    const { visible, tag } = await focused.evaluate((el) => {
      const w = window as unknown as {
        looks: WeakMap<Element, string>
        look: (el: Element, depth: number) => string
      }
      const before = w.looks.get(el)
      return {
        visible: before !== undefined && before !== w.look(el, 2),
        tag: el.tagName.toLowerCase(),
      }
    })
    stops.push({ name, visible, tag })
  }
  return stops
}

function report(screen: string, stops: Stop[]) {
  console.log(
    `[${test.info().project.name}] tab ${screen}: ${stops.map((s) => `${s.name}${s.visible ? "" : " (NO RING)"}`).join(" > ")}`
  )
  expect(
    stops.filter((s) => !s.visible).map((s) => s.name),
    `${screen}: stops without a visible focus`
  ).toEqual([])
}

// Every button without visible text carries an aria-label.
async function expectIconButtonsLabelled(page: Page) {
  const unlabelled = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .filter((b) => b.checkVisibility() && !b.textContent?.trim())
      .filter((b) => !b.getAttribute("aria-label")?.trim())
      .map((b) => b.outerHTML.slice(0, 80))
  )
  expect(unlabelled).toEqual([])
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    animations: "disabled",
    path: test.info().outputPath(`${name}.png`),
  })

test("empty state: tab order, focus, labels, contrast", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Start with a project folder")).toBeVisible()
  await expectIconButtonsLabelled(page)
  await expectContrast(page, "empty state")
  await shot(page, "screen-empty")
  const stops = await tabWalk(page, 3)
  report("empty state", stops)
  // On screen order: the sidebar button by the traffic lights, the sidebar edge, then the main action.
  expect(stops.map((s) => s.name)).toEqual([
    "Hide sidebar",
    "Resize sidebar",
    "Add project",
  ])
})

test("board: tab order, focus, labels, keyboard editing, contrast", async ({
  page,
}) => {
  await seedBoard(page)
  await expectIconButtonsLabelled(page)
  await expectContrast(page, "board")
  await shot(page, "screen-board")

  const stops = await tabWalk(page, 18)
  report("board", stops)
  const names = stops.map((s) => s.name)
  const at = (name: string) => names.indexOf(name)
  // Shell first, then the board's items, then its panels.
  expect(at("Hide sidebar")).toBe(0)
  expect(at("Add project")).toBe(1)
  expect(at("audit")).toBe(2)
  expect(at("Resize sidebar")).toBe(3)
  for (const item of [
    "CEO, CEO",
    "Note",
    "Diagram",
    "Link: depends on",
    "Team line",
  ])
    expect(names, item).toContain(item)
  expect(at("Zoom out")).toBeGreaterThan(at("Diagram"))
  expect(names).not.toContain("depends on")

  // Enter on a focused note opens its editor; Escape commits and hands the keyboard back to the note.
  const empty = page.locator('.react-flow__node[data-id="empty"]')
  await empty.focus()
  await page.keyboard.press("Enter")
  const editor = page.getByRole("textbox", { name: "Note text" })
  await expect(editor).toBeFocused()
  await page.keyboard.type("Typed")
  await page.keyboard.press("Escape")
  await expect(empty).toBeFocused()
  await expect(empty).toContainText("Typed")

  // The same for a diagram and a link's label.
  const chart = page.locator('.react-flow__node[data-id="chart"]')
  await chart.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("textbox", { name: "Diagram source" })
  ).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(chart).toBeFocused()
  const link = page.locator('.react-flow__edge[data-id="link"]')
  await link.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("textbox", { name: "Edge label" })).toBeFocused()
  await page.keyboard.type("blocks")
  await page.keyboard.press("Enter")
  await expect(link).toBeFocused()
  // VoiceOver's name follows the edited label; the label itself is no extra Tab stop.
  await expect(link).toHaveAttribute("aria-label", "Link: blocks")

  // The inspector of a selected agent, Tokens row included.
  await page
    .locator(".react-flow__node-ceo")
    .getByText("CEO", { exact: true })
    .first()
    .click()
  const inspector = page.getByRole("complementary", { name: "Agent inspector" })
  await expect(inspector.locator("[data-slot=usage]")).toBeVisible()
  await expectContrast(page, "inspector")
  await shot(page, "screen-inspector")

  // A focused terminal.
  await page
    .locator(".react-flow__node-ceo")
    .getByRole("button", { name: "Focus terminal" })
    .click()
  await expect(
    page.locator(".react-flow__node-ceo [data-focused]")
  ).toHaveCount(1)
  await page.waitForTimeout(400)
  await expectContrast(page, "terminal focus")
  await shot(page, "screen-terminal")
})

test("palette, dialogs and menus: focus, labels, contrast", async ({
  page,
}) => {
  await seedBoard(page)

  await page.keyboard.press("Meta+KeyK")
  const input = page.getByRole("combobox")
  await expect(input).toBeFocused()
  // The palette field shows the same ring as any other input.
  await expect
    .poll(() =>
      input.evaluate(
        (el) =>
          getComputedStyle(el.closest("[data-slot=input-group]") as Element)
            .boxShadow
      )
    )
    .not.toBe("none")
  await expectContrast(page, "command palette")
  await shot(page, "screen-palette")
  await page.keyboard.press("Escape")

  await page.keyboard.press("Meta+Slash")
  await expect(
    page.getByRole("dialog", { name: "Keyboard shortcuts" })
  ).toBeVisible()
  await page.waitForTimeout(300)
  await expectContrast(page, "shortcut help")
  await page.keyboard.press("Escape")

  // Remove project: a destructive alert dialog, reached from the row with Cmd+Backspace.
  await page.getByRole("button", { name: "audit" }).focus()
  await page.keyboard.press("Meta+Backspace")
  const alert = page.getByRole("alertdialog")
  await expect(alert).toBeVisible()
  await page.waitForTimeout(300)
  await expectIconButtonsLabelled(page)
  await expectContrast(page, "remove dialog")
  await shot(page, "screen-dialog")
  const stops = await tabWalk(page, 2)
  report("remove dialog", stops)
  expect(stops.map((s) => s.name).sort()).toEqual(["Cancel", "Remove"])
  await page.keyboard.press("Escape")
  await expect(alert).toBeHidden()

  // A context menu: the keyboard-highlighted item is visibly marked.
  await page.getByRole("button", { name: "audit" }).click({ button: "right" })
  const menu = page.getByRole("menu")
  await expect(menu).toBeVisible()
  await page.keyboard.press("ArrowDown")
  const item = menu.getByRole("menuitem", { name: "Rename" })
  await expect(item).toHaveAttribute("data-highlighted", "")
  await expect
    .poll(() => item.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  await page.waitForTimeout(200)
  await expectContrast(page, "context menu")
})

// Runs in the page: the help dialog's computed scale at the first frame of its enter, read as the popup is inserted.
function recordDialogStart() {
  const seen: number[] = []
  ;(window as unknown as { seen: typeof seen }).seen = seen
  const observer = new MutationObserver(() => {
    const el = document.querySelector("[data-slot=dialog-content]")
    const animations = el?.getAnimations() ?? []
    if (!el || !animations.length) return
    observer.disconnect()
    for (const a of animations) {
      a.pause()
      a.currentTime = 0
    }
    // The popup is centred with translate(-50%, -50%), so the matrix's scale tells motion apart.
    seen.push(new DOMMatrix(getComputedStyle(el).transform).a)
    for (const a of animations) a.play()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  })
}

for (const reduce of [false, true])
  test(`help dialog motion${reduce ? " under reduced motion: fade only" : ": fades and scales"}`, async ({
    page,
  }) => {
    if (reduce) await page.emulateMedia({ reducedMotion: "reduce" })
    await seedBoard(page)
    await page.evaluate(recordDialogStart)
    await page.keyboard.press("Meta+Slash")
    await expect(page.locator("[data-slot=dialog-content]")).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { seen: number[] }).seen.length
        )
      )
      .toBeGreaterThan(0)
    const seen = await page.evaluate(
      () => (window as unknown as { seen: number[] }).seen
    )
    expect(seen.length).toBeGreaterThan(0)
    const scales = seen
    console.log(
      `[${test.info().project.name}] help dialog first-frame scale: ${scales.join(", ")}`
    )
    for (const s of scales) expect(s).toBeCloseTo(reduce ? 1 : 0.95, 2)
  })
