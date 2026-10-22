import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react"
import { memo, useState } from "react"
import type { LinkEdge } from "./link"

export const LinkEdgeView = memo(function LinkEdgeView({
  id,
  data,
  selected,
  ...geometry
}: EdgeProps<LinkEdge>) {
  const { updateEdgeData } = useReactFlow()
  const flow = useStoreApi()
  const [editing, setEditing] = useState(false)
  const [path, x, y] = getBezierPath(geometry)
  const label = data?.label
  const finish = (value: string) => {
    setEditing(false)
    const next = value.trim() || undefined
    if (next !== label) updateEdgeData(id, { label: next })
  }
  return (
    <>
      {/* Own arrowhead per edge, so it takes the selected colour with the line. */}
      <defs>
        <marker
          id={`link-arrow-${id}`}
          viewBox="-10 -10 20 20"
          markerWidth="16"
          markerHeight="16"
          orient="auto-start-reverse"
        >
          <polyline
            points="-5,-4 0,0 -5,4 -5,-4"
            strokeLinejoin="round"
            className={
              selected
                ? "fill-(--xy-edge-stroke-selected) stroke-(--xy-edge-stroke-selected)"
                : "fill-(--xy-edge-stroke) stroke-(--xy-edge-stroke)"
            }
          />
        </marker>
      </defs>
      <BaseEdge
        path={path}
        markerEnd={`url(#link-arrow-${id})`}
        interactionWidth={0}
      />
      {/* Wide invisible hit area, so the thin line is easy to select and double-click. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: canvas gesture; the label input is the accessible editor. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        className="react-flow__edge-interaction"
        onDoubleClick={() => setEditing(true)}
      />
      {(editing || label) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
            }}
          >
            {editing ? (
              <LabelEditor text={label ?? ""} onDone={finish} />
            ) : (
              <button
                type="button"
                data-slot="edge-label"
                onClick={() => flow.getState().addSelectedEdges([id])}
                onDoubleClick={() => setEditing(true)}
                className="block rounded-md border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-xs"
              >
                {label}
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const focusAll = (el: HTMLInputElement | null) => {
  el?.focus()
  el?.select()
}

function LabelEditor({
  text,
  onDone,
}: {
  text: string
  onDone: (text: string) => void
}) {
  return (
    <input
      ref={focusAll}
      aria-label="Edge label"
      defaultValue={text}
      placeholder="Label"
      onBlur={(e) => onDone(e.currentTarget.value)}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()
      }
      className="field-sizing-content min-w-16 rounded-md border border-primary bg-background px-1.5 py-0.5 text-xs outline-none select-text"
    />
  )
}
