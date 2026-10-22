import {
  BaseEdge,
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react"
import { memo, useState } from "react"
import { floatingEnds, type LinkEdge } from "./link"

// Subscribes to its two nodes only, so a move re-renders just the edges touching it.
function useFloatingEnds(source: string, target: string) {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  return s && t ? floatingEnds(s, t) : null
}

export const LinkEdgeView = memo(function LinkEdgeView({
  id,
  source,
  target,
  data,
  selected,
}: EdgeProps<LinkEdge>) {
  const { updateEdgeData } = useReactFlow()
  const flow = useStoreApi()
  const [editing, setEditing] = useState(false)
  const ends = useFloatingEnds(source, target)
  if (!ends) return null
  const [path, x, y] = getBezierPath(ends)
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

// Agent hierarchy: a plain floating line, no arrow or label.
export const PlainEdgeView = memo(function PlainEdgeView({
  source,
  target,
}: EdgeProps) {
  const ends = useFloatingEnds(source, target)
  return ends && <BaseEdge path={getStraightPath(ends)[0]} />
})

// Over a valid target the line already takes the floating route the edge will have.
export function LinkConnectionLine({
  fromNode,
  toNode,
  connectionStatus,
  fromX,
  fromY,
  fromPosition,
  toX,
  toY,
  toPosition,
}: ConnectionLineComponentProps) {
  const ends = (toNode &&
    connectionStatus === "valid" &&
    floatingEnds(fromNode, toNode)) || {
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: fromPosition,
    targetX: toX,
    targetY: toY,
    targetPosition: toPosition,
  }
  return (
    <path
      d={getBezierPath(ends)[0]}
      fill="none"
      className="react-flow__connection-path"
    />
  )
}

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
