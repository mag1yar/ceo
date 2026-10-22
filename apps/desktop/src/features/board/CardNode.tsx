import { cn } from "@workspace/ui/lib/utils"
import type { Node, NodeProps } from "@xyflow/react"
import { memo } from "react"

export type CardNode = Node<{ title?: string }, "card">

// Temporary node to exercise the board until real node types land (#6, #7).
export const CardNodeView = memo(function CardNodeView({
  data,
  selected,
}: NodeProps<CardNode>) {
  return (
    <div
      className={cn(
        "w-44 rounded-lg border bg-card px-3 py-2 text-sm text-card-foreground shadow-xs",
        selected && "border-primary ring-1 ring-primary"
      )}
    >
      {data.title ?? "Card"}
    </div>
  )
})
