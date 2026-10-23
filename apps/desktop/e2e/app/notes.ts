/// <reference types="@wdio/mocha-framework" />
import { $, $$, browser, expect } from "@wdio/globals"
import type { Board } from "../../src/lib/store"
import { restartApp } from "./lib/app"
import { invoke, type Project } from "./lib/projects"

const notes = () => $$(".react-flow__node-note")

describe("notes and links in the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<Project>("project_create", {
      name: "notes",
      path: "/tmp/notes",
    })
    projectId = p.id
    const others = (await invoke<Project[]>("project_list")).filter(
      (x) => x.id !== p.id
    )
    await invoke("project_reorder", { ids: [p.id, ...others.map((x) => x.id)] })
    await invoke("board_save", {
      projectId,
      changes: { viewport: { x: 0, y: 0, zoom: 1 } },
    })
    await browser.execute(() => location.reload())
    await $(".react-flow__pane").waitForExist({ timeout: 20000 })
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
  })

  it("keeps a note and a link made through the UI after an app restart", async () => {
    // One note from the toolbar, one from a double-click on the empty board top-left.
    await $("button=Note").click()
    await browser.waitUntil(async () => (await notes().length) === 1)
    await browser.execute(() => {
      const pane = document.querySelector(".react-flow__pane") as Element
      const r = pane.getBoundingClientRect()
      pane.dispatchEvent(
        new MouseEvent("dblclick", {
          clientX: r.left + 160,
          clientY: r.top + 120,
          bubbles: true,
        })
      )
    })
    // Explicit sizes make new notes visible before React Flow has measured their handles; once the entry fade ends it has.
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.querySelectorAll(".react-flow__node-note").length === 2 &&
          document.getAnimations().length === 0
      )
    )

    // React Flow's handle drag listens to mouse events; drag from the second note's top dot onto the first note's centre.
    await browser.executeAsync((done: () => void) => {
      const [a, b] = document.querySelectorAll(".react-flow__node-note")
      const center = (el: Element | null) => {
        const r = (el as Element).getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
      const dot = b.querySelector('.react-flow__handle[data-handleid="top"]')
      const from = center(dot)
      const to = center(a)
      const at = (i: number) => ({
        clientX: from.x + ((to.x - from.x) * i) / 10,
        clientY: from.y + ((to.y - from.y) * i) / 10,
        bubbles: true,
        view: window,
      })
      dot?.dispatchEvent(new MouseEvent("mousedown", { ...at(0), button: 0 }))
      let i = 0
      const step = () => {
        if (++i <= 10) {
          document.dispatchEvent(new MouseEvent("mousemove", at(i)))
          requestAnimationFrame(step)
        } else {
          document.dispatchEvent(new MouseEvent("mouseup", at(10)))
          done()
        }
      }
      requestAnimationFrame(step)
    })
    await browser.waitUntil(
      async () => (await $$(".react-flow__edge").length) === 1,
      { timeoutMsg: "no edge after the handle drag" }
    )
    await browser.waitUntil(
      async () => {
        const b = await invoke<Board>("board_load", { projectId })
        return (
          b.nodes.filter((n) => n.type === "note").length === 2 &&
          b.edges.length === 1
        )
      },
      { timeoutMsg: "notes and link were not saved" }
    )

    await restartApp()
    await browser.waitUntil(async () => (await notes().length) === 2, {
      timeout: 20000,
      timeoutMsg: "notes did not come back after the restart",
    })
    await expect($$(".react-flow__edge")).toBeElementsArrayOfSize(1)
    const b = await invoke<Board>("board_load", { projectId })
    expect(b.edges[0].data).toMatchObject({ kind: "link" })
    expect(b.nodes.map((n) => n.width)).toEqual([220, 220])
    // The floating ends sit on each note's outline, on the side facing the other note.
    const ends = await browser.execute(
      (source, target) => {
        const path = document.querySelector(
          ".react-flow__edge-path"
        ) as SVGPathElement
        const ctm = path.getScreenCTM() as DOMMatrix
        const at = (l: number) => path.getPointAtLength(l).matrixTransform(ctm)
        const rect = (id: string) =>
          (
            document.querySelector(
              `.react-flow__node[data-id="${id}"]`
            ) as Element
          ).getBoundingClientRect()
        const box = (r: DOMRect) => ({
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          cx: r.x + r.width / 2,
          cy: r.y + r.height / 2,
        })
        const p = (q: DOMPoint) => ({ x: q.x, y: q.y })
        return {
          start: p(at(0)),
          end: p(at(path.getTotalLength())),
          source: box(rect(source)),
          target: box(rect(target)),
        }
      },
      b.edges[0].source,
      b.edges[0].target
    )
    type B = typeof ends.source
    const onOutline = (q: { x: number; y: number }, r: B) =>
      [q.x - r.x, r.right - q.x, q.y - r.y, r.bottom - q.y].some(
        (d) => Math.abs(d) < 2
      )
    const facing = (q: { x: number; y: number }, r: B, o: B) =>
      (q.x - r.cx) * (o.cx - r.cx) + (q.y - r.cy) * (o.cy - r.cy) > 0
    expect(onOutline(ends.start, ends.source)).toBe(true)
    expect(onOutline(ends.end, ends.target)).toBe(true)
    expect(facing(ends.start, ends.source, ends.target)).toBe(true)
    expect(facing(ends.end, ends.target, ends.source)).toBe(true)
  })
})
