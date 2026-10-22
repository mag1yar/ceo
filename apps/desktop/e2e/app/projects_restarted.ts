/// <reference types="@wdio/mocha-framework" />
import { $, browser, expect } from "@wdio/globals"
import { folder, invoke, type Project, row, rowNames } from "./lib/projects"

// projects.ts killed the app; this file talks to the relaunched process.
describe("projects after a restart", () => {
  // Leaves the shared HOME empty for the next spec file.
  after(async () => {
    for (const p of await invoke<Project[]>("project_list"))
      await invoke("project_delete", { id: p.id })
  })

  it("keeps the order and reopens the last active project", async () => {
    await browser.waitUntil(async () => (await rowNames()).length === 3)
    expect(await rowNames()).toEqual(["gamma", "alpha", "beta"])
    await expect(row("gamma")).toHaveAttribute("aria-current", "page")
    await expect($("[data-slot=main-content]")).toHaveText(
      expect.stringContaining(folder("gamma"))
    )
  })
})
