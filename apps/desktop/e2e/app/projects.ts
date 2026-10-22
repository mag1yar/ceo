/// <reference types="@wdio/mocha-framework" />
import { execSync } from "node:child_process"
import { browser, expect } from "@wdio/globals"
import { worktreePort } from "../port"
import { folder, invoke, type Project, row, rowNames } from "./lib/projects"

// Runs before projects_restarted.ts (specs run in sorted order), which checks the same HOME after a relaunch.
describe("projects before a restart", () => {
  // Ends the app; the service relaunches it with the same HOME before the next spec file.
  after(async () => {
    const port = Number(process.env.TAURI_WEBDRIVER_PORT) || worktreePort(4445)
    const pid = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`).toString()
    // End the session first and forget its id, so the runner does not DELETE it on a dead server.
    await browser.deleteSession()
    Object.assign(globalThis.browser, { sessionId: undefined })
    process.kill(Number(pid.trim()))
    while (execSync(`lsof -ti tcp:${port} -sTCP:LISTEN || true`).length)
      await new Promise((resolve) => setTimeout(resolve, 100))
  })

  it("activates and reorders projects through the UI", async () => {
    for (const name of ["alpha", "beta", "gamma"])
      await invoke("project_create", { name, path: folder(name) })
    await browser.refresh()
    await browser.waitUntil(async () => (await rowNames()).length === 3)
    expect(await rowNames()).toEqual(["alpha", "beta", "gamma"])

    await row("gamma").click()
    await expect(row("gamma")).toHaveAttribute("aria-current", "page")
    // Alt+ArrowUp twice, dispatched in the page: the hidden window never has key focus.
    await browser.execute(
      (el) => {
        for (let i = 0; i < 2; i++)
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowUp",
              altKey: true,
              bubbles: true,
            })
          )
      },
      await row("gamma")
    )
    await browser.waitUntil(async () => {
      const list = await invoke<Project[]>("project_list")
      return list.map((p) => p.name).join() === "gamma,alpha,beta"
    })
  })
})
