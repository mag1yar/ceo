/// <reference types="@wdio/mocha-framework" />
import { $, browser } from "@wdio/globals"
import type { Message } from "../../src/features/messages/messages"
import { card } from "../frames"
import { invoke, type Project } from "./lib/projects"

type Win = {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: object) => Promise<unknown>
  }
}

// A real `bus://message` Tauri event, as the Rust bus (#19) will emit it.
const emit = (m: Message) =>
  browser.execute(
    (m) =>
      (window as unknown as Win).__TAURI_INTERNALS__.invoke(
        "plugin:event|emit",
        { event: "bus://message", payload: m }
      ),
    m
  )

describe("message signals in the hidden app", () => {
  let projectId = ""

  before(async () => {
    const p = await invoke<Project>("project_create", {
      name: "messages",
      path: "/tmp/messages",
    })
    projectId = p.id
    const others = (await invoke<Project[]>("project_list")).filter(
      (x) => x.id !== p.id
    )
    await invoke("project_reorder", { ids: [p.id, ...others.map((x) => x.id)] })
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [card("a", 0, 0), card("b", 500, 0)],
        viewport: { x: 100, y: 100, zoom: 1 },
      },
    })
    await browser.execute(() => location.reload())
    await $(".react-flow__node").waitForExist({ timeout: 20000 })
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
  })

  it("draws a signal from the bus event and removes it once accepted", async () => {
    const m: Message = {
      id: "m",
      projectId,
      from: "a",
      to: "b",
      thread: "t",
      kind: "ask",
      state: "sent",
      sentAt: Date.now(),
    }
    await emit(m)
    await $("[data-slot=signal][data-kind=ask]").waitForExist()
    await $("[data-slot=signal-path]").waitForExist()
    await $("[data-slot=ask-waiting]").waitForExist()
    await emit({ ...m, state: "accepted", acceptedAt: Date.now() })
    await $("[data-slot=signal]").waitForExist({ reverse: true })
    await $("[data-slot=signal-path]").waitForExist({ reverse: true })
  })
})
