/// <reference types="@wdio/mocha-framework" />
import { mkdirSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"
import { invoke, type Project } from "./lib/projects"

// What the page saw for one animated element, ms on the page clock.
type Seen = {
  at: number
  properties: string[]
  durations: number[]
  easings: string[]
  // Computed scale at the first frame, read with every animation paused at 0.
  scale: number
  gone?: number
  exitAt?: number
}
type Win = {
  motion: Record<string, Seen>
  held: string
  observer?: MutationObserver
}

// Runs in the page: records the first animations on elements matching each selector and holds them `holdMs` in.
function watch(targets: Record<string, string>, holdMs: number) {
  const w = window as unknown as Win
  w.motion = {}
  w.held = ""
  const scaleOf = (el: Element) => {
    const s = getComputedStyle(el)
    // The `scale` property for transitions, the transform matrix for tw-animate keyframes.
    return s.scale !== "none"
      ? Number(s.scale.split(" ")[0])
      : new DOMMatrix(s.transform).a
  }
  const record = (key: string, el: Element) => {
    if (w.motion[key]) return
    const animations = el.getAnimations()
    if (!animations.length) return
    for (const a of animations) {
      a.pause()
      a.currentTime = 0
    }
    const timing = animations.map((a) => a.effect?.getComputedTiming())
    const style = getComputedStyle(el)
    w.motion[key] = {
      at: performance.now(),
      properties: animations.map((a) =>
        a instanceof CSSTransition ? a.transitionProperty : a.constructor.name
      ),
      durations: timing.map((t) => Number(t?.duration)),
      easings: [style.transitionTimingFunction, style.animationTimingFunction],
      scale: scaleOf(el),
    }
    for (const a of animations) a.currentTime = holdMs
    w.held = key
  }
  // One watcher at a time, so an earlier test's selectors never pause this test's animations.
  w.observer?.disconnect()
  w.observer = new MutationObserver((records) => {
    for (const [key, selector] of Object.entries(targets)) {
      const el = document.querySelector(selector)
      if (el) record(key, el)
      const seen = w.motion[key]
      if (
        seen &&
        !seen.gone &&
        records.some((r) =>
          [...r.removedNodes].some(
            (n) => n instanceof Element && n.matches(selector)
          )
        )
      )
        seen.gone = performance.now()
    }
  })
  w.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  })
}

const motion = () =>
  browser.execute(() => (window as unknown as Win).motion) as Promise<
    Record<string, Seen>
  >

async function held(key: string) {
  await browser.waitUntil(
    () =>
      browser.execute((key) => (window as unknown as Win).held === key, key),
    { timeout: 10000, timeoutMsg: `${key} never animated` }
  )
  return (await motion())[key]
}

// Saves the window with the animation held mid-way, then lets it play out.
async function shoot(file: string) {
  const dark = await browser.execute(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  )
  mkdirSync("test-results-app", { recursive: true })
  await browser.saveScreenshot(
    `test-results-app/${file}-${dark ? "dark" : "light"}.png`
  )
  await browser.execute(() => {
    for (const a of document.getAnimations())
      if (a.playState === "paused") a.play()
    ;(window as unknown as Win).held = ""
  })
}

// Real key events into the webview: AppKit's path for Cmd keys, the first responder for plain ones.
const cmdKey = (chars: string, keyCode: number) =>
  invoke("e2e_key", { chars, keyCode, shift: false })
const key = (chars: string, keyCode: number) =>
  invoke("e2e_input", { kind: "key", keyCode, chars, x: 0, y: 0 })

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"

describe("motion in the real WebKit view", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<Project>("project_create", {
      name: "motion",
      path: "/tmp/motion",
    })
    projectId = p.id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [
          {
            id: "chart",
            type: "diagram",
            x: 80,
            y: 80,
            width: 360,
            height: 200,
            data: { source: "flowchart LR\n  Idea --> Ship" },
            z: 0,
          },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    })
    await browser.execute(() => location.reload())
    await $('ul[aria-label=Projects] button[title="/tmp/motion"]').click()
    await $('.react-flow__node[data-id="chart"]').waitForExist({
      timeout: 20000,
    })
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
  })

  // A failed test may leave a dialog or an editor open, which would swallow the next test's keys.
  beforeEach(async () => {
    await key("\u001b", 53)
    await browser.pause(300)
  })

  it("the help dialog enters on the tokens from scale 0.95 and leaves once its exit has played", async () => {
    await browser.execute(watch, { help: "[data-slot=dialog-content]" }, 60)
    await cmdKey("/", 44)
    const enter = await held("help")
    await shoot("motion-help-dialog")
    console.log(`[hidden app] help dialog enter: ${JSON.stringify(enter)}`)
    expect(enter.durations).toEqual([120])
    expect(enter.easings).toContain(EASE_OUT)
    expect(enter.scale).toBeCloseTo(0.95, 2)

    // Esc: the exit animation runs on the popup, which leaves the DOM only after it.
    await browser.execute(() => {
      const w = window as unknown as Win
      document.addEventListener(
        "animationstart",
        () => {
          w.motion.help.exitAt = performance.now()
        },
        { once: true }
      )
    })
    await key("\u001b", 53)
    await browser.waitUntil(async () => !!(await motion()).help.gone, {
      timeoutMsg: "the help dialog never left",
    })
    const { exitAt = 0, gone = 0 } = (await motion()).help
    console.log(
      `[hidden app] help dialog exit: removed ${(gone - exitAt).toFixed(0)} ms after its exit animation started`
    )
    expect(exitAt).toBeGreaterThan(0)
    expect(gone - exitAt).toBeGreaterThanOrEqual(100)
    expect(gone - exitAt).toBeLessThan(500)
  })

  it("a new note grows from scale 0.9 over --duration-base", async () => {
    await browser.execute(
      watch,
      { note: ".react-flow__node-note [data-color]" },
      100
    )
    await key("n", 45)
    const enter = await held("note")
    await shoot("motion-note")
    console.log(`[hidden app] note enter: ${JSON.stringify(enter)}`)
    expect(enter.properties.sort()).toEqual(["opacity", "scale"])
    expect(enter.durations).toEqual([200, 200])
    expect(enter.scale).toBeCloseTo(0.9, 2)
    await key("\u001b", 53)
  })

  it("the diagram editor grows from scale 0.9", async () => {
    await browser.execute(watch, { editor: "fieldset" }, 60)
    await browser.execute(() =>
      document
        .querySelector('.react-flow__node[data-id="chart"] [data-slot=diagram]')
        ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    )
    const enter = await held("editor")
    await shoot("motion-diagram-editor")
    console.log(`[hidden app] diagram editor enter: ${JSON.stringify(enter)}`)
    expect(enter.properties.sort()).toEqual(["opacity", "scale"])
    expect(enter.durations).toEqual([120, 120])
    expect(enter.scale).toBeCloseTo(0.9, 2)
    await key("\u001b", 53)
  })

  // The never-active hidden window gets no :focus-visible (Playwright covers the rings), so a state attribute drives the transition.
  it("a button's state change transitions named properties on the tokens", async () => {
    await browser.execute(watch, { button: 'button[aria-label="Zoom in"]' }, 60)
    await browser.execute(() =>
      document
        .querySelector('button[aria-label="Zoom in"]')
        ?.setAttribute("aria-expanded", "true")
    )
    const change = await held("button")
    await shoot("motion-button")
    console.log(`[hidden app] button state change: ${JSON.stringify(change)}`)
    expect(change.properties).toContain("background-color")
    expect(new Set(change.durations)).toEqual(new Set([120]))
    expect(change.easings).toContain(EASE_OUT)
    await browser.execute(() =>
      document
        .querySelector('button[aria-label="Zoom in"]')
        ?.removeAttribute("aria-expanded")
    )
  })
})
