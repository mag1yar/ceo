/// <reference types="@wdio/globals/types" />
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { worktreePort } from "./e2e/port"

// Throwaway HOME per run puts app_data_dir (ceo.db) there; WebKit storage is in memory via `incognito`.
process.env.CEO_E2E_HOME ??= mkdtempSync(join(tmpdir(), "ceo-e2e-"))
const port = Number(process.env.TAURI_WEBDRIVER_PORT) || worktreePort(4445)

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/app/*.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: "src-tauri/target/debug/ceo" },
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
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
}
