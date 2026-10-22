import { type ChildProcess, execSync, spawn } from "node:child_process"
import { browser, expect } from "@wdio/globals"

// The app process serving our WebDriver port; by port so a sibling worktree's app is never touched.
const appPid = () =>
  Number(
    execSync(`lsof -ti tcp:${browser.options.port} -sTCP:LISTEN`).toString()
  )

let relaunched: ChildProcess | undefined
// The next worker relaunches the app it finds dead.
process.once("exit", () => relaunched?.kill())

// reloadSession keeps the app process the service launched once per run, so restart by killing it and spawning the same binary.
export async function restartApp() {
  const old = appPid()
  process.kill(old)
  await browser.waitUntil(() => {
    try {
      process.kill(old, 0)
      return false
    } catch {
      return true
    }
  })
  relaunched = spawn("src-tauri/target/e2e/debug/ceo", [], {
    env: {
      ...process.env,
      HOME: process.env.CEO_E2E_HOME,
      TAURI_WEBDRIVER_PORT: String(browser.options.port),
      WDIO_EMBEDDED_SERVER: "true",
    },
    stdio: "ignore",
  })
  await browser.waitUntil(
    () =>
      fetch(`http://127.0.0.1:${browser.options.port}/status`).then(
        (r) => r.ok,
        () => false
      ),
    { timeout: 30000 }
  )
  await browser.reloadSession()
  // Same explicit switch as wdio.conf `before`, so the service does not probe window focus.
  await browser.switchToWindow(await browser.getWindowHandle())
  expect(appPid()).not.toBe(old)
}
