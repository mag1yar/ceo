#!/usr/bin/env node
// Stand-in for `claude` in the hidden app: posts its --settings hooks, honours their answers and speaks MCP to the real shim.
import { execFileSync, execSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}
const settings = JSON.parse(readFileSync(arg("--settings"), "utf8"))
const resumed = arg("--resume") !== undefined
let id = arg("--resume") ?? arg("--session-id")
const prompt0 = arg("--append-system-prompt") ?? ""
const role = prompt0.startsWith("You are an executor")
  ? "executor"
  : prompt0.startsWith("You are a Lead")
    ? "lead"
    : "ceo"
const brief = args.includes("--")
  ? args.slice(args.indexOf("--") + 1).join(" ")
  : undefined
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A transcript in Claude Code's JSONL shape, one file per session id as a /clear starts a new one.
const transcripts = `${process.env.HOME}/.claude/projects/stub`
const transcript = () => `${transcripts}/${id}.jsonl`
let turns = 0
// One turn: the first writes the 1h cache, later ones read it; a response spans two lines with one message id.
function turn() {
  const first = turns++ === 0
  const usage = {
    input_tokens: first ? 3 : 2,
    cache_creation_input_tokens: first ? 6500 : 300,
    cache_read_input_tokens: first ? 11300 : 17800 + turns * 300,
    output_tokens: 40,
    cache_creation: {
      ephemeral_1h_input_tokens: first ? 6500 : 300,
      ephemeral_5m_input_tokens: 0,
    },
  }
  const line = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    sessionId: id,
    message: { id: `msg_${randomUUID()}`, role: "assistant", usage },
  }
  mkdirSync(transcripts, { recursive: true })
  appendFileSync(transcript(), `${JSON.stringify(line)}\n`.repeat(2))
}

// What SessionStart answered, which the stub answers questions from.
let primed = ""

// A hook's answer, parsed: http hooks answer in the body, command hooks on stdout.
async function post(event, extra = {}) {
  if (event === "Stop" && !extra.stop_hook_active) turn()
  const body = JSON.stringify({
    session_id: id,
    transcript_path: transcript(),
    cwd: process.cwd(),
    hook_event_name: event,
    ...extra,
  })
  let answer
  for (const hook of settings.hooks[event]?.[0]?.hooks ?? []) {
    if (hook.type === "command") {
      const text = execSync(hook.command, { input: body }).toString()
      if (text.trim()) answer = JSON.parse(text)
    } else {
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
  for (const [, mid, kind, from] of (text ?? "").matchAll(
    /^- id (\w+) · (\w+) from ([\w-]+):/gm
  )) {
    if (role === "lead") await lead.handle(mid, kind, from)
    else if (kind === "ask") {
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

// CEO: a typed task becomes one executor, with a note it gets while busy; tasks split by ";" become one Lead.
async function task(line) {
  await prompt(line)
  const tasks = line.split(";").map((t) => t.trim().split(/\s+/).pop())
  if (tasks.length > 1) {
    const spawned = await tool("spawn_lead", {
      title: `Team of ${tasks.length}`,
      brief: `Tasks: ${tasks.join("; ")}\nGate: sh gate.sh`,
    })
    const { node } = JSON.parse(spawned.split("\n")[0])
    await tool("send", { to: node, body: "Merge each into your branch." })
    return stop()
  }
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
    .toString()
    .trim()

// Lead: one executor per task, answers their asks, reviews and merges each report, then the gate and one report up.
const lead = {
  team: new Map(),
  merged: [],
  seen: new Set(),
  // Asks that came before their spawn call returned the asker's node.
  later: [],
  ceo: undefined,
  total: 0,
  async run() {
    await prompt(brief)
    // The CEO's note names the CEO, which one executor probes with a send it must not be allowed.
    for (let i = 0; i < 50 && !lead.ceo; i++) {
      await handle(await tool("inbox"))
      if (!lead.ceo) await sleep(100)
    }
    const files = brief.match(/^Tasks: (.*)$/m)[1].split("; ")
    lead.total = files.length
    for (const [i, file] of files.entries()) {
      const probe = i === 0 && lead.ceo ? `\nProbe: ${lead.ceo}` : ""
      const spawned = await tool("spawn_executor", {
        title: `Write ${file}`,
        brief: `Write the file your Lead names, commit it, check it exists, then report.${probe}`,
        files: [file],
      })
      const { node, branch } = JSON.parse(spawned.split("\n")[0])
      lead.team.set(node, { file, branch })
    }
    for (const m of lead.later.splice(0)) await lead.handle(...m)
    await stop()
  },
  async handle(mid, kind, from) {
    if (lead.seen.has(mid)) return
    const member = lead.team.get(from)
    if (kind === "ask" && !member) return lead.later.push([mid, kind, from])
    lead.seen.add(mid)
    if (kind === "ask") return tool("reply", { id: mid, body: member.file })
    if (kind !== "report" || !member) {
      if (kind === "send") lead.ceo ??= from
      return tool("accept", { id: mid })
    }
    // A one-file change is trivial, so the stub reads the diff itself (a while, as a real Lead) and spawns no review executor.
    await sleep(2000)
    const me = git("rev-parse", "--abbrev-ref", "HEAD")
    await bash(`git diff ${me}...${member.branch}`, () =>
      git("diff", `${me}...${member.branch}`)
    )
    await bash(`git merge --no-ff ${member.branch}`, () =>
      git("merge", "--no-ff", "-m", `Merge ${member.branch}`, member.branch)
    )
    lead.merged.push(member.branch)
    await tool("accept", { id: mid })
    if (lead.merged.length === lead.total) await lead.finish()
  },
  async finish() {
    const gate = brief.match(/^Gate: (.*)$/m)[1]
    let output = ""
    await bash(gate, () => {
      output = execSync(gate).toString().trim()
    })
    const merges = git("log", "--merges", "--format=%s").split("\n")
    await tool("report", {
      body: `Merged ${merges.length}: ${merges.join(", ")}; gate ${gate}: ${output}`,
    })
  },
}

async function start(source) {
  const answer = await post("SessionStart", { source })
  primed = answer?.hookSpecificOutput?.additionalContext ?? ""
}

// /clear: a new session id, and SessionStart brings the prime again.
async function clear() {
  id = randomUUID()
  turns = 0
  await start("clear")
  say(`Cleared · ${id} · prime ${primed.length} chars`)
}

// A question is answered from the prime alone: its core.md lines and the wave state.
async function answer(line) {
  await prompt(line)
  const core = primed.split("## core.md\n")[1]?.split("\n## ")[0] ?? ""
  const wave = primed.split("\n").find((l) => l.startsWith("Wave state:"))
  for (const l of [...core.split("\n"), wave ?? "No wave state"])
    if (l.trim()) say(`> ${l}`)
  await stop()
}

async function execute() {
  await prompt(brief)
  let r = await tool("ask", { body: "Which file should I write?" })
  while (r.includes('"pending"'))
    r = await tool("ask", { resume: JSON.parse(r.split("\n")[0]).pending })
  const [, reply, file] = r.match(/^Reply id (\w+) to your ask: (.*)$/m)
  await tool("accept", { id: reply })
  await bash(`git commit -m "Add ${file}"`, () => {
    writeFileSync(file, "hello\n")
    git("add", file)
    git("commit", "-qm", `Add ${file}`)
  })
  if (brief.includes("Pause before you report")) await sleep(2000)
  const probe = brief.match(/^Probe: (\S+)$/m)?.[1]
  const sent = probe
    ? `; send to the CEO: ${await tool("send", { to: probe, body: "Done here." })}`
    : ""
  await tool("report", {
    body: `Committed ${file}; check test -f ${file}: passed${sent}`,
  })
  await stop()
}

// The identity line sits last, by the prompt, so a small node that shows only the bottom rows still has it.
out(
  `  ${process.cwd()}\r\n  deny: ${settings.permissions.deny.join(", ")}\r\n\x1b[38;2;217;119;87m✻\x1b[0m \x1b[1mStub Claude\x1b[0m · ${resumed ? "resumed" : "new"} · ${id}\r\n❯ `
)
await start(resumed ? "resume" : "startup")
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
if (role === "lead" && brief && !resumed) await lead.run()

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
    else if (line.trim() === "/clear") await clear()
    else if (role === "ceo" && line.trim().endsWith("?")) await answer(line)
    else if (ws.every((w) => w in words)) for (const w of ws) await words[w]()
    else if (role === "ceo" && shim) await task(line.trim())
  }
  out("\r\n❯ ")
})
process.on("SIGHUP", async () => {
  await post("SessionEnd", { reason: "other" })
  process.exit(0)
})
