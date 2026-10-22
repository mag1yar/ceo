import type { Node, XYPosition } from "@xyflow/react"

export type DiagramNode = Node<{ source: string }, "diagram">

const WIDTH = 360
const HEIGHT = 200

export const EXAMPLE = `flowchart LR
  Idea --> Plan --> Ship`

export function newDiagram(center: XYPosition): DiagramNode {
  return {
    id: crypto.randomUUID(),
    type: "diagram",
    position: { x: center.x - WIDTH / 2, y: center.y - HEIGHT / 2 },
    width: WIDTH,
    height: HEIGHT,
    data: { source: EXAMPLE },
  }
}
