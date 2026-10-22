/// <reference types="@wdio/mocha-framework" />
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $, $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import { restartApp } from "./lib/app"
import { invoke } from "./lib/projects"

type Term = {
  rows: number
  cols: number
  input: (data: string, user: boolean) => void
  buffer: {
    active: {
      length: number
      getLine: (i: number) => { translateToString: (t: boolean) => string }
    }
  }
}
type Hook = { e2e: { terminals: Record<number, Term> } }

const team = buildTeam()
const agents =
  ".react-flow__node-ceo, .react-flow__node-lead, .react-flow__node-member"
const sh = (cmd: string) => execSync(cmd).toString().trim()

const appPid = () =>
  Number(sh(`lsof -ti tcp:${browser.options.port} -sTCP:LISTEN`))
// Shells are the app's direct children; WebKit's helpers are XPC services under launchd.
const shells = () =>
  sh(`pgrep -P ${appPid()} || true`).split("\n").filter(Boolean).map(Number)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const webkitPids = () =>
  sh("pgrep -f 'com.apple.WebKit.(WebContent|GPU|Networking)' || true")
    .split("\n")
    .filter(Boolean)
    .map(Number)
const rssKb = (pids: number[]) =>
  pids
    .map((p) => Number(sh(`ps -o rss= -p ${p} || echo 0`)))
    .reduce((a, b) => a + b, 0)

// Tab keys count up across the run, so read them from the dock.
const tabKeys = () =>
  browser.execute(() =>
    [...document.querySelectorAll("[data-slot=terminal-dock] [role=tab]")].map(
      (t) => Number(t.id.replace("terminal-tab-", ""))
    )
  )

const screen = (key: number) =>
  browser.execute((key) => {
    const b = (window as unknown as Hook).e2e.terminals[key].buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++)
      lines.push(b.getLine(i).translateToString(true))
    return lines.join("\n")
  }, key)

// Sends input the way a keystroke does: through xterm's onData to the PTY.
const type = (key: number, data: string) =>
  browser.execute(
    (key, data) =>
      (window as unknown as Hook).e2e.terminals[key].input(data, true),
    key,
    data
  )

async function waitFor(key: number, text: string) {
  await browser
    .waitUntil(async () => (await screen(key)).includes(text), {
      timeout: 15000,
    })
    .catch(async () => {
      throw new Error(
        `terminal ${key} never showed ${text}:\n${await screen(key)}`
      )
    })
}

async function openTerminal() {
  const before = (await tabKeys()).length
  const pids = shells().length
  await $(".react-flow__node-ceo").click()
  await $("button=Open terminal").click()
  await browser.waitUntil(async () => (await tabKeys()).length === before + 1)
  // The tab shows at once; the shell is spawned while terminal_open runs.
  await browser.waitUntil(() => shells().length === pids + 1)
  const keys = await tabKeys()
  return keys[keys.length - 1]
}

// Close buttons of unselected tabs are transparent until hover, which WebDriver treats as not clickable.
const closeAll = () =>
  browser.execute(() => {
    for (const b of document.querySelectorAll<HTMLElement>(
      "[data-slot=terminal-dock] button[aria-label^=Close]"
    ))
      b.click()
  })

describe("terminal in the hidden app", function () {
  // Real shells, top's refresh and idle pauses for the memory readings.
  this.timeout(120000)
  let projectId = ""
  const dir = mkdtempSync("/tmp/ceo-e2e-term-")
  writeFileSync(join(dir, "known-file.txt"), "")
  let webkit: number[] = []

  async function showProject() {
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${dir}"]`).click()
    await browser.waitUntil(
      async () => (await $$(agents).length) === team.nodes.length,
      { timeout: 20000, timeoutMsg: "board did not render the team" }
    )
    await browser.execute(() => {
      ;(window as unknown as Hook).e2e = { terminals: {} }
    })
  }

  before(async () => {
    const p = await invoke<{ id: string }>("project_create", {
      name: "terminal",
      path: dir,
    })
    projectId = p.id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: team.nodes,
        upsertEdges: team.edges,
        viewport: { x: 700, y: 250, zoom: 0.5 },
      },
    })
    await showProject()
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs a login shell in the project folder: pwd, ls, top, resize, close", async () => {
    const key = await openTerminal()
    const [pid] = shells()
    await type(key, "pwd\r")
    await waitFor(key, dir)
    await type(key, "ls\r")
    await waitFor(key, "known-file.txt")

    // top redraws in place: the header is there and the screen changes between two reads.
    await type(key, "top -s 1\r")
    await waitFor(key, "PID")
    const first = await screen(key)
    await browser.waitUntil(async () => (await screen(key)) !== first, {
      timeout: 5000,
      timeoutMsg: "top did not redraw",
    })
    mkdirSync("test-results-app", { recursive: true })
    // The hidden app follows the system appearance, which tests must not change.
    const scheme = (await browser.execute(
      () => matchMedia("(prefers-color-scheme: dark)").matches
    ))
      ? "dark"
      : "light"
    await browser.saveScreenshot(`test-results-app/terminal-top-${scheme}.png`)
    await type(key, "q")
    await browser.waitUntil(async () => !(await screen(key)).includes("PID"))

    // Arrow keys on the splitter grow the dock; the new size must reach the PTY.
    const rows = await browser.execute(
      (key) => (window as unknown as Hook).e2e.terminals[key].rows,
      key
    )
    await browser.execute(() => {
      const handle = document.querySelector(
        "[data-slot=terminal-resize-handle]"
      ) as HTMLElement
      for (let i = 0; i < 8; i++)
        handle.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
        )
    })
    await browser.waitUntil(async () => {
      const r = await browser.execute(
        (key) => (window as unknown as Hook).e2e.terminals[key].rows,
        key
      )
      return r > rows
    })
    const size = await browser.execute((key) => {
      const t = (window as unknown as Hook).e2e.terminals[key]
      return `${t.rows} ${t.cols}`
    }, key)
    await type(key, "clear; stty size\r")
    await browser.waitUntil(async () =>
      (await screen(key)).split("\n").includes(size)
    )

    await closeAll()
    await browser.waitUntil(() => !alive(pid), {
      timeoutMsg: `shell ${pid} survived closing its tab`,
    })
  })

  it("kills every shell when the app quits", async () => {
    await openTerminal()
    await openTerminal()
    const pids = shells()
    expect(pids).toHaveLength(2)
    const before = new Set(webkitPids())
    await restartApp()
    for (const pid of pids)
      await browser.waitUntil(() => !alive(pid), {
        timeoutMsg: `shell ${pid} survived the app`,
      })
    // Helpers that appeared with the relaunch belong to this app.
    webkit = webkitPids().filter((p) => !before.has(p))
  })

  it("records memory with 0, 1 and 5 terminals", async () => {
    await showProject()
    const rows: string[] = []
    const measure = async (n: number) => {
      await browser.pause(4000)
      const app = rssKb([appPid()])
      const helpers = rssKb(webkit)
      rows.push(
        `| ${n} | ${(app / 1024).toFixed(0)} | ${(helpers / 1024).toFixed(0)} | ${((app + helpers) / 1024).toFixed(0)} |`
      )
    }
    await measure(0)
    await openTerminal()
    await measure(1)
    for (let i = 0; i < 4; i++) await openTerminal()
    expect(shells()).toHaveLength(5)
    await measure(5)
    const table = [
      `WebKit helpers: ${webkit.map((p) => `${p} ${sh(`ps -o comm= -p ${p}`).split(".").pop()}`).join(", ")}`,
      "| terminals | app MB | WebKit MB | total MB |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n")
    console.log(table)
    writeFileSync("test-results-app/terminal-memory.md", `${table}\n`)
    await closeAll()
    await browser.waitUntil(() => shells().length === 0)
  })
})
