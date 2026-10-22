import { expect, type Page, test } from "@playwright/test"
import { buildTeam } from "../src/features/agents/team"
import type { BoardEdge, BoardNode } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = {
  __TAURI_INTERNALS__: Ipc
  __ceoBus: { board: (c: object) => Promise<void> }
}

const ceo = {
  ...(buildTeam().nodes.find((n) => n.type === "ceo") as BoardNode),
  x: 0,
  y: 0,
}
const exec: BoardNode = {
  id: "exec-1",
  type: "executor",
  x: 1000,
  y: 0,
  width: null,
  height: null,
  data: { name: "Add a hello file", model: "haiku", branch: "ceo/exec-x" },
  z: 0,
}
const link: BoardEdge = {
  id: "spawn-1",
  source: ceo.id,
  target: exec.id,
  data: { kind: "spawn" },
}

const ipc = (page: Page, cmd: string, args: object) =>
  page.evaluate(
    ({ cmd, args }) =>
      (window as unknown as Win).__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args }
  )

// What the Rust bus does: write the store, then tell the open board.
async function rust(page: Page, projectId: string, changes: object) {
  await ipc(page, "board_save", { projectId, changes })
  await page.evaluate((c) => (window as unknown as Win).__ceoBus.board(c), {
    projectId,
    ...changes,
  })
}

const board = (page: Page, projectId: string) =>
  ipc(page, "board_load", { projectId }) as Promise<{
    nodes: BoardNode[]
    edges: BoardEdge[]
  }>

test("a spawned executor joins the open board, survives undo and leaves only when Rust removes it", async ({
  page,
}) => {
  await page.goto("/")
  await expect(page.locator("[data-slot=app-shell]")).toBeVisible()
  const projectId = await page.evaluate(async (ceo) => {
    const ipc = (window as unknown as Win).__TAURI_INTERNALS__
    const p = (await ipc.invoke("project_create", {
      name: "spawned",
      path: "/tmp/spawned",
    })) as { id: string }
    await ipc.invoke("board_save", {
      projectId: p.id,
      changes: { upsertNodes: [ceo], viewport: { x: 40, y: 200, zoom: 0.4 } },
    })
    return p.id
  }, ceo)
  await page.reload()
  const executors = page.locator(".react-flow__node-executor")
  const notes = page.locator(".react-flow__node-note")
  await expect(page.locator(".react-flow__node-ceo")).toHaveCount(1)

  // An undo step taken before the spawn.
  await page
    .locator(".react-flow__pane")
    .dblclick({ position: { x: 300, y: 500 } })
  await expect(notes).toHaveCount(1)
  await page.keyboard.press("Escape")

  await rust(page, projectId, { upsertNodes: [exec], upsertEdges: [link] })
  await expect(executors).toHaveCount(1)
  await expect(executors).toContainText("Add a hello file")
  await expect(page.locator(".react-flow__edge")).toHaveCount(1)

  // Undo takes the note away, not the executor Rust added after it.
  await page.keyboard.press("Meta+KeyZ")
  await expect(notes).toHaveCount(0)
  await expect(executors).toHaveCount(1)
  await expect(page.locator(".react-flow__edge")).toHaveCount(1)
  await expect
    .poll(async () =>
      (await board(page, projectId)).nodes.map((n) => n.id).sort()
    )
    .toEqual([ceo.id, exec.id].sort())
  expect((await board(page, projectId)).edges.map((e) => e.id)).toEqual([
    link.id,
  ])

  // Rust retires it; redo of a snapshot that still had it does not bring it back.
  await rust(page, projectId, { deleteNodeIds: [exec.id] })
  await expect(executors).toHaveCount(0)
  await expect(page.locator(".react-flow__edge")).toHaveCount(0)
  await page.keyboard.press("Meta+Shift+KeyZ")
  await expect(notes).toHaveCount(1)
  await expect(executors).toHaveCount(0)
  await expect
    .poll(async () =>
      (await board(page, projectId)).nodes.map((n) => n.type).sort()
    )
    .toEqual(["ceo", "note"])
  expect((await board(page, projectId)).edges).toEqual([])
})
