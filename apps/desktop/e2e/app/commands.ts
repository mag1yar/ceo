/// <reference types="@wdio/mocha-framework" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import { COMMANDS } from "../../src/features/commands/registry"
import type { BoardNode } from "../../src/lib/store"
import { invoke } from "./lib/projects"

type MenuEntry = {
  menu: string
  title: string
  key: string
  cmd: boolean
  shift: boolean
  enabled: boolean
}
type Seen = { code: string; target: string; prevented: boolean }
type Hook = {
  e2e: { menu?: string[]; terminals: Record<string, { buffer: Buffer }> }
  seen: Seen[]
}
type Buffer = {
  active: {
    length: number
    getLine: (i: number) => { translateToString: (t: boolean) => string }
  }
}

const KEY_CODES: Record<string, number> = { b: 11, k: 40 }

const shell = () => $("[data-slot=app-shell]")
const palette = () => $("[role=dialog][aria-labelledby]")

// Records every keydown the page sees and whether anything cancelled it, and clears the menu log.
const listen = () =>
  browser.execute(() => {
    const w = window as unknown as Hook
    w.e2e.menu = []
    if (w.seen) {
      w.seen.length = 0
      return
    }
    w.seen = []
    addEventListener(
      "keydown",
      (e) => {
        const entry = {
          code: e.code,
          target: String((e.target as Element).className),
          prevented: false,
        }
        w.seen.push(entry)
        // Read after dispatch: a listener may stop propagation before any later phase runs.
        setTimeout(() => {
          entry.prevented = e.defaultPrevented
        })
      },
      true
    )
  })

const observed = () =>
  browser.execute(() => {
    const w = window as unknown as Hook
    return { seen: w.seen, menu: w.e2e.menu ?? [] }
  })

// A real Cmd+key through this app's AppKit event loop, not a synthetic DOM event.
async function nativeKey(char: string) {
  const steps = await invoke<string>("e2e_key", {
    chars: char,
    keyCode: KEY_CODES[char],
    shift: false,
  })
  // WebKit answers the keydown asynchronously, and only then may the menu see it.
  await browser.pause(600)
  return { ...(await observed()), steps }
}

const KEY_EQUIVALENTS: Record<string, string> = {
  Escape: "\u001b",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
}

describe("app menu and commands in the hidden app", function () {
  this.timeout(120000)
  const dir = mkdtempSync("/tmp/ceo-e2e-commands-")
  const team = buildTeam()
  const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
  let projectId = ""
  const rows: string[] = []

  before(async () => {
    const p = await invoke<{ id: string }>("project_create", {
      name: "commands",
      path: dir,
    })
    projectId = p.id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: team.nodes,
        upsertEdges: team.edges,
        viewport: { x: 510, y: 420, zoom: 0.2 },
      },
    })
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${dir}"]`).click()
    await $(`.react-flow__node[data-id="${ceo.id}"]`).waitForExist()
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(dir, { recursive: true, force: true })
  })

  it("builds the menu bar from the registry with its accelerators", async () => {
    const entries = await invoke<MenuEntry[]>("e2e_menu")
    console.log(
      entries
        .map(
          (e) =>
            `${e.menu} > ${e.title} [${e.cmd ? "⌘" : ""}${e.shift ? "⇧" : ""}${JSON.stringify(e.key)}]`
        )
        .join("\n")
    )
    const find = (menu: string, title: string) =>
      entries.find(
        (e) => e.menu === menu && e.title.toLowerCase() === title.toLowerCase()
      )
    for (const c of COMMANDS.filter((c) => c.menu !== false)) {
      const entry = find(c.group, c.title)
      expect(entry).toBeDefined()
      const s = c.shortcuts?.[0]
      if (!s?.meta || !s.code) continue
      expect(entry?.cmd).toBe(true)
      expect(entry?.key.toLowerCase()).toBe(
        KEY_EQUIVALENTS[s.code] ??
          s.code.replace(/^(Key|Digit)/, "").toLowerCase()
      )
    }
    // Items follow availability: the board is open, no agent has focus.
    expect(find("View", "Toggle Sidebar")?.enabled).toBe(true)
    expect(find("Board", "New Note")?.enabled).toBe(true)
    expect(find("View", "Next Agent")?.enabled).toBe(false)
    // Undo and Redo stay the native Edit items, so text fields keep their own undo.
    expect(find("Board", "Undo")).toBeUndefined()
    expect(find("Edit", "Undo")?.key).toBe("z")
    expect(find("Edit", "Copy")?.key).toBe("c")
    expect(find("Edit", "Paste")?.key).toBe("v")
    expect(
      entries.some((e) => e.title.startsWith("Quit") && e.key === "q")
    ).toBe(true)
  })

  it("runs the registry command from a menu item", async () => {
    await expect(shell()).toHaveAttribute("data-sidebar", "expanded")
    await invoke("e2e_menu_click", { menu: "View", item: "Toggle Sidebar" })
    await expect(shell()).toHaveAttribute("data-sidebar", "collapsed")
    await invoke("e2e_menu_click", { menu: "View", item: "Toggle Sidebar" })
    await expect(shell()).toHaveAttribute("data-sidebar", "expanded")
    await invoke("e2e_menu_click", { menu: "Help", item: "Keyboard Shortcuts" })
    await expect($("[role=dialog]")).toHaveText(/Keyboard shortcuts/)
    await browser.keys("Escape")
    await expect($("[role=dialog]")).not.toExist()
  })

  it("measures whether a menu accelerator reaches the page first", async () => {
    mkdirSync("test-results-app", { recursive: true })
    const row = async (
      keys: string,
      char: string,
      result: () => Promise<string>
    ) => {
      await listen()
      const o = await nativeKey(char)
      rows.push(
        `| ${keys} | ${o.seen.map((s) => s.code).join(", ") || "none"} | ${o.seen.map((s) => s.prevented).join(", ")} | ${o.menu.join(", ") || "none"} | ${await result()} | ${o.steps} |`
      )
      return o
    }

    // Board focused: the page sees Cmd+B first, cancels it, and the menu never fires.
    await browser.execute(() => (document.activeElement as HTMLElement)?.blur())
    let o = await row(
      "Cmd+B, board",
      "b",
      async () => `sidebar ${await shell().getAttribute("data-sidebar")}`
    )
    expect(o.seen).toEqual([{ code: "KeyB", prevented: true, target: "" }])
    expect(o.menu).toEqual([])
    await expect(shell()).toHaveAttribute("data-sidebar", "collapsed")
    await nativeKey("b")
    await expect(shell()).toHaveAttribute("data-sidebar", "expanded")

    // Board focused: Cmd+K opens the palette once.
    o = await row(
      "Cmd+K, board",
      "k",
      async () =>
        `palette ${(await palette().isExisting()) ? "open" : "closed"}`
    )
    expect(o.menu).toEqual([])
    await expect(palette()).toExist()
    await browser.keys("Escape")
    await expect(palette()).not.toExist()

    // A focused terminal: the page takes Cmd+K for the palette, so the menu never sees it.
    await $(`.react-flow__node[data-id="${ceo.id}"]`)
      .$("button[aria-label='Focus terminal']")
      .click()
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.activeElement?.classList.contains("xterm-helper-textarea") ??
          false
      )
    )
    const screen = () =>
      browser.execute((id) => {
        const b = (window as unknown as Hook).e2e.terminals[id].buffer.active
        const lines: string[] = []
        for (let i = 0; i < b.length; i++)
          lines.push(b.getLine(i).translateToString(true))
        return lines.join("\n")
      }, ceo.id)
    // tmux owns the screen now, so the check is that its first line survives Cmd+K.
    await browser.waitUntil(async () => (await screen()).trim() !== "")
    const first = (await screen()).trim().split("\n")[0]
    o = await row(
      "Cmd+K, focused terminal",
      "k",
      async () =>
        `palette ${(await palette().isExisting()) ? "open" : "closed"}, terminal ${(await screen()).includes(first) ? "kept" : "cleared"}`
    )
    expect(o.seen).toEqual([
      { code: "KeyK", prevented: true, target: "xterm-helper-textarea" },
    ])
    expect(o.menu).toEqual([])
    expect(await screen()).toContain(first)
    await expect(palette()).toExist()
    await browser.keys("Escape")
    await expect(palette()).not.toExist()

    const table = [
      "| keys | page keydowns | page cancelled | menu actions that arrived | result | AppKit steps |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n")
    console.log(table)
    writeFileSync("test-results-app/accelerator.md", `${table}\n`)
    await browser.keys(["Meta", "Escape"])
  })
})
