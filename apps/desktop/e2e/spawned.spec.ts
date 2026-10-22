import { expect, type Page, test } from "@playwright/test"
import { buildTeam } from "../src/features/agents/team"
import type { BoardEdge, BoardNode } from "../src/lib/store"

type Ipc = { invoke: (cmd: string, args?: object) => Promise<unknown> }
type Win = {
  __TAURI_INTERNALS__: Ipc
  specInvoke?: Ipc["invoke"]
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

// The spec's own calls skip the save recorder.
const ipc = (page: Page, cmd: string, args: object) =>
  page.evaluate(
    ({ cmd, args }) => {
      const w = window as unknown as Win
      return (w.specInvoke ?? w.__TAURI_INTERNALS__.invoke)(cmd, args)
    },
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

async function open(page: Page) {
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
  await expect(page.locator(".react-flow__node-ceo")).toHaveCount(1)
  return projectId
}

// On the first frame `selector` matches: the properties its running transitions animate.
const transitions = (page: Page, selector: string) =>
  page.evaluate(async (selector) => {
    for (;;) {
      const el = document.querySelector(selector)
      if (el)
        return el
          .getAnimations()
          .map((a) => (a as CSSTransition).transitionProperty)
          .sort()
      await new Promise(requestAnimationFrame)
    }
  }, selector)

const root = ".react-flow__node-executor > *"
const path = ".react-flow__edge .react-flow__edge-path"

for (const reduced of [false, true])
  test(`a spawned executor and its link animate in and out${reduced ? ", opacity only under reduced motion" : ""}`, async ({
    page,
  }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" })
    const projectId = await open(page)
    // Every board_save the app sends, to prove the motion flags never reach the store.
    await page.evaluate(() => {
      const ipc = (window as unknown as Win).__TAURI_INTERNALS__
      const invoke = ipc.invoke
      const saves: unknown[] = []
      Object.assign(window, { saves, specInvoke: invoke })
      ipc.invoke = (cmd, args) => {
        if (cmd === "board_save") saves.push(args)
        return invoke(cmd, args)
      }
    })
    const motion = reduced ? ["opacity"] : ["opacity", "transform"]

    const entering = transitions(page, root)
    const edgeIn = transitions(page, path)
    await rust(page, projectId, { upsertNodes: [exec], upsertEdges: [link] })
    expect(await entering).toEqual(motion)
    expect(await edgeIn).toEqual(["opacity"])

    // Rust retires it: still on the board, marked and inert, until the fade ends.
    const leaving = transitions(page, `.react-flow__node-executor.leaving > *`)
    const edgeOut = transitions(
      page,
      `.react-flow__edge.leaving .react-flow__edge-path`
    )
    await rust(page, projectId, { deleteNodeIds: [exec.id] })
    expect(await leaving).toEqual(motion)
    expect(await edgeOut).toEqual(["opacity"])
    // A second delete while it leaves changes nothing.
    await rust(page, projectId, { deleteNodeIds: [exec.id] })
    await expect(page.locator(".react-flow__node-executor")).toHaveCount(0)
    await expect(page.locator(".react-flow__edge")).toHaveCount(0)

    // Past the board's save debounce, so any flush the removal caused is recorded.
    await page.waitForTimeout(1000)
    const saves = JSON.stringify(
      await page.evaluate(
        () => (window as unknown as { saves: unknown[] }).saves
      )
    )
    expect(saves).not.toMatch(/spawned|leaving|className/)
    expect(saves).not.toContain(exec.id)
    expect((await board(page, projectId)).nodes.map((n) => n.id)).toEqual([
      ceo.id,
    ])
  })

test("a spawned executor joins the open board, survives undo and leaves only when Rust removes it", async ({
  page,
}) => {
  const projectId = await open(page)
  const executors = page.locator(".react-flow__node-executor")
  const notes = page.locator(".react-flow__node-note")

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
