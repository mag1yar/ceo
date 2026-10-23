import { expect, test } from "@playwright/test"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }

test("the agent inspector shows the session's tokens in one compact row", async ({
  page,
}, info) => {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  await page.evaluate(() =>
    (
      window as unknown as { __TAURI_INTERNALS__: Ipc }
    ).__TAURI_INTERNALS__.invoke("project_create", {
      name: "usage",
      path: "/tmp/usage",
    })
  )
  await page.reload()
  await page.getByRole("button", { name: "Seed team" }).click()
  const ceo = page
    .locator(".react-flow__node-ceo")
    .filter({ has: page.getByText("CEO", { exact: true }) })
  await ceo.click()

  const inspector = page.getByRole("complementary", { name: "Agent inspector" })
  const usage = inspector.locator("[data-slot=usage]")
  // The mock's CEO row: in 1,200, out 48,300, read 2,350,000, write 182,000 + 4,100.
  await expect(usage).toHaveText("1.2Kin48.3Kout2.4Mread186.1Kwrite")
  await expect(usage).toHaveAttribute(
    "title",
    "in 1,200, out 48,300, read 2,350,000, write 186,100"
  )
  // One row: the four counts sit side by side on one line.
  const tops = await usage
    .locator(":scope > span")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
  expect(new Set(tops).size).toBe(1)
  await expect(inspector.locator("dt").last()).toHaveText("Tokens")
  await inspector.screenshot({
    animations: "disabled",
    path: info.outputPath("inspector-usage.png"),
  })
})
