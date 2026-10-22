import { getBezierPath, Position } from "@xyflow/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LEAVE_MS, type Message, messagesOf, receive } from "./messages"
import { track } from "./track"

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }))

const msg = (over: Partial<Message>): Message => ({
  id: "m1",
  projectId: "p",
  from: "a",
  to: "b",
  thread: "t1",
  kind: "send",
  state: "sent",
  sentAt: 1,
  ...over,
})

afterEach(() => vi.useRealTimers())

describe("receive", () => {
  it("never moves a message back a state and drops it after accept", () => {
    vi.useFakeTimers()
    const p = "p1"
    receive(msg({ projectId: p, state: "waiting" }))
    receive(msg({ projectId: p, state: "sent" }))
    expect(messagesOf(p).live.map((m) => m.state)).toEqual(["waiting"])
    receive(msg({ projectId: p, state: "accepted" }))
    expect(messagesOf(p).live.map((m) => m.state)).toEqual(["accepted"])
    vi.advanceTimersByTime(LEAVE_MS)
    expect(messagesOf(p).live).toEqual([])
    // A late duplicate does not bring it back.
    receive(msg({ projectId: p, state: "waiting" }))
    expect(messagesOf(p).live).toEqual([])
  })

  it("keeps every asker in a thread waiting until its reply is accepted", () => {
    vi.useFakeTimers()
    const p = "p2"
    receive(msg({ projectId: p, id: "q", kind: "ask", from: "lead" }))
    receive(msg({ projectId: p, id: "q2", kind: "ask", from: "member" }))
    receive(
      msg({
        projectId: p,
        id: "q",
        kind: "ask",
        from: "lead",
        state: "accepted",
      })
    )
    expect(messagesOf(p).asking).toEqual(["lead", "member"])
    receive(
      msg({ projectId: p, id: "r", kind: "reply", from: "ceo", to: "lead" })
    )
    receive(
      msg({
        projectId: p,
        id: "r",
        kind: "reply",
        from: "ceo",
        to: "lead",
        state: "waiting",
      })
    )
    expect(messagesOf(p).asking).toEqual(["lead", "member"])
    receive(
      msg({
        projectId: p,
        id: "r",
        kind: "reply",
        from: "ceo",
        to: "lead",
        state: "accepted",
      })
    )
    expect(messagesOf(p).asking).toEqual([])
  })

  it("drops a closed message and its ask at once", () => {
    const p = "p4"
    receive(msg({ projectId: p, kind: "ask", state: "waiting" }))
    receive(msg({ id: "m2", projectId: p }))
    expect(messagesOf(p).asking).toEqual(["a"])
    receive(msg({ projectId: p, kind: "ask", state: "waiting", closedAt: 2 }))
    expect(messagesOf(p).live.map((m) => m.id)).toEqual(["m2"])
    expect(messagesOf(p).asking).toEqual([])
    receive(msg({ projectId: p, kind: "ask", state: "waiting" }))
    expect(messagesOf(p).live.map((m) => m.id)).toEqual(["m2"])
  })

  it("ignores malformed payloads", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    receive({ ...msg({ projectId: "p3" }), kind: "shout" as "send" })
    receive({ id: "x", projectId: "p3" })
    receive({ ...msg({ projectId: "p3" }), state: "toString" as "sent" })
    expect(messagesOf("p3").live).toEqual([])
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe("track", () => {
  const ends = {
    sourceX: 0,
    sourceY: 0,
    sourcePosition: Position.Right,
    targetX: 400,
    targetY: 200,
    targetPosition: Position.Left,
  }

  it("spaces a straight path evenly and stops short of the end by the gap", () => {
    const t = track("M 0,0L 100,0", 10, 9)
    expect(t.end).toEqual([100, 0])
    expect(t.length).toBe(90)
    t.points.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(i * 10)
      expect(y).toBe(0)
    })
  })

  it("follows the bezier edge from source to just before the target", () => {
    const t = track(getBezierPath(ends)[0], 14)
    expect(t.points[0]).toEqual([0, 0])
    expect(t.end[0]).toBeCloseTo(400)
    expect(t.end[1]).toBeCloseTo(200)
    const [sx, sy] = t.stop
    expect(Math.hypot(400 - sx, 200 - sy)).toBeGreaterThan(12)
    expect(Math.hypot(400 - sx, 200 - sy)).toBeLessThan(15)
  })
})
