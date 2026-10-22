#!/usr/bin/env node
// Stand-in for `claude` in the hidden app: draws a prompt and posts the hooks it gets in --settings, driven by typed words.
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"))
const resumed = arg("--resume") !== undefined
const id = arg("--resume") ?? arg("--session-id")

async function post(event, extra = {}) {
  const body = JSON.stringify({
    session_id: id,
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  })
  for (const hook of settings.hooks[event]?.[0]?.hooks ?? []) {
    if (hook.type === "command") execSync(hook.command, { input: body })
    else
      await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...hook.headers },
        body,
      }).catch(() => {})
  }
}

const out = (s) => process.stdout.write(s)
// The identity line sits last, by the prompt, so a small node that shows only the bottom rows still has it.
out(
  `  ${process.cwd()}\r\n  deny: ${settings.permissions.deny.join(", ")}\r\n\x1b[38;2;217;119;87m✻\x1b[0m \x1b[1mStub Claude\x1b[0m · ${resumed ? "resumed" : "new"} · ${id}\r\n❯ `
)
await post("SessionStart", { source: resumed ? "resume" : "startup" })

const words = {
  work: async () => {
    await post("UserPromptSubmit", { prompt: "work" })
    await post("PreToolUse", { tool_name: "Bash" })
    out("✻ Working… (esc to interrupt)\r\n")
  },
  ask: () => post("PermissionRequest", { tool_name: "Edit" }),
  stop: async () => {
    await post("PostToolUse", { tool_name: "Bash" })
    await post("Stop")
  },
  fail: () =>
    post("StopFailure", {
      error: "rate_limit",
      last_assistant_message: "API Error: Rate limit reached",
    }),
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", async (text) => {
  for (const word of text.split(/\s+/).filter(Boolean)) await words[word]?.()
  out("❯ ")
})
process.on("SIGHUP", async () => {
  await post("SessionEnd", { reason: "other" })
  process.exit(0)
})
