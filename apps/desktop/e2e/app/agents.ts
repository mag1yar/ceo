/// <reference types="@wdio/mocha-framework" />
import { type ChildProcess, execSync, spawn } from "node:child_process"
import { $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import { invoke } from "./lib/projects"

type Saved = { nodes: { id: string; x: number; y: number }[] }

const team = buildTeam()
const agents =
  ".react-flow__node-ceo, .react-flow__node-lead, .react-flow__node-member"

// The live transform React Flow applies to a node.
const transform = (id: string) =>
  browser.execute((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)
    const m = new DOMMatrix(el ? getComputedStyle(el).transform : "")
    return { x: m.e, y: m.f }
  }, id)

const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01

async function waitForTeam() {
  await browser.waitUntil(
    async () => (await $$(agents).length) === team.nodes.length,
    {
      timeout: 20000,
      timeoutMsg: "board did not render the team",
    }
  )
}

const appPid = () =>
  Number(
    execSync(`lsof -ti tcp:${browser.options.port} -sTCP:LISTEN`).toString()
  )

let relaunched: ChildProcess | undefined

// Same restart as board.ts: kill the app serving our port, spawn the same binary, reconnect.
async function restartApp() {
  const old = appPid()
  process.kill(old)
  await browser.waitUntil(() => {
    try {
      process.kill(old, 0)
      return false
    } catch {
      return true
    }
  })
  relaunched = spawn("src-tauri/target/e2e/debug/ceo", [], {
    env: {
      ...process.env,
      HOME: process.env.CEO_E2E_HOME,
      TAURI_WEBDRIVER_PORT: String(browser.options.port),
      WDIO_EMBEDDED_SERVER: "true",
    },
    stdio: "ignore",
  })
  await browser.waitUntil(
    () =>
      fetch(`http://127.0.0.1:${browser.options.port}/status`).then(
        (r) => r.ok,
        () => false
      ),
    { timeout: 30000 }
  )
  await browser.reloadSession()
  await browser.switchToWindow(await browser.getWindowHandle())
  expect(appPid()).not.toBe(old)
}

describe("agent team in the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<{ id: string }>("project_create", {
      name: "agents",
      path: "/tmp/agents",
    })
    projectId = p.id
    const others = (await invoke<{ id: string }[]>("project_list")).filter(
      (x) => x.id !== p.id
    )
    await invoke("project_reorder", { ids: [p.id, ...others.map((x) => x.id)] })
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: team.nodes,
        upsertEdges: team.edges,
        // The whole team in view, clear of the edges where a drag auto-pans.
        viewport: { x: 510, y: 420, zoom: 0.2 },
      },
    })
    await browser.execute(() => location.reload())
    await waitForTeam()
  })

  after(async () => {
    process.once("exit", () => relaunched?.kill())
    await invoke("project_delete", { id: projectId })
  })

  it("renders the seeded team with hierarchy edges and all five statuses", async () => {
    expect(await $$(".react-flow__edge").length).toBe(team.edges.length)
    const statuses = await browser.execute(() =>
      [...document.querySelectorAll("[data-status]")].map((el) =>
        el.getAttribute("data-status")
      )
    )
    for (const s of ["idle", "working", "waiting", "error", "done"])
      expect(statuses).toContain(s)
  })

  it("keeps a dragged agent's position after an app restart", async () => {
    const member = team.nodes.find((n) => n.type === "member")
    if (!member) throw new Error("no member")
    // d3-drag listens to mouse events, so a synthetic drag, one step per frame, goes through the board's own drag and save path.
    await browser.executeAsync((id: string, done: () => void) => {
      const node = document.querySelector(
        `.react-flow__node[data-id="${id}"]`
      ) as HTMLElement
      const r = node.getBoundingClientRect()
      const at = (i: number) => ({
        clientX: r.x + 20 + i * 6,
        clientY: r.y + 10 + i * 4,
        bubbles: true,
        view: window,
      })
      node.dispatchEvent(new MouseEvent("mousedown", at(0)))
      let i = 0
      const step = () => {
        if (++i <= 10) {
          window.dispatchEvent(new MouseEvent("mousemove", at(i)))
          requestAnimationFrame(step)
        } else {
          window.dispatchEvent(new MouseEvent("mouseup", at(10)))
          done()
        }
      }
      requestAnimationFrame(step)
    }, member.id)
    const moved = await transform(member.id)
    expect(moved.x).toBeGreaterThan(member.x)
    expect(moved.y).toBeGreaterThan(member.y)
    await browser.waitUntil(async () => {
      const b = await invoke<Saved>("board_load", { projectId })
      const n = b.nodes.find((n) => n.id === member.id)
      return !!n && near(n, moved)
    })

    await restartApp()
    await waitForTeam()
    expect(near(await transform(member.id), moved)).toBe(true)
    for (const n of team.nodes)
      if (n.id !== member.id) expect(near(await transform(n.id), n)).toBe(true)
    expect(await $$(".react-flow__edge").length).toBe(team.edges.length)
  })
})
