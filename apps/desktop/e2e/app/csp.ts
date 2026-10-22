/// <reference types="@wdio/mocha-framework" />
import { browser, expect } from "@wdio/globals"
import { invoke } from "./lib/projects"

// Each probe runs inside the webview and reports whether the blocked code ran.
describe("content security policy in the hidden app", () => {
  // Violations made on purpose here must not trip the run-wide check in wdio.conf.
  const forgetViolations = () =>
    browser.execute(() => sessionStorage.removeItem("ceo-e2e-csp"))

  it("serves the strict policy on the app document", async () => {
    const csp = await browser.execute(async () =>
      (await fetch(location.href)).headers.get("content-security-policy")
    )
    console.log(`effective CSP: ${csp}`)
    const script = csp?.match(/script-src ([^;]*)/)?.[1] ?? ""
    expect(script).toMatch(/^'self'/)
    expect(script).not.toContain("unsafe")
    for (const d of [
      "default-src 'self'",
      "connect-src 'self' ipc: http://ipc.localhost",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ])
      expect(csp).toContain(d)
  })

  it("refuses eval", async () => {
    const result = await browser.execute(() => {
      try {
        // biome-ignore lint/security/noGlobalEval: the probe checks that CSP blocks it.
        return String(eval("1"))
      } catch (e) {
        return (e as Error).name
      }
    })
    expect(result).toBe("EvalError")
    await forgetViolations()
  })

  it("does not run an injected script element or inline handler", async () => {
    const ran = await browser.executeAsync((done: (v: unknown) => void) => {
      const w = window as unknown as Record<string, unknown>
      const script = document.createElement("script")
      script.textContent = "window.__cspScript = true"
      document.body.append(script)
      const img = document.createElement("img")
      img.setAttribute("onerror", "window.__cspHandler = true")
      img.src = "data:,broken"
      document.body.append(img)
      // The image fails to decode within a frame; wait a little longer before reading the flags.
      setTimeout(() => {
        script.remove()
        img.remove()
        done({
          script: w.__cspScript ?? false,
          handler: w.__cspHandler ?? false,
        })
      }, 300)
    })
    expect(ran).toEqual({ script: false, handler: false })
    const seen = await browser.execute(() =>
      sessionStorage.getItem("ceo-e2e-csp")
    )
    expect(seen).toContain("script-src-elem inline")
    expect(seen).toContain("script-src-attr inline")
    await forgetViolations()
  })

  it("keeps IPC working", async () => {
    expect(Array.isArray(await invoke("project_list"))).toBe(true)
  })
})
