import { Position } from "@xyflow/react"
import { describe, expect, it } from "vitest"
import { outlinePoint, toBoardEdge, toEdge } from "./link"

const box = { x: 0, y: 0, width: 200, height: 100 }

describe("outlinePoint", () => {
  it("leaves through the side facing the other point", () => {
    expect(outlinePoint(box, { x: 500, y: 50 })).toEqual({
      x: 200,
      y: 50,
      position: Position.Right,
    })
    expect(outlinePoint(box, { x: -500, y: 50 })).toMatchObject({
      x: 0,
      position: Position.Left,
    })
    expect(outlinePoint(box, { x: 100, y: -300 })).toMatchObject({
      y: 0,
      position: Position.Top,
    })
    expect(outlinePoint(box, { x: 100, y: 300 })).toMatchObject({
      y: 100,
      position: Position.Bottom,
    })
  })

  it("lands on the outline on a diagonal and stays finite at the centre", () => {
    const p = outlinePoint(box, { x: 400, y: 125 })
    expect(p).toMatchObject({ x: 200, y: 75, position: Position.Right })
    expect(outlinePoint(box, { x: 100, y: 50 })).toMatchObject({
      x: 100,
      y: 50,
    })
  })
})

describe("toEdge", () => {
  it("keeps old handle ids in stored data but not on the rendered edge", () => {
    const stored = {
      id: "e",
      source: "a",
      target: "b",
      data: { kind: "link", sourceHandle: "out", targetHandle: "in" },
    }
    const edge = toEdge(stored)
    expect(edge.sourceHandle).toBeUndefined()
    expect(edge.targetHandle).toBeUndefined()
    expect(toBoardEdge(edge)).toEqual(stored)
  })
})
