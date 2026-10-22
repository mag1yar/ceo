/// <reference types="@wdio/mocha-framework" />
import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { $, $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import type { Message } from "../../src/features/messages/messages"
import type { AgentSession, BoardNode } from "../../src/lib/store"
import { invoke } from "./lib/projects"

type Term = { input: (data: string, user: boolean) => void }
type Internals = {
  invoke: (cmd: string, args: object) => Promise<unknown>
  transformCallback: (cb: (e: { payload: unknown }) => void) => number
}
type Win = {
  e2e: { terminals: Record<string, Term> }
  __TAURI_INTERNALS__: Internals
  busLog: Message[]
}

const ceo = {
  ...(buildTeam().nodes.find((n) => n.type === "ceo") as BoardNode),
  x: 0,
  y: 0,
}

// This run's own socket from wdio.conf, never the default one or the app's `ceo`.
const tmux = (...args: string[]) => {
  try {
    return execFileSync(
      process.env.CEO_TMUX_BIN ?? "tmux",
      ["-L", process.env.CEO_E2E_TMUX ?? "", ...args],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim()
  } catch {
    return ""
  }
}
const has = (name: string) => {
  try {
    execFileSync(
      process.env.CEO_TMUX_BIN ?? "tmux",
      ["-L", process.env.CEO_E2E_TMUX ?? "", "has-session", "-t", `=${name}`],
      { stdio: "ignore" }
    )
    return true
  } catch {
    return false
  }
}
const git = (dir: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=e2e", "-c", "user.email=e2e@ceo", ...args],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
    .toString()
    .trim()

const node = (id: string) => $(`.react-flow__node[data-id="${id}"]`)
const executors = () => $$(".react-flow__node-executor")
const busLog = () =>
  browser.execute(() => (window as unknown as Win).busLog) as Promise<Message[]>

async function scheme() {
  return (await browser.execute(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  ))
    ? "dark"
    : "light"
}

describe("bus: the CEO spawns an executor that reports back", function () {
  this.timeout(180000)
  // realpath: git and tmux report /private/tmp for /tmp.
  const repo = realpathSync(mkdtempSync("/tmp/ceo-e2e-bus-"))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  let projectId = ""
  let ceoTrustKey = ""
  // The throwaway HOME's Claude Code state, where the app marks its worktrees trusted.
  const trusted = () =>
    JSON.parse(readFileSync(`${process.env.CEO_E2E_HOME}/.claude.json`, "utf8"))
      .projects as Record<string, { hasTrustDialogAccepted?: boolean }>

  before(async () => {
    mkdirSync("test-results-app", { recursive: true })
    projectId = (
      await invoke<{ id: string }>("project_create", {
        name: "bus",
        path: repo,
      })
    ).id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [ceo],
        viewport: { x: 40, y: 160, zoom: 0.5 },
      },
    })
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${repo}"]`).click()
    await node(ceo.id).waitForExist({ timeout: 20000 })
    // Every bus://message from here on, in order, as the board receives them.
    await browser.execute(() => {
      const w = window as unknown as Win
      w.busLog = []
      const handler = w.__TAURI_INTERNALS__.transformCallback((e) =>
        w.busLog.push(e.payload as Message)
      )
      return w.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
        event: "bus://message",
        target: { kind: "Any" },
        handler,
      })
    })
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(repo, { recursive: true, force: true })
  })

  it("task typed into the CEO: executor spawned, reports, is accepted and leaves its branch", async () => {
    await browser.waitUntil(
      async () =>
        (await invoke<AgentSession[]>("session_list")).some(
          (s) => s.projectId === projectId && s.status === "idle"
        ),
      { timeout: 20000, timeoutMsg: "the CEO session never got ready" }
    )
    const ceoRow = (await invoke<AgentSession[]>("session_list")).find(
      (s) => s.projectId === projectId
    ) as AgentSession
    ceoTrustKey = realpathSync(ceoRow.worktree as string)
    expect(trusted()[ceoTrustKey]).toEqual({ hasTrustDialogAccepted: true })
    expect(trusted()[repo]).toBeUndefined()
    await node(ceo.id).$("button[aria-label='Focus terminal']").click()
    await browser.execute(
      (id) =>
        (window as unknown as Win).e2e.terminals[id].input(
          "Add a hello file\r",
          true
        ),
      ceo.id
    )
    await node(ceo.id).$("button[aria-label='Exit focus']").click()

    // The node and its link to the CEO appear without a reload.
    await browser.waitUntil(async () => (await executors().length) === 1, {
      timeout: 20000,
      timeoutMsg: "no executor node appeared",
    })
    const execId = (await executors()[0].getAttribute("data-id")) as string
    expect(await $$(".react-flow__edge").length).toBe(1)
    const exec = (await invoke<AgentSession[]>("session_list")).find(
      (s) => s.nodeId === execId
    ) as AgentSession
    expect(exec.role).toBe("executor")
    expect(exec.branch).toMatch(/^ceo\/exec-add-a-hello-file-/)
    expect(existsSync(`${exec.worktree}/.git`)).toBe(true)
    const execTrustKey = realpathSync(exec.worktree as string)
    expect(trusted()[execTrustKey]).toEqual({ hasTrustDialogAccepted: true })
    expect(git(repo, "branch", "--list", exec.branch as string)).toContain(
      exec.branch
    )
    expect(has(exec.tmuxName)).toBe(true)

    // The report waits at the CEO for a moment before the CEO accepts it.
    const signal = $(`[data-slot=signal][data-kind=report][data-state=waiting]`)
    await signal.waitForExist({
      timeout: 30000,
      timeoutMsg: "no report signal",
    })
    await browser.saveScreenshot(
      `test-results-app/bus-report-${await scheme()}.png`
    )

    await browser.waitUntil(async () => (await executors().length) === 0, {
      timeout: 60000,
      timeoutMsg: "the executor node stayed on the board",
    })
    const log = await busLog()
    const last = new Map(log.map((m) => [m.id, m]))
    const report = [...last.values()].find((m) => m.kind === "report")
    expect(report?.from).toBe(execId)
    expect(log.filter((m) => m.id === report?.id).map((m) => m.state)).toEqual([
      "sent",
      "waiting",
      "accepted",
    ])
    // Every message got all three states, each through one delivery path; the CEO's note reaches the booting executor with its brief.
    for (const m of last.values()) {
      expect(log.filter((x) => x.id === m.id).map((x) => x.state)).toEqual([
        "sent",
        "waiting",
        "accepted",
      ])
    }
    expect(
      [...last.values()].map((m) => `${m.kind} ${m.deliveredVia}`).sort()
    ).toEqual([
      "ask typed",
      "reply post_tool_use",
      "report stop",
      "send user_prompt_submit",
    ])
    // Latencies for the #19 comment, ms from the bus's own timestamps.
    for (const m of last.values())
      console.log(
        `bus latency: ${m.kind} via ${m.deliveredVia}: sent->waiting ${(m.waitingAt ?? 0) - m.sentAt} ms, waiting->accepted ${(m.acceptedAt ?? 0) - (m.waitingAt ?? 0)} ms`
      )

    // The executor is gone; its branch stays with its commit.
    await browser.waitUntil(() => !has(exec.tmuxName), {
      timeoutMsg: "the executor's tmux session survived",
    })
    expect(existsSync(exec.worktree as string)).toBe(false)
    expect(trusted()[execTrustKey]).toBeUndefined()
    expect(git(repo, "log", "-1", "--format=%s", exec.branch as string)).toBe(
      "Add hello.txt"
    )
    expect(
      (await invoke<AgentSession[]>("session_list")).some(
        (s) => s.nodeId === execId
      )
    ).toBe(false)
    const board = await invoke<{ nodes: BoardNode[]; edges: unknown[] }>(
      "board_load",
      { projectId }
    )
    expect(board.nodes.map((n) => n.id)).toEqual([ceo.id])
    expect(board.edges).toEqual([])
  })

  it("leaves no tmux session or worktree of the project behind", async () => {
    const sessions = (await invoke<AgentSession[]>("session_list")).filter(
      (s) => s.projectId === projectId
    )
    await invoke("project_delete", { id: projectId })
    expect(sessions.length).toBe(1)
    for (const s of sessions) expect(has(s.tmuxName)).toBe(false)
    expect(tmux("list-sessions", "-F", "#{session_name}")).not.toMatch(
      /^executor-/m
    )
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1)
    expect(trusted()[ceoTrustKey]).toBeUndefined()
    // Only the executor's branch stays: the owner merges it.
    expect(git(repo, "branch", "--list", "ceo/*")).toMatch(
      /^\s*ceo\/exec-add-a-hello-file-\w+$/
    )
  })
})
