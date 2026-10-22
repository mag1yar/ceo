/// <reference types="@wdio/mocha-framework" />
import { execFileSync, execSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { $, $$, browser, expect } from "@wdio/globals"
import { buildTeam } from "../../src/features/agents/team"
import type { AgentSession, BoardNode } from "../../src/lib/store"
import { restartApp } from "./lib/app"
import { invoke } from "./lib/projects"

type Term = {
  input: (data: string, user: boolean) => void
  buffer: {
    active: {
      length: number
      getLine: (i: number) => { translateToString: (t: boolean) => string }
    }
  }
}
type Hook = { e2e: { terminals: Record<string, Term> } }

const team = buildTeam()
const ceo = team.nodes.find((n) => n.type === "ceo") as BoardNode
const lead = team.nodes.find((n) => n.type === "lead") as BoardNode
const agents =
  ".react-flow__node-ceo, .react-flow__node-lead, .react-flow__node-member"

// This run's own socket from wdio.conf, never the default one or the app's `ceo`.
const tmux = (...args: string[]) =>
  execFileSync(
    process.env.CEO_TMUX_BIN ?? "tmux",
    ["-L", process.env.CEO_E2E_TMUX ?? "", ...args],
    { stdio: ["ignore", "pipe", "ignore"] }
  )
    .toString()
    .trim()
const hasSession = (name: string) => {
  try {
    tmux("has-session", "-t", `=${name}`)
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

const screen = (id: string) =>
  browser.execute((id) => {
    const t = (window as unknown as Hook).e2e.terminals[id]
    if (!t) return ""
    const lines: string[] = []
    for (let i = 0; i < t.buffer.active.length; i++)
      lines.push(t.buffer.active.getLine(i).translateToString(true))
    return lines.join("\n")
  }, id)

const type = (id: string, data: string) =>
  browser.execute(
    (id, data) =>
      (window as unknown as Hook).e2e.terminals[id].input(data, true),
    id,
    data
  )

async function waitFor(id: string, text: string | RegExp, timeout = 20000) {
  const has = (s: string) =>
    typeof text === "string" ? s.includes(text) : text.test(s)
  await browser
    .waitUntil(async () => has(await screen(id)), { timeout })
    .catch(async () => {
      throw new Error(
        `terminal ${id} never showed ${text}:\n${await screen(id)}`
      )
    })
}

const node = (id: string) => $(`.react-flow__node[data-id="${id}"]`)
const header = (id: string) => node(id).$("header").getText()

async function waitStatus(text: string) {
  await browser.waitUntil(async () => (await header(ceo.id)).includes(text), {
    timeout: 10000,
    timeoutMsg: `CEO status never showed ${text}`,
  })
}

const sessionOf = async (projectId: string) =>
  (await invoke<AgentSession[]>("session_list")).find(
    (s) => s.projectId === projectId && s.nodeId === ceo.id
  )

async function scheme() {
  return (await browser.execute(
    () => matchMedia("(prefers-color-scheme: dark)").matches
  ))
    ? "dark"
    : "light"
}

async function openProject(dir: string, count: number) {
  await browser.execute(() => location.reload())
  await $(`ul[aria-label=Projects] button[title="${dir}"]`).click()
  await browser.waitUntil(async () => (await $$(agents).length) === count, {
    timeout: 20000,
    timeoutMsg: "board did not render the agents",
  })
}

describe("CEO session in the hidden app", function () {
  this.timeout(180000)
  // realpath: git and tmux report /private/tmp for /tmp.
  const repo = realpathSync(mkdtempSync("/tmp/ceo-e2e-sessions-"))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "commit", "-q", "--allow-empty", "-m", "init")
  let projectId = ""
  let first: AgentSession | undefined

  before(async () => {
    mkdirSync("test-results-app", { recursive: true })
    projectId = (
      await invoke<{ id: string }>("project_create", {
        name: "sessions",
        path: repo,
      })
    ).id
    await invoke("board_save", {
      projectId,
      changes: {
        upsertNodes: [ceo, { ...lead, x: ceo.x + 700, y: ceo.y }],
        viewport: { x: 460, y: 120, zoom: 0.7 },
      },
    })
    await openProject(repo, 2)
  })

  after(async () => {
    await invoke("project_delete", { id: projectId })
    rmSync(repo, { recursive: true, force: true })
  })

  it("starts the CEO's claude in tmux in its own worktree; other agents keep a shell", async () => {
    await waitFor(ceo.id, "Stub Claude · new")
    first = await sessionOf(projectId)
    expect(first).toBeDefined()
    const s = first as AgentSession
    expect(hasSession(s.tmuxName)).toBe(true)
    expect(s.worktree).not.toBeNull()
    expect(existsSync(`${s.worktree}/.git`)).toBe(true)
    expect(s.worktree?.startsWith(repo)).toBe(false)
    expect(git(repo, "branch", "--list", s.branch ?? "")).toContain(s.branch)
    // claude runs inside the worktree, on the branch made for it.
    expect(
      tmux(
        "display-message",
        "-p",
        "-t",
        `=${s.tmuxName}:`,
        "#{pane_current_path}"
      )
    ).toBe(realpathSync(s.worktree as string))
    expect(git(s.worktree as string, "branch", "--show-current")).toBe(s.branch)
    await waitFor(ceo.id, "deny: Agent, Workflow")
    await waitStatus("Ready")
    // The Lead's terminal is a login shell, not a session.
    await browser.waitUntil(async () => (await screen(lead.id)).trim() !== "")
    expect(await screen(lead.id)).not.toContain("Stub Claude")
    await browser.saveScreenshot(
      `test-results-app/session-stub-${await scheme()}.png`
    )
  })

  it("moves the node status with the hooks claude posts", async () => {
    await node(ceo.id).$("button[aria-label='Focus terminal']").click()
    await type(ceo.id, "work\r")
    await waitStatus("Running Bash")
    expect(await header(ceo.id)).toContain("Working")
    await type(ceo.id, "ask\r")
    await waitStatus("Needs permission for Edit")
    expect(await header(ceo.id)).toContain("Waiting")
    await type(ceo.id, "stop\r")
    await waitStatus("Turn finished")
    expect(await header(ceo.id)).toContain("Idle")
    await type(ceo.id, "fail\r")
    await waitStatus("API Error: Rate limit reached")
    expect(await header(ceo.id)).toContain("Error")
    await type(ceo.id, "stop\r")
    await waitStatus("Turn finished")
    await browser.saveScreenshot(
      `test-results-app/session-stub-focus-${await scheme()}.png`
    )
    await node(ceo.id).$("button[aria-label='Exit focus']").click()
  })

  it("re-attaches the same tmux session after the app restarts", async () => {
    const s = first as AgentSession
    const pane = tmux(
      "display-message",
      "-p",
      "-t",
      `=${s.tmuxName}:`,
      "#{pane_pid}"
    )
    const sessions = tmux("list-sessions", "-F", "#{session_name}")
    await restartApp()
    await openProject(repo, 2)
    // The screen from before the restart: the words typed into it.
    await waitFor(ceo.id, "❯ fail")
    expect((await sessionOf(projectId))?.tmuxName).toBe(s.tmuxName)
    // The same claude process, not a restart.
    expect(
      tmux("display-message", "-p", "-t", `=${s.tmuxName}:`, "#{pane_pid}")
    ).toBe(pane)
    expect(tmux("list-sessions", "-F", "#{session_name}")).toBe(sessions)
    await waitStatus("Turn finished")
  })

  it("resumes the claude session when its tmux session died while the app was down", async () => {
    const s = first as AgentSession
    tmux("kill-session", "-t", `=${s.tmuxName}`)
    await restartApp()
    await browser.waitUntil(() => hasSession(s.tmuxName), {
      timeout: 20000,
      timeoutMsg: "startup did not restart the dead session",
    })
    await openProject(repo, 2)
    await waitFor(ceo.id, `Stub Claude · resumed · ${s.claudeSessionId}`)
  })

  it("deleting the CEO node removes its tmux session, worktree and branch", async () => {
    const s = first as AgentSession
    await node(ceo.id).$("header").click()
    // React Flow reads the key as held state, so the release must come in a later task.
    const key = (type: string) =>
      browser.execute((type) => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Backspace",
            code: "Backspace",
            bubbles: true,
          })
        )
      }, type)
    await key("keydown")
    await key("keyup")
    await browser.waitUntil(() => !hasSession(s.tmuxName), {
      timeout: 15000,
      timeoutMsg: "the tmux session survived its node",
    })
    await browser.waitUntil(() => !existsSync(s.worktree as string), {
      timeoutMsg: "the worktree survived its node",
    })
    expect(git(repo, "branch", "--list", s.branch ?? "")).toBe("")
    expect(git(repo, "worktree", "list")).not.toContain(s.worktree)
    expect(await sessionOf(projectId)).toBeUndefined()
  })

  it("shows the real claude start screen without sending it anything", async () => {
    const real = execSync("command -v claude").toString().trim()
    const dir = realpathSync(mkdtempSync("/tmp/ceo-e2e-real-claude-"))
    const stub = process.env.CEO_CLAUDE_BIN
    process.env.CEO_CLAUDE_BIN = real
    try {
      await restartApp()
      const p = await invoke<{ id: string }>("project_create", {
        name: "real claude",
        path: dir,
      })
      await invoke("board_save", {
        projectId: p.id,
        changes: { upsertNodes: [ceo], viewport: { x: 460, y: 300, zoom: 1 } },
      })
      await openProject(dir, 1)
      await waitStatus("Starting")
      // The throwaway HOME has no Claude Code state: onboarding comes first.
      await waitFor(ceo.id, /Claude Code|get started|theme/i, 30000)
      await browser.pause(1500)
      await browser.saveScreenshot(
        `test-results-app/session-real-claude-${await scheme()}.png`
      )
      await invoke("project_delete", { id: p.id })
    } finally {
      process.env.CEO_CLAUDE_BIN = stub
      rmSync(dir, { recursive: true, force: true })
      // Later specs must get the stub again.
      await restartApp()
    }
  })
})
