import type { Node } from "@xyflow/react"
import { describe, expect, it } from "vitest"
import { canConnect } from "./canConnect"

const node = (id: string, type: string, leadId?: string): Node => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { name: id, leadId },
})

const ceo = node("ceo", "ceo")
const leadA = node("a", "lead")
const leadB = node("b", "lead")
const a1 = node("a1", "member", "a")
const a2 = node("a2", "member", "a")
const b1 = node("b1", "member", "b")
const note = node("note", "note")

describe("canConnect", () => {
  it.each([
    ["CEO to Lead", ceo, leadA, true],
    ["Lead to CEO", leadA, ceo, true],
    ["Lead to Lead", leadA, leadB, true],
    ["Lead to own Member", leadA, a1, true],
    ["Member to own Lead", a1, leadA, true],
    ["Member to teammate", a1, a2, true],
    ["Member to CEO", a1, ceo, false],
    ["CEO to Member", ceo, a1, false],
    ["Member to another Lead", a1, leadB, false],
    ["Lead to another team's Member", leadB, a1, false],
    ["Member to another team's Member", a1, b1, false],
    ["CEO to CEO", ceo, node("ceo2", "ceo"), false],
    ["a node to itself", leadA, leadA, false],
    ["Member to a note", a1, note, true],
    ["note to CEO", note, ceo, true],
    ["missing node", a1, undefined, false],
    [
      "two Members without a Lead",
      node("x", "member"),
      node("y", "member"),
      false,
    ],
  ])("%s", (_, source, target, allowed) => {
    expect(canConnect(source, target)).toBe(allowed)
  })
})
