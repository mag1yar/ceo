/// <reference types="@wdio/globals/types" />
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { worktreePort } from "./e2e/port"

// Throwaway HOME per run puts app_data_dir (ceo.db) there; WebKit storage is in memory via `incognito`.
// This file also loads in each worker: only the launcher makes a fresh dir, workers inherit it.
const home = process.env.WDIO_WORKER_ID
  ? (process.env.CEO_E2E_HOME ?? "")
  : mkdtempSync(join(tmpdir(), "ceo-e2e-"))
process.env.CEO_E2E_HOME = home
const port = Number(process.env.TAURI_WEBDRIVER_PORT) || worktreePort(4445)

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/app/*.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      // Separate target dir (relative to src-tauri, where cargo runs) so e2e builds never overwrite the dev binary.
      "tauri:options": { application: "src-tauri/target/e2e/debug/ceo" },
    } as WebdriverIO.Capabilities,
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        embeddedPort: port,
        env: { HOME: process.env.CEO_E2E_HOME },
        captureBackendLogs: true,
      },
    ],
  ],
  // An explicit switch stops the service probing window focus through tauri-plugin-wdio, which we do not ship.
  before: async (_caps, _specs, browser) =>
    browser.switchToWindow(await browser.getWindowHandle()),
  onComplete: () => rmSync(home, { recursive: true, force: true }),
  framework: "mocha",
  mochaOpts: {
    rootHooks: {
      // Fails the test on any CSP violation the e2e init script recorded, clearing them so later tests start clean.
      async afterEach() {
        const seen = await browser.execute(() => {
          const seen = sessionStorage.getItem("ceo-e2e-csp")
          sessionStorage.removeItem("ceo-e2e-csp")
          return seen
        })
        if (seen) throw new Error(`CSP violations: ${seen}`)
      },
    },
  },
  reporters: ["spec"],
  logLevel: "warn",
}
