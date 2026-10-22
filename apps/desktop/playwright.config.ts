import { defineConfig } from "@playwright/test"
import { worktreePort } from "./e2e/port"

const port = Number(process.env.E2E_PORT) || worktreePort(1421)
const url = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL: url,
    browserName: "webkit",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: "light", use: { colorScheme: "light" } },
    { name: "dark", use: { colorScheme: "dark" } },
  ],
  webServer: {
    command: `vite --mode e2e --host 127.0.0.1 --port ${port} --strictPort`,
    url,
    reuseExistingServer: false,
  },
})
