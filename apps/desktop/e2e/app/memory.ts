/// <reference types="@wdio/mocha-framework" />
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { $, $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import type { AgentSession, BoardNode, Usage } from "../../src/lib/store"
import { invoke } from "./lib/projects"

type Term = { input: (data: string, user: boolean) => void }
type Win = { e2e: { terminals: Record<string, Term> } }

const ceo = {
  ...(buildTeam().nodes.find((n) => n.type === "ceo") as BoardNode),
  x: 0,
  y: 0,
}
const FACT = "The owner's codeword is PLUM-7731."

// This run's own socket from wdio.conf, never the default one or the app's `ceo`.
const tmux = (...args: string[]) =>
  execFileSync(
    process.env.CEO_TMUX_BIN ?? "tmux",
    ["-L", process.env.CEO_E2E_TMUX ?? "", ...args],
    { stdio: ["ignore", "pipe", "ignore"] }
  ).toString()
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim()

const node = (id: string) => $(`.react-flow__node[data-id="${id}"]`)
const executors = () => $$(".react-flow__node-executor")
const sessions = () => invoke<AgentSession[]>("session_list")

async function type(text: string) {
  await node(ceo.id).$("button[aria-label='Focus terminal']").click()
  await browser.execute(
    (id, text) =>
      (window as unknown as Win).e2e.terminals[id].input(text, true),
    ceo.id,
    text
  )
  await node(ceo.id).$("button[aria-label='Exit focus']").click()
}

describe("memory: the CEO keeps what it knows across /clear, every session's tokens are recorded", function () {
  this.timeout(180000)
  // realpath: git and tmux report /private/tmp for /tmp.
  const repo = realpathSync(mkdtempSync("/tmp/ceo-e2e-memory-"))
  git(repo, "init", "-q", "-b", "main")
  git(
    repo,
    "-c",
    "user.name=e2e",
    "-c",
    "user.email=e2e@ceo",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init"
  )
  let projectId = ""
  let memory = ""
  let ceoRow: AgentSession
  const pane = () =>
    tmux("capture-pane", "-p", "-J", "-S", "-300", "-t", `=${ceoRow.tmuxName}:`)
  const current = async () =>
    (await sessions()).find((s) => s.id === ceoRow.id) as AgentSession

  before(async () => {
    projectId = (
      await invoke<{ id: string }>("project_create", {
        name: "memory",
        path: repo,
      })
    ).id
    // Written before the CEO's first start; the app makes the folder a git repo on first use.
    memory = `${process.env.CEO_E2E_HOME}/Library/Application Support/app.ceo.desktop.e2e/memory/${projectId}`
    mkdirSync(memory, { recursive: true })
    writeFileSync(`${memory}/core.md`, `# Core\n${FACT}\n`)
    await invoke("board_save", {
      projectId,
      changes: { upsertNodes: [ceo], viewport: { x: 40, y: 160, zoom: 0.5 } },
    })
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${repo}"]`).click()
    await node(ceo.id).waitForExist({ timeout: 20000 })
    await browser.waitUntil(
      async () =>
        (await sessions()).some(
          (s) => s.projectId === projectId && s.status === "idle"
        ),
      { timeout: 20000, timeoutMsg: "the CEO session never got ready" }
    )
    ceoRow = (await sessions()).find(
      (s) => s.projectId === projectId
    ) as AgentSession
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(repo, { recursive: true, force: true })
  })

  it("after /clear the CEO answers with the core.md fact and the wave state, under a new session id", async () => {
    const before = ceoRow.claudeSessionId
    await type("/clear\r")
    await browser.waitUntil(
      async () => (await current()).claudeSessionId !== before,
      {
        timeout: 20000,
        timeoutMsg: "the row kept the pre-clear session id",
      }
    )
    await browser.waitUntil(
      () => /Cleared · .* · prime \d+ chars/.test(pane()),
      {
        timeout: 10000,
      }
    )
    await type("What do you remember about the owner and the wave?\r")
    await browser.waitUntil(() => pane().includes(`> ${FACT}`), {
      timeout: 20000,
      timeoutMsg: `no answer with the fact: ${pane()}`,
    })
    const answer = pane()
    console.log(
      `memory: ${answer.match(/prime \d+ chars/)?.[0]} for the e2e CEO`
    )
    expect(answer).toContain(
      "> Wave state: no executors live, 0 unaccepted messages for you"
    )
    console.log(
      `memory: answer after /clear:\n${answer
        .split("\n")
        .filter((l) => l.includes("> "))
        .join("\n")}`
    )
    // The CEO's Stop committed the folder as it found it.
    await browser.waitUntil(
      () => git(memory, "log", "--format=%s").includes("memory: core.md"),
      {
        timeout: 10000,
        timeoutMsg: "the memory repo has no commit",
      }
    )
    expect(git(memory, "config", "--local", "user.name")).toBe("CEO memory")
  })

  it("an executor run records tokens for every session and the wave boundary clears the CEO", async () => {
    const before = (await current()).claudeSessionId
    await type("Add a hello file\r")
    await browser.waitUntil(async () => (await executors().length) === 1, {
      timeout: 20000,
      timeoutMsg: "no executor node appeared",
    })
    const execId = (await executors()[0].getAttribute("data-id")) as string
    const exec = (await sessions()).find(
      (s) => s.nodeId === execId
    ) as AgentSession
    await browser.waitUntil(async () => (await executors().length) === 0, {
      timeout: 60000,
      timeoutMsg: "the executor node stayed on the board",
    })
    // No child left and nothing unaccepted: the app types /clear into the idle CEO.
    await browser.waitUntil(
      async () => (await current()).claudeSessionId !== before,
      {
        timeout: 30000,
        timeoutMsg: "the CEO was not cleared at the wave boundary",
      }
    )
    const usage = await invoke<Usage[]>("usage_list", { projectId })
    console.log(`memory: usage ${JSON.stringify(usage)}`)
    for (const id of [ceoRow.id, exec.id]) {
      const u = usage.find((x) => x.sessionId === id) as Usage
      expect(u).toBeDefined()
      expect(u.input).toBeGreaterThan(0)
      expect(u.output).toBeGreaterThan(0)
      expect(u.cacheRead).toBeGreaterThan(0)
      expect(u.cacheWrite1h).toBeGreaterThan(0)
      expect(u.firstPrompt).toBe(3 + 11300 + 6500)
    }
    expect(usage.find((x) => x.sessionId === exec.id)?.role).toBe("executor")
    expect(usage.find((x) => x.sessionId === exec.id)?.task).toBe(
      "Add a hello file"
    )
    const ceoUsage = usage.find((x) => x.sessionId === ceoRow.id) as Usage
    expect(ceoUsage.waveContexts.length).toBe(1)
    expect(ceoUsage.waveContexts[0]).toBeGreaterThan(0)
  })
})
