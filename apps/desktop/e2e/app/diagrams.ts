/// <reference types="@wdio/mocha-framework" />
import { $, $$, browser, expect } from "@wdio/globals"
import type { Board } from "../../src/lib/store"
import { restartApp } from "./lib/app"
import { invoke, type Project } from "./lib/projects"

const svgText = () =>
  browser.execute(
    () =>
      document.querySelector(
        ".react-flow__node-diagram [data-slot=diagram] svg"
      )?.textContent ?? ""
  )

describe("diagrams in the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<Project>("project_create", {
      name: "diagrams",
      path: "/tmp/diagrams",
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

  it("renders a mermaid diagram under the strict CSP and keeps it after a restart", async () => {
    await $("button=Diagram").click()
    await browser.waitUntil(async () => (await svgText()).includes("Ship"), {
      timeout: 20000,
      timeoutMsg: "the diagram SVG did not render",
    })
    await browser.waitUntil(
      async () => {
        const b = await invoke<Board>("board_load", { projectId })
        return b.nodes.some((n) => n.type === "diagram")
      },
      { timeoutMsg: "the diagram was not saved" }
    )
    const { source } = (await invoke<Board>("board_load", { projectId }))
      .nodes[0].data as { source: string }

    await restartApp()
    await browser.waitUntil(async () => (await svgText()).includes("Ship"), {
      timeout: 20000,
      timeoutMsg: "the diagram did not come back after the restart",
    })
    await expect($$(".react-flow__node-diagram")).toBeElementsArrayOfSize(1)
    const b = await invoke<Board>("board_load", { projectId })
    expect(b.nodes[0]).toMatchObject({ type: "diagram", data: { source } })
    expect(source).toMatch(/^flowchart LR/)
  })
})
