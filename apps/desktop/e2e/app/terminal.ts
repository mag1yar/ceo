/// <reference types="@wdio/mocha-framework" />
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $, $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import type { BoardNode } from "../../src/lib/store"
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
type Hook = { e2e: { terminals: Record<string, Term> } }

const team = buildTeam()
const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
// The CEO runs claude (sessions.ts); a Lead keeps the login shell.
const shell = team.nodes.find((n) => n.type === "lead") as BoardNode
const member = team.nodes.find((n) => n.type === "member") as BoardNode
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

const screen = (id: string) =>
  browser.execute((id) => {
    const b = (window as unknown as Hook).e2e.terminals[id].buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++)
      lines.push(b.getLine(i).translateToString(true))
    return lines.join("\n")
  }, id)

// Sends input the way a keystroke does: through xterm's onData, which a read-only terminal drops.
const type = (id: string, data: string) =>
  browser.execute(
    (id, data) =>
      (window as unknown as Hook).e2e.terminals[id].input(data, true),
    id,
    data
  )

async function waitFor(id: string, text: string) {
  await browser
    .waitUntil(async () => (await screen(id)).includes(text), {
      timeout: 15000,
    })
    .catch(async () => {
      throw new Error(
        `terminal ${id} never showed ${text}:\n${await screen(id)}`
      )
    })
}

const node = (id: string) => $(`.react-flow__node[data-id="${id}"]`)

async function scheme() {
  // The hidden app follows the system appearance, which tests must not change.
  return (await browser.execute(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  ))
    ? "dark"
    : "light"
}

// Agents in a row: the CEO and n - 1 Members, enough for the memory readings.
function row(n: number): BoardNode[] {
  return Array.from({ length: n }, (_, i) => ({
    ...(i ? member : ceo),
    id: crypto.randomUUID(),
    x: i * 700,
    y: 0,
  }))
}

describe("agent terminals in the hidden app", function () {
  // Real shells, top's refresh and idle pauses for the memory readings.
  this.timeout(180000)
  let projectId = ""
  const dir = mkdtempSync("/tmp/ceo-e2e-term-")
  writeFileSync(join(dir, "known-file.txt"), "")
  let webkit: number[] = []

  async function showProject(count: number) {
    // A reload closes the shells of the previous page.
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${dir}"]`).click()
    await browser.waitUntil(async () => (await $$(agents).length) === count, {
      timeout: 20000,
      timeoutMsg: "board did not render the agents",
    })
    await browser.waitUntil(() => shells().length === count, {
      timeout: 20000,
      timeoutMsg: `expected ${count} shells, saw ${shells().length}`,
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
        // The whole team in view, so every node can be clicked.
        viewport: { x: 510, y: 420, zoom: 0.2 },
      },
    })
    await showProject(team.nodes.length)
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs a login shell per agent: pwd, read-only overview, focus, top, tput cols", async () => {
    mkdirSync("test-results-app", { recursive: true })
    // The shell's prompt arrived.
    await browser.waitUntil(async () => (await screen(shell.id)).trim() !== "")
    // Overview drops input.
    await type(shell.id, "echo overview-typed\r")
    await browser.pause(500)
    expect(await screen(shell.id)).not.toContain("overview-typed")
    await browser.saveScreenshot(
      `test-results-app/terminal-overview-${await scheme()}.png`
    )

    await node(shell.id).$("button[aria-label='Focus terminal']").click()
    await browser.waitUntil(
      async () =>
        (
          await browser.execute(() =>
            document
              .querySelector(".react-flow__viewport")
              ?.getAttribute("style")
          )
        )?.includes("scale(1)") ?? false,
      { timeoutMsg: "focus did not zoom to 100%" }
    )
    await type(shell.id, "pwd\r")
    await waitFor(shell.id, dir)
    await type(shell.id, "ls\r")
    await waitFor(shell.id, "known-file.txt")

    // The PTY took the focused size.
    const cols = await browser.execute(
      (id) => (window as unknown as Hook).e2e.terminals[id].cols,
      shell.id
    )
    expect(cols).toBeGreaterThan(100)
    await type(shell.id, "clear; tput cols\r")
    await browser.waitUntil(async () =>
      (await screen(shell.id)).split("\n").includes(String(cols))
    )

    // top redraws in place: the header is there and the screen changes between two reads.
    await type(shell.id, "top -s 1\r")
    await waitFor(shell.id, "PID")
    const first = await screen(shell.id)
    await browser.waitUntil(async () => (await screen(shell.id)) !== first, {
      timeout: 5000,
      timeoutMsg: "top did not redraw",
    })
    await browser.saveScreenshot(
      `test-results-app/terminal-focus-top-${await scheme()}.png`
    )
    await type(shell.id, "q")
    await browser.waitUntil(
      async () => !(await screen(shell.id)).includes("PID")
    )
    await node(shell.id).$("button[aria-label='Exit focus']").click()
  })

  it("deleting an agent node kills its shell", async () => {
    const before = shells()
    await node(member.id).$("header").click()
    // React Flow reads the key as held state, so the release must come in a later task.
    const key = (type: string) =>
      browser.execute((type) => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Backspace",
            code: "Backspace",
            bubbles: true,
          })
        )
      }, type)
    await key("keydown")
    await key("keyup")
    await browser.waitUntil(
      async () => (await $$(agents).length) === team.nodes.length - 1
    )
    await browser.waitUntil(() => shells().length === before.length - 1, {
      timeoutMsg: "the deleted agent's shell survived",
    })
    const [gone] = before.filter((p) => !shells().includes(p))
    expect(alive(gone)).toBe(false)
  })

  it("kills every shell when the app quits", async () => {
    const pids = shells()
    expect(pids.length).toBeGreaterThan(0)
    const before = new Set(webkitPids())
    await restartApp()
    for (const pid of pids)
      await browser.waitUntil(() => !alive(pid), {
        timeoutMsg: `shell ${pid} survived the app`,
      })
    // Helpers that appeared with the relaunch belong to this app.
    webkit = webkitPids().filter((p) => !before.has(p))
  })

  it("records memory with 1, 5 and 15 agents", async () => {
    const rows: string[] = []
    let shown = team.nodes.map((x) => x.id)
    for (const n of [1, 5, 15]) {
      const nodes = row(n)
      await invoke("board_save", {
        projectId,
        changes: {
          deleteNodeIds: shown,
          upsertNodes: nodes,
          viewport: { x: 40, y: 200, zoom: 0.15 },
        },
      })
      shown = nodes.map((x) => x.id)
      await showProject(n)
      await browser.pause(4000)
      const app = rssKb([appPid()])
      const helpers = rssKb(webkit)
      rows.push(
        `| ${n} | ${(app / 1024).toFixed(0)} | ${(helpers / 1024).toFixed(0)} | ${((app + helpers) / 1024).toFixed(0)} |`
      )
    }
    const table = [
      `WebKit helpers: ${webkit.map((p) => `${p} ${sh(`ps -o comm= -p ${p}`).split(".").pop()}`).join(", ")}`,
      "| agents | app MB | WebKit MB | total MB |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n")
    console.log(table)
    writeFileSync("test-results-app/terminal-memory.md", `${table}\n`)
  })
})
