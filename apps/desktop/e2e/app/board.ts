/// <reference types="@wdio/mocha-framework" />
import { type ChildProcess, execSync, spawn } from "node:child_process"
import { $$, browser, expect } from "@wdio/globals"
import { cards, recordFrames, summarize } from "../frames"

type Invoke = (cmd: string, args?: object) => Promise<unknown>

// Real IPC into the Rust store, from inside the webview.
function invoke(cmd: string, args: object = {}) {
  return browser.execute(
    (cmd, args) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }
      ).__TAURI_INTERNALS__.invoke(cmd, args),
    cmd,
    args
  )
}

// The live transform React Flow applies to an element: x, y and scale.
function transform(selector: string) {
  return browser.execute((selector) => {
    const el = document.querySelector(selector)
    const m = new DOMMatrix(el ? getComputedStyle(el).transform : "")
    return { x: m.e, y: m.f, zoom: m.a }
  }, selector)
}

// Computed transforms are rounded, so compare with a small tolerance.
const near = (a: number, b: number) => Math.abs(a - b) < 0.01
const same = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(b).every((k) => near(a[k], b[k]))

const nodes = cards(300)

// The app process serving our WebDriver port; by port so a sibling worktree's app is never touched.
const appPid = () =>
  Number(
    execSync(`lsof -ti tcp:${browser.options.port} -sTCP:LISTEN`).toString()
  )

let relaunched: ChildProcess | undefined

// reloadSession keeps the app process the service launched once per run, so restart by killing it and spawning the same binary.
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
  // Same explicit switch as wdio.conf `before`, so the service does not probe window focus.
  await browser.switchToWindow(await browser.getWindowHandle())
  expect(appPid()).not.toBe(old)
}

const frameTiming = async (ms: number, pan: boolean) =>
  summarize(await browser.execute(recordFrames, { ms, pan }))

async function waitForBoard() {
  await browser.waitUntil(
    async () => (await $$(".react-flow__node").length) === nodes.length,
    { timeout: 20000, timeoutMsg: "board did not render 300 nodes" }
  )
}

describe("board in the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = (await invoke("project_create", {
      name: "board",
      path: "/tmp/board",
    })) as { id: string }
    projectId = p.id
    const others = ((await invoke("project_list")) as { id: string }[]).filter(
      (x) => x.id !== p.id
    )
    await invoke("project_reorder", { ids: [p.id, ...others.map((x) => x.id)] })
    await invoke("board_save", {
      projectId,
      changes: { upsertNodes: nodes, viewport: { x: 50, y: 100, zoom: 0.5 } },
    })
    await browser.execute(() => location.reload())
    await waitForBoard()
  })

  // Leave the shared store as the other specs expect it; the next worker relaunches the app it finds dead.
  after(async () => {
    process.once("exit", () => relaunched?.kill())
    await invoke("project_delete", { id: projectId })
  })

  // WebDriver wheel actions do not reach the off-screen window (the viewport stays put), so the pan is in-page wheel events.
  it("pans 300 nodes for 3 s and reports frame timing", async () => {
    // An idle baseline in the same window shows whether WebKit is throttling rAF (it caps at 30 fps on a busy machine).
    const idle = await frameTiming(1000, false)
    const before = await transform(".react-flow__viewport")
    const pan = await frameTiming(3000, true)
    console.log(`[hidden app] idle: ${idle}; pan 300 nodes: ${pan}`)
    expect(await transform(".react-flow__viewport")).not.toEqual(before)
  })

  it("restores viewport and a dragged node after an app restart", async () => {
    // d3-drag listens to mouse events, so a synthetic drag, one step per frame, goes through the board's own drag and save path.
    const id = await browser.executeAsync((done: (id: string) => void) => {
      const pane = document.querySelector(".react-flow") as Element
      const box = pane.getBoundingClientRect()
      // A card well inside the pane, so the drag does not trigger auto-pan at the edge.
      const node = [
        ...document.querySelectorAll<HTMLElement>(".react-flow__node"),
      ].find((n) => {
        const r = n.getBoundingClientRect()
        return (
          r.left > box.left + 200 &&
          r.right < box.right - 300 &&
          r.top > box.top + 200 &&
          r.bottom < box.bottom - 200
        )
      }) as HTMLElement
      const r = node.getBoundingClientRect()
      const at = (i: number) => ({
        clientX: r.x + 10 + i * 6,
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
          done(node.dataset.id ?? "")
        }
      }
      requestAnimationFrame(step)
    })
    const node = `.react-flow__node[data-id="${id}"]`
    const seeded = nodes.find((n) => n.id === id)
    const moved = await transform(node)
    expect(moved.x).toBeGreaterThan(seeded?.x ?? 0)
    expect(moved.y).toBeGreaterThan(seeded?.y ?? 0)
    const viewport = await transform(".react-flow__viewport")
    await browser.waitUntil(async () => {
      const b = (await invoke("board_load", { projectId })) as {
        viewport: { x: number; y: number; zoom: number }
        nodes: { id: string; x: number; y: number }[]
      }
      const n0 = b.nodes.find((n) => n.id === id)
      return (
        !!n0 &&
        same(b.viewport, viewport) &&
        near(n0.x, moved.x) &&
        near(n0.y, moved.y)
      )
    })

    await restartApp()
    await waitForBoard()
    expect(same(await transform(".react-flow__viewport"), viewport)).toBe(true)
    expect(same(await transform(node), moved)).toBe(true)
    expect(await transform('.react-flow__node[data-id="n1"]')).toEqual({
      x: 220,
      y: 0,
      zoom: 1,
    })
  })
})
