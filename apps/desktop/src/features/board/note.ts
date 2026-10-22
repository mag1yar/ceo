import type { Node, XYPosition } from "@xyflow/react"

export const NOTE_COLORS = [
  "default",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const
export type NoteColor = (typeof NOTE_COLORS)[number]
export type NoteNode = Node<{ text: string; color: NoteColor }, "note">

// Static class names so Tailwind sees them; tokens live in globals.css (#6).
export const NOTE_BG: Record<NoteColor, string> = {
  default: "bg-card",
  yellow: "bg-(--note-yellow)",
  green: "bg-(--note-green)",
  blue: "bg-(--note-blue)",
  purple: "bg-(--note-purple)",
  pink: "bg-(--note-pink)",
}

const WIDTH = 220
const HEIGHT = 140

// Ids of notes created in this session, so they mount in edit mode once; loaded notes never do.
export const freshNotes = new Set<string>()

export function newNote(center: XYPosition): NoteNode {
  const id = crypto.randomUUID()
  freshNotes.add(id)
  return {
    id,
    type: "note",
    position: { x: center.x - WIDTH / 2, y: center.y - HEIGHT / 2 },
    width: WIDTH,
    height: HEIGHT,
    data: { text: "", color: "default" },
  }
}
