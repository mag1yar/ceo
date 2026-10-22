/// <reference types="@wdio/mocha-framework" />
import { mkdirSync } from "node:fs"
import { $, browser, expect } from "@wdio/globals"
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

  it("merges an accepted report into the receiver, whose outline pulses (held mid-merge for a screenshot)", async () => {
    const m: Message = {
      id: "merge",
      projectId,
      from: "a",
      to: "b",
      thread: "merge",
      kind: "report",
      state: "waiting",
      sentAt: Date.now(),
      waitingAt: Date.now(),
    }
    await emit(m)
    await $('[data-message="merge"][data-state=waiting]').waitForExist()
    // Held 130 ms in: the drop has crossed into the outline and the pulse has started; the store's leave timer waits meanwhile.
    await browser.execute(() => {
      const w = window as unknown as { held?: string[] }
      const timer = window.setTimeout
      window.setTimeout = ((f: () => void, ms?: number) =>
        timer(f, ms === 500 ? 3000 : ms)) as typeof setTimeout
      new MutationObserver((_, o) => {
        const dot = document.querySelector(
          '[data-slot=signal][data-message="merge"][data-state=accepted]'
        )
        const ring = document.querySelector(
          '[data-slot=signal-pulse][data-message="merge"]'
        )
        if (!dot || !ring) return
        o.disconnect()
        window.setTimeout = timer
        w.held = []
        for (const [el, at] of [
          [dot, 130],
          [ring, 130],
        ] as const)
          for (const a of el.getAnimations()) {
            a.pause()
            a.currentTime = at
            w.held.push(
              (a.effect as KeyframeEffect)
                .getKeyframes()
                .flatMap((k) => Object.keys(k))
                .filter((k) => k === "opacity" || k === "transform")
                .filter((k, i, all) => all.indexOf(k) === i)
                .sort()
                .join("+")
            )
          }
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
      })
    })
    await emit({ ...m, state: "accepted", acceptedAt: Date.now() })
    await browser.waitUntil(() =>
      browser.execute(() => !!(window as { held?: string[] }).held)
    )
    expect(
      await browser.execute(() => (window as { held?: string[] }).held)
    ).toEqual(["opacity+transform", "opacity+transform"])
    mkdirSync("test-results-app", { recursive: true })
    const dark = await browser.execute(
      () => matchMedia("(prefers-color-scheme: dark)").matches
    )
    await browser.saveScreenshot(
      `test-results-app/signal-merge-${dark ? "dark" : "light"}.png`
    )
    await browser.execute(() => {
      for (const a of document.getAnimations())
        if (a.playState === "paused") a.play()
    })
    await $("[data-slot=signal]").waitForExist({
      reverse: true,
      timeout: 5000,
    })
  })
})
