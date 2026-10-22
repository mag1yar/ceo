/// <reference types="@wdio/mocha-framework" />
import { $, $$, browser, expect } from "@wdio/globals"
import type { Board } from "../../src/lib/store"
import { restartApp } from "./lib/app"
import { invoke, type Project } from "./lib/projects"

const notes = () => $$(".react-flow__node-note")

type MenuEntry = { menu: string; title: string; key: string }

// The app dies inside the call that quits it, so a dropped connection is the expected answer.
const quietly = (call: Promise<unknown>) => call.catch(() => undefined)

const menuItem = async (key: string) => {
  const entries = await invoke<MenuEntry[]>("e2e_menu")
  const entry = entries.find((e) => e.key === key)
  if (!entry) throw new Error(`no menu item on Cmd+${key}`)
  return entry
}

describe("quitting the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<Project>("project_create", {
      name: "quit",
      path: "/tmp/quit",
    })
    projectId = p.id
    const others = (await invoke<Project[]>("project_list")).filter(
      (x) => x.id !== p.id
    )
    await invoke("project_reorder", { ids: [p.id, ...others.map((x) => x.id)] })
    await browser.execute(() => location.reload())
    await $(".react-flow__pane").waitForExist({ timeout: 20000 })
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
  })

  // Each path quits 100 ms after a new note, well inside the 400 ms save debounce.
  const paths: [string, () => Promise<unknown>][] = [
    [
      "the Quit menu item",
      async () => {
        const { menu, title } = await menuItem("q")
        return invoke("e2e_menu_click", { menu, item: title })
      },
    ],
    [
      "Cmd+Q",
      () => invoke("e2e_key", { chars: "q", keyCode: 12, shift: false }),
    ],
    ["closing the window", () => invoke("e2e_close_window")],
  ]

  for (const [name, quit] of paths) {
    it(`keeps a note made 100 ms before ${name}`, async () => {
      const count = await notes().length
      await $("button=Note").click()
      await browser.waitUntil(async () => (await notes().length) === count + 1)
      await browser.pause(100)
      await restartApp(() => quietly(quit()))
      await $(".react-flow__pane").waitForExist({ timeout: 20000 })
      const b = await invoke<Board>("board_load", { projectId })
      expect(b.nodes.filter((n) => n.type === "note")).toHaveLength(count + 1)
    })
  }
})
