/// <reference types="@wdio/mocha-framework" />
// Not in the default run (wdio.conf takes e2e/app/*.ts only): `pnpm test:e2e:measure` runs it on the release build.
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../../src/features/agents/team"
import type { BoardNode } from "../../../src/lib/store"
import { cards, recordFrames, summarize } from "../../frames"
import { appBinary, appPid, restartApp } from "../lib/app"
import { invoke } from "../lib/projects"

const sh = (cmd: string) => execSync(cmd).toString().trim()
const pids = (pattern: string) =>
  sh(`pgrep -f '${pattern}' || true`).split("\n").filter(Boolean).map(Number)
const webkit = () => pids("com.apple.WebKit.(WebContent|GPU|Networking)")

// Physical footprint, the number Activity Monitor shows as Memory, read with `footprint` per process.
const footprintMb = (pid: number) => {
  const out = sh(
    `footprint -p ${pid} -f bytes --noCategories 2>/dev/null || true`
  )
  const bytes = Number(out.match(/phys_footprint: (\d+) B/)?.[1] ?? 0)
  return bytes / 1024 / 1024
}

const team = buildTeam()
const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
const member = team.nodes.find((n) => n.type === "member") as BoardNode
// The CEO and four Members in a row: five open terminals.
const agents = Array.from({ length: 5 }, (_, i) => ({
  ...(i ? member : ceo),
  id: `agent-${i}`,
  x: i * 700,
  y: 0,
}))

describe("memory and frame rate of the app", function () {
  this.timeout(300000)
  const dir = mkdtempSync("/tmp/ceo-e2e-measure-")
  let projectId = ""
  let shown: string[] = []
  const rows: string[] = []

  // Restarts the app on `nodes`, waits for them, lets it settle, and sums the app with the WebKit helpers it started.
  async function measure(label: string, nodes: BoardNode[], viewport: object) {
    await invoke("board_save", {
      projectId,
      changes: { deleteNodeIds: shown, upsertNodes: nodes, viewport },
    })
    shown = nodes.map((n) => n.id)
    const before = new Set(webkit())
    await restartApp()
    await browser.waitUntil(
      async () => (await $$(".react-flow__node").length) === nodes.length,
      { timeout: 30000, timeoutMsg: `${label}: board did not render` }
    )
    if (nodes === agents)
      await browser.waitUntil(
        async () => (await $$(".xterm-screen").length) === agents.length,
        { timeout: 30000, timeoutMsg: "terminals did not open" }
      )
    await browser.pause(10000)
    const helpers = webkit().filter((p) => !before.has(p))
    const names = helpers.map((p) =>
      sh(`ps -o comm= -p ${p} || true`).split(".").pop()
    )
    // pgrep sees every app's helpers: exactly one of each kind proves none of another app's slipped into the diff.
    expect(names.sort()).toEqual(["GPU", "Networking", "WebContent"])
    const app = footprintMb(appPid())
    const kit = helpers.map(footprintMb).reduce((a, b) => a + b, 0)
    rows.push(
      `| ${label} | ${app.toFixed(0)} | ${kit.toFixed(0)} (${names.join(", ")}) | ${(app + kit).toFixed(0)} |`
    )
    console.log(rows[rows.length - 1])
  }

  before(async () => {
    const p = await invoke<{ id: string }>("project_create", {
      name: "measure",
      path: dir,
    })
    projectId = p.id
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(dir, { recursive: true, force: true })
  })

  it("records memory idle, with 300 nodes and with 5 terminals, and the pan frame rate", async () => {
    await measure("idle, one project, empty board", [], {
      x: 0,
      y: 0,
      zoom: 1,
    })
    await measure("one project, 300 nodes", cards(300), {
      x: 50,
      y: 100,
      zoom: 0.5,
    })
    // An idle baseline in the same window shows whether the off-screen window's rAF is throttled.
    const idle = summarize(
      await browser.execute(recordFrames, { ms: 1000, pan: false })
    )
    const pan = summarize(
      await browser.execute(recordFrames, { ms: 3000, pan: true })
    )
    await measure("one project, 5 open terminals", agents, {
      x: 40,
      y: 200,
      zoom: 0.35,
    })
    const build = appBinary.includes("/release/") ? "release" : "debug"
    const report = [
      `Build: ${appBinary} (${build}, cargo feature e2e). Memory: phys_footprint from \`footprint\`, app process plus the WebKit helpers that appeared with it.`,
      "",
      "| scenario | app MB | WebKit helpers MB | total MB |",
      "|---|---|---|---|",
      ...rows,
      "",
      `Pan with 300 nodes (hidden window, rAF): idle ${idle}; pan ${pan}`,
    ].join("\n")
    console.log(report)
    mkdirSync("test-results-app", { recursive: true })
    writeFileSync("test-results-app/measure.md", `${report}\n`)
  })
})
