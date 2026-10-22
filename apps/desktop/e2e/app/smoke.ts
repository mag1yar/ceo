/// <reference types="@wdio/mocha-framework" />
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { $, browser, expect } from "@wdio/globals"

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

describe("hidden app", () => {
  it("loads the shell", async () => {
    await expect($("[data-slot=app-shell]")).toExist()
    await expect($("h1=CEO")).toExist()
  })

  it("persists a project and its board through the real store", async () => {
    const p = (await invoke("project_create", {
      name: "smoke",
      path: "/tmp/smoke",
    })) as { id: string }
    const node = {
      id: "n1",
      type: "note",
      x: 0,
      y: 0,
      width: null,
      height: null,
      data: {},
      z: 0,
    }
    await invoke("board_save", {
      projectId: p.id,
      changes: { upsertNodes: [node] },
    })
    expect(await invoke("project_list")).toEqual([
      expect.objectContaining({ id: p.id, name: "smoke" }),
    ])
    expect(await invoke("board_load", { projectId: p.id })).toEqual({
      viewport: {},
      nodes: [node],
      edges: [],
    })

    const home = process.env.CEO_E2E_HOME ?? ""
    expect(
      existsSync(
        join(home, "Library/Application Support/app.ceo.desktop.e2e/ceo.db")
      )
    ).toBe(true)
  })

  // Off-screen but painting: the e2e build disables WebKit occlusion detection, so the page stays visible.
  it("repaints the off-screen window after collapsing the sidebar", async () => {
    expect(await browser.execute(() => document.visibilityState)).toBe(
      "visible"
    )
    await $("[data-slot=sidebar-trigger]").click()
    const sidebar = $("[data-slot=sidebar]")
    await browser.waitUntil(
      async () => (await sidebar.getProperty("offsetWidth")) === 0
    )
    mkdirSync("test-results/app", { recursive: true })
    await browser.saveScreenshot("test-results/app/offscreen-collapsed.png")
  })
})
