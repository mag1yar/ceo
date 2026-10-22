/// <reference types="@wdio/mocha-framework" />
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import type { BoardNode } from "../../src/lib/store"
import { invoke } from "./lib/projects"

const team = buildTeam()
const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
// In the area the focused CEO grows into, and after it in the store's (z, id) order.
const diagram: BoardNode = {
  id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
  type: "diagram",
  x: ceo.x + 650,
  y: ceo.y + 60,
  width: 360,
  height: 200,
  z: 0,
  data: { source: "flowchart LR\n  Idea --> Plan --> Ship" },
}

const ESC = { chars: "\u001b", keyCode: 53 }
const node = () => $(`.react-flow__node[data-id="${ceo.id}"]`)
const viewport = () =>
  browser.execute(
    () =>
      document.querySelector<HTMLElement>(".react-flow__viewport")?.style
        .transform
  )
// Real AppKit events from the e2e build: a Cmd key through the menu path, a plain key or a click into the webview.
const cmdKey = (k: { chars: string; keyCode: number }) =>
  invoke("e2e_key", { ...k, shift: false })
const key = (k: { chars: string; keyCode: number }) =>
  invoke("e2e_input", { kind: "key", ...k, x: 0, y: 0 })
const click = (p: { x: number; y: number }) =>
  invoke("e2e_input", { kind: "click", keyCode: 0, chars: "", ...p })

// The topmost node at a page point, and whether the keyboard is in the CEO's shell.
const state = (p: { x: number; y: number }) =>
  browser.execute(
    (id, { x, y }) => ({
      top: document
        .elementFromPoint(x, y)
        ?.closest(".react-flow__node")
        ?.getAttribute("data-id"),
      typing:
        document.activeElement?.classList.contains("xterm-helper-textarea") &&
        !!document.activeElement.closest(`.react-flow__node[data-id="${id}"]`),
    }),
    ceo.id,
    p
  )

async function focusCeo() {
  await node().$("button[aria-label='Focus terminal']").click()
  await browser.waitUntil(async () => (await viewport())?.endsWith("scale(1)"))
  await browser.waitUntil(async () => (await state({ x: 0, y: 0 })).typing)
}

describe("terminal focus in the hidden app", function () {
  this.timeout(120000)
  const dir = mkdtempSync("/tmp/ceo-e2e-focus-")
  let projectId = ""

  before(async () => {
    const p = await invoke<{ id: string }>("project_create", {
      name: "focus",
      path: dir,
    })
    projectId = p.id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [...team.nodes, diagram],
        upsertEdges: team.edges,
        viewport: { x: 510, y: 420, zoom: 0.2 },
      },
    })
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${dir}"]`).click()
    await node().waitForExist()
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(dir, { recursive: true, force: true })
  })

  it("after Cmd+K and Esc the focused node stays over the diagram and a click inside keeps focus", async () => {
    await focusCeo()
    // Centre of the part of the diagram the focused node covers.
    const at = await browser.execute(
      (a, b) => {
        const rect = (id: string) =>
          (
            document.querySelector(
              `.react-flow__node[data-id="${id}"]`
            ) as Element
          ).getBoundingClientRect()
        const [p, q] = [rect(a), rect(b)]
        return {
          x: (Math.max(p.left, q.left) + Math.min(p.right, q.right)) / 2,
          y: (Math.max(p.top, q.top) + Math.min(p.bottom, q.bottom)) / 2,
        }
      },
      ceo.id,
      diagram.id
    )
    const header = await browser.execute((id) => {
      const r = document
        .querySelector(`.react-flow__node[data-id="${id}"] header`)
        ?.getBoundingClientRect()
      return { x: (r?.left ?? 0) + 300, y: (r?.top ?? 0) + 24 }
    }, ceo.id)
    const focused = await viewport()

    await cmdKey({ chars: "k", keyCode: 40 })
    await browser.pause(600)
    await key(ESC)
    // The path to the bug: a press on the header took the keyboard, and Esc then unselected the node.
    await click(header)
    await key(ESC)
    await browser.pause(300)
    expect(await state(at)).toEqual({ top: ceo.id, typing: true })
    await expect(node()).toHaveElementClass("selected")

    await click(at)
    await browser.pause(500)
    expect(await viewport()).toBe(focused)
    await expect(node().$("button[aria-label='Exit focus']")).toExist()
    expect(await state(at)).toEqual({ top: ceo.id, typing: true })

    mkdirSync("test-results-app", { recursive: true })
    const dark = await browser.execute(
      () => matchMedia("(prefers-color-scheme: dark)").matches
    )
    await browser.saveScreenshot(
      `test-results-app/focus-over-diagram-${dark ? "dark" : "light"}.png`
    )
  })

  it("Cmd+Esc leaves focus and restores the overview", async () => {
    await cmdKey(ESC)
    await browser.waitUntil(
      async () => (await viewport())?.endsWith("scale(0.2)"),
      { timeoutMsg: "Cmd+Esc did not restore the overview" }
    )
    await expect(node().$("button[aria-label='Focus terminal']")).toExist()
  })
})
