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
const leads = () => $$(".react-flow__node-lead")
const executors = () => $$(".react-flow__node-executor")
const busLog = () =>
  browser.execute(() => (window as unknown as Win).busLog) as Promise<Message[]>
const sessions = () => invoke<AgentSession[]>("session_list")

async function scheme() {
  return (await browser.execute(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  ))
    ? "dark"
    : "light"
}

describe("team: several tasks go to one Lead, which runs, merges and gates them", function () {
  this.timeout(240000)
  // realpath: git and tmux report /private/tmp for /tmp.
  const repo = realpathSync(mkdtempSync("/tmp/ceo-e2e-team-"))
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(
    `${repo}/gate.sh`,
    'test -f one.txt && test -f two.txt && test -f three.txt && echo "gate: 3 files ok"\n'
  )
  git(repo, "add", "gate.sh")
  git(repo, "commit", "-q", "-m", "init")
  let projectId = ""

  before(async () => {
    mkdirSync("test-results-app", { recursive: true })
    projectId = (
      await invoke<{ id: string }>("project_create", {
        name: "team",
        path: repo,
      })
    ).id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [ceo],
        // Low enough that the CEO's inspector, top right, never covers the team.
        viewport: { x: 20, y: 300, zoom: 0.36 },
      },
    })
    await browser.execute(() => location.reload())
    await $(`ul[aria-label=Projects] button[title="${repo}"]`).click()
    await node(ceo.id).waitForExist({ timeout: 20000 })
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

  it("three tasks typed into the CEO: one Lead, three executors off its branch, merged, gated and reported", async () => {
    await browser.waitUntil(
      async () =>
        (await sessions()).some(
          (s) => s.projectId === projectId && s.status === "idle"
        ),
      { timeout: 20000, timeoutMsg: "the CEO session never got ready" }
    )
    await node(ceo.id).$("button[aria-label='Focus terminal']").click()
    await browser.execute(
      (id) =>
        (window as unknown as Win).e2e.terminals[id].input(
          "Write one.txt; two.txt; three.txt\r",
          true
        ),
      ceo.id
    )
    await node(ceo.id).$("button[aria-label='Exit focus']").click()

    await browser.waitUntil(async () => (await leads().length) === 1, {
      timeout: 20000,
      timeoutMsg: "no Lead node appeared",
    })
    const leadId = (await leads()[0].getAttribute("data-id")) as string
    const lead = (await sessions()).find(
      (s) => s.nodeId === leadId
    ) as AgentSession
    expect(lead.role).toBe("lead")
    expect(lead.parent).toBe(ceo.id)
    expect(lead.branch).toMatch(/^ceo\/lead-team-of-3-/)
    expect(has(lead.tmuxName)).toBe(true)

    // The CEO, the Lead and its three executors, with a report waiting at the Lead while it reviews.
    await browser.waitUntil(
      async () =>
        (await executors().length) === 3 &&
        (await $$("[data-slot=signal][data-kind=report]").length) > 0,
      { timeout: 60000, timeoutMsg: "never saw the whole team with a report" }
    )
    const team = (await sessions()).filter((s) => s.parent === leadId)
    expect(team.map((s) => s.role)).toEqual([
      "executor",
      "executor",
      "executor",
    ])
    const board = await invoke<{ nodes: BoardNode[] }>("board_load", {
      projectId,
    })
    for (const s of team) {
      const n = board.nodes.find((n) => n.id === s.nodeId) as BoardNode
      expect(n.type).toBe("executor")
      expect((n.data as { leadId?: string }).leadId).toBe(leadId)
    }
    await browser.saveScreenshot(`test-results-app/team-${await scheme()}.png`)

    // The Lead's report reaches the CEO, waits there a moment and is accepted.
    await browser.waitUntil(
      async () =>
        (await busLog()).some(
          (m) =>
            m.kind === "report" && m.from === leadId && m.state === "accepted"
        ),
      { timeout: 90000, timeoutMsg: "the Lead's report was never accepted" }
    )
    const log = await busLog()
    const report = log.find(
      (m) => m.kind === "report" && m.from === leadId
    ) as Message
    expect(report.to).toBe(ceo.id)
    expect(log.filter((m) => m.id === report.id).map((m) => m.state)).toEqual([
      "sent",
      "waiting",
      "accepted",
    ])
    expect(report.body).toMatch(/^Merged 3: /)
    expect(report.body).toContain("gate sh gate.sh: gate: 3 files ok")

    // Every executor reported to its Lead; the one that tried to write to the CEO was refused.
    const reports = log.filter(
      (m) => m.kind === "report" && m.state === "sent" && m.from !== leadId
    )
    expect(reports.map((m) => m.to)).toEqual([leadId, leadId, leadId])
    const probe = reports.find((m) => m.body?.includes("send to the CEO"))
    expect(probe?.body).toContain(
      `send to the CEO: ${ceo.id} is not linked to you on the bus`
    )
    expect(log.some((m) => m.kind === "send" && m.to === ceo.id)).toBe(false)

    // The Lead and its team leave the board and tmux; the Lead's branch keeps the three merges.
    await browser.waitUntil(
      async () =>
        (await leads().length) === 0 && (await executors().length) === 0,
      { timeout: 60000, timeoutMsg: "the team stayed on the board" }
    )
    await browser.waitUntil(
      () => [lead, ...team].every((s) => !has(s.tmuxName)),
      {
        timeoutMsg: "a team tmux session survived",
      }
    )
    expect(
      (await sessions()).filter((s) => s.projectId === projectId).length
    ).toBe(1)
    const merges = git(
      repo,
      "log",
      "--merges",
      "--format=%s",
      lead.branch as string
    ).split("\n")
    expect(merges.sort()).toEqual(team.map((s) => `Merge ${s.branch}`).sort())
    expect(
      git(repo, "ls-tree", "--name-only", lead.branch as string).split("\n")
    ).toEqual(["gate.sh", "one.txt", "three.txt", "two.txt"])
    // Merged into the Lead, so `branch -d` took the executors' branches; the Lead's own stays.
    expect(git(repo, "branch", "--list", "ceo/exec-*")).toBe("")
    expect(git(repo, "branch", "--list", lead.branch as string)).toContain(
      lead.branch
    )
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(2)
  })
})
