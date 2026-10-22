import { type ChildProcess, execSync, spawn } from "node:child_process"
import { browser, expect } from "@wdio/globals"

// The app process serving our WebDriver port; by port so a sibling worktree's app is never touched.
const appPid = () =>
  Number(
    execSync(`lsof -ti tcp:${browser.options.port} -sTCP:LISTEN`).toString()
  )

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let relaunched: ChildProcess | undefined
// The next worker relaunches the app it finds dead.
process.once("exit", () => relaunched?.kill())

// reloadSession keeps the app process the service launched once per run, so restart by ending it (kill by default) and spawning the same binary.
export async function restartApp(
  quit: (pid: number) => unknown = (pid) => process.kill(pid)
) {
  // The webview's recorded CSP violations die with the process, so report them first.
  const seen = await browser.execute(() =>
    sessionStorage.getItem("ceo-e2e-csp")
  )
  if (seen) throw new Error(`CSP violations: ${seen}`)
  const old = appPid()
  await quit(old)
  await browser.waitUntil(() => !alive(old))
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
