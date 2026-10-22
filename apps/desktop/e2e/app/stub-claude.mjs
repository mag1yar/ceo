#!/usr/bin/env node
// Stand-in for `claude` in the hidden app: posts its --settings hooks, honours their answers and speaks MCP to the real shim.
import { execFileSync, execSync, spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"))
const resumed = arg("--resume") !== undefined
const id = arg("--resume") ?? arg("--session-id")
const role = arg("--append-system-prompt")?.startsWith("You are an executor")
  ? "executor"
  : "ceo"
const brief = args.includes("--")
  ? args.slice(args.indexOf("--") + 1).join(" ")
  : undefined
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A hook's answer, parsed: http hooks answer in the body, command hooks on stdout.
async function post(event, extra = {}) {
  const body = JSON.stringify({
    session_id: id,
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  })
  let answer
  for (const hook of settings.hooks[event]?.[0]?.hooks ?? []) {
    if (hook.type === "command") execSync(hook.command, { input: body })
    else {
      const text = await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...hook.headers },
        body,
      }).then(
        (r) => r.text(),
        () => ""
      )
      if (text) answer = JSON.parse(text)
    }
  }
  return answer
}

const out = (s) => process.stdout.write(s)
const say = (s) => out(`\r\n  ${s}`)

// MCP client over the shim's stdio, newline-delimited JSON-RPC.
const server = arg("--mcp-config")
  ? JSON.parse(readFileSync(arg("--mcp-config"), "utf8")).mcpServers.ceo
  : undefined
const shim =
  server &&
  spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "ignore"],
  })
let seq = 0
const pending = new Map()
let buf = ""
shim?.stdout.setEncoding("utf8")
shim?.stdout.on("data", (d) => {
  buf += d
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const m = JSON.parse(buf.slice(0, i))
    buf = buf.slice(i + 1)
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
})
const rpc = (method, params) =>
  new Promise((resolve) => {
    const n = ++seq
    pending.set(n, resolve)
    shim.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`
    )
  })

// One tool use as claude makes it: PreToolUse, the call, PostToolUse, then whatever the hook hands over.
async function tool(name, input = {}) {
  const tool_name = `mcp__ceo__${name}`
  await post("PreToolUse", { tool_name, tool_input: input })
  const r = await rpc("tools/call", { name, arguments: input })
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error)
  say(`${name}: ${text.split("\n")[0].slice(0, 70)}`)
  const answer = await post("PostToolUse", {
    tool_name,
    tool_input: input,
    tool_response: r.result?.content,
  })
  await handle(answer?.hookSpecificOutput?.additionalContext)
  return text
}

async function bash(command, run) {
  await post("PreToolUse", { tool_name: "Bash", tool_input: { command } })
  run()
  const answer = await post("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command },
  })
  await handle(answer?.hookSpecificOutput?.additionalContext)
}

// Messages as the bus renders them: "- id <id> · <kind> from <node>: <body>".
async function handle(text) {
  let asked = false
  for (const [, mid, kind] of (text ?? "").matchAll(
    /^- id (\w+) · (\w+) from /gm
  )) {
    if (kind === "ask") {
      asked = true
      await tool("reply", { id: mid, body: "hello.txt" })
    } else {
      // A few seconds, as a real CEO reads a report before it accepts.
      if (kind === "report") await sleep(3000)
      await tool("accept", { id: mid })
    }
  }
  return asked
}

// A submitted prompt; its hook may bring messages that waited for a free pane.
async function prompt(text) {
  const answer = await post("UserPromptSubmit", { prompt: text })
  return handle(answer?.hookSpecificOutput?.additionalContext)
}

async function stop() {
  const answer = await post("Stop", { stop_hook_active: false })
  if (answer?.decision === "block") {
    await handle(answer.reason)
    await post("Stop", { stop_hook_active: true })
  }
}

// A task that says "idle" gets its report typed into the idle CEO, as with a real claude, instead of on the CEO's Stop.
let idleReport = false

// CEO: a typed task becomes one executor, with a note it gets while busy.
async function task(line) {
  await prompt(line)
  idleReport = line.includes("idle")
  const spawned = await tool("spawn_executor", {
    title: line,
    brief: `Write the file the CEO names, commit it, check it exists, then report.${idleReport ? " Pause before you report." : ""}`,
  })
  const { node } = JSON.parse(spawned.split("\n")[0])
  await tool("send", { to: node, body: "Keep it to one file." })
  await stop()
}

// The typed pointer: read the inbox; after answering an ask, think a while so the report lands on this turn's Stop.
async function pointer(line) {
  const asked = await prompt(line)
  if (((await handle(await tool("inbox"))) || asked) && !idleReport)
    await sleep(3000)
  await stop()
}

async function execute() {
  await prompt(brief)
  let r = await tool("ask", { body: "Which file should I write?" })
  while (r.includes('"pending"'))
    r = await tool("ask", { resume: JSON.parse(r.split("\n")[0]).pending })
  const [, reply, file] = r.match(/^Reply id (\w+) to your ask: (.*)$/m)
  await tool("accept", { id: reply })
  const git = (...a) =>
    execFileSync("git", [
      "-c",
      "user.name=stub",
      "-c",
      "user.email=stub@ceo",
      "-c",
      "commit.gpgsign=false",
      ...a,
    ])
  await bash(`git commit -m "Add ${file}"`, () => {
    writeFileSync(file, "hello\n")
    git("add", file)
    git("commit", "-qm", `Add ${file}`)
  })
  if (brief.includes("Pause before you report")) await sleep(2000)
  await tool("report", {
    body: `Committed ${file}; check test -f ${file}: passed`,
  })
  await stop()
}

// The identity line sits last, by the prompt, so a small node that shows only the bottom rows still has it.
out(
  `  ${process.cwd()}\r\n  deny: ${settings.permissions.deny.join(", ")}\r\n\x1b[38;2;217;119;87m✻\x1b[0m \x1b[1mStub Claude\x1b[0m · ${resumed ? "resumed" : "new"} · ${id}\r\n❯ `
)
await post("SessionStart", { source: resumed ? "resume" : "startup" })
if (shim) {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stub-claude", version: "0" },
  })
  shim.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
  )
}
if (role === "executor" && brief && !resumed) await execute()

const words = {
  work: async () => {
    await prompt("work")
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
  for (const line of text.split(/[\r\n]+/).filter((l) => l.trim())) {
    const ws = line.split(/\s+/).filter(Boolean)
    if (line.includes("mcp__ceo__inbox")) await pointer(line)
    else if (ws.every((w) => w in words)) for (const w of ws) await words[w]()
    else if (role === "ceo" && shim) await task(line.trim())
  }
  out("\r\n❯ ")
})
process.on("SIGHUP", async () => {
  await post("SessionEnd", { reason: "other" })
  process.exit(0)
})
