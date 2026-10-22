import { HourglassMediumIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
import {
  getBezierPath,
  getStraightPath,
  type ReactFlowState,
  useInternalNode,
  useStore,
  ViewportPortal,
} from "@xyflow/react"
import {
  type CSSProperties,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { floatingEnds } from "@/features/board/link"
import { type Message, useMessages } from "./messages"
import { track } from "./track"

// A waiting signal stops this many screen pixels short of the receiver's outline, clear of the arrowhead.
const GAP = 14
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)" // --ease-in-out
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)" // --ease-out
const ABSORB_MS = 200
// A short hop stays readable, a long edge stays brief.
const travelMs = (length: number) => Math.min(1200, Math.max(450, length * 1.2))
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches

type Route = "link" | "plain" | "temp"

const pair = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`)
const selectEdges = (s: ReactFlowState) => s.edges
const selectZoom = (s: ReactFlowState) => s.transform[2]

// Mounted inside <ReactFlow>: only this layer subscribes to messages, so a new one never re-renders the board or its edges.
export function SignalLayer({ projectId }: { projectId: string }) {
  const { live, asking } = useMessages(projectId)
  const edges = useStore(selectEdges)
  // Markers keep one screen size at any zoom, so they stay readable over a zoomed-out team.
  const zoom = useStore(selectZoom)
  const routes = useMemo(
    () =>
      new Map<string, Route>(
        edges.map((e) => [
          pair(e.source, e.target),
          e.type === "link" ? "link" : "plain",
        ])
      ),
    [edges]
  )
  if (!live.length && !asking.length) return null

  // The oldest waiting message at a receiver heads its stack; the rest fold into its count.
  const stacks = new Map<string, Message[]>()
  for (const m of live)
    if (m.state === "waiting")
      stacks.get(m.to)?.push(m) ?? stacks.set(m.to, [m])
  for (const s of stacks.values())
    s.sort((a, b) => (a.waitingAt ?? a.sentAt) - (b.waitingAt ?? b.sentAt))
  const temps = new Map<string, Message>()
  for (const m of live)
    if (m.state !== "accepted" && !routes.has(pair(m.from, m.to)))
      temps.set(pair(m.from, m.to), m)

  return (
    <ViewportPortal>
      <div
        data-slot="signals"
        className="pointer-events-none"
        style={{ "--signal-scale": 1 / zoom } as CSSProperties}
      >
        {[...temps].map(([key, m]) => (
          <TempPath key={key} from={m.from} to={m.to} />
        ))}
        {live.map((m) => {
          const stack = m.state === "waiting" ? stacks.get(m.to) : undefined
          return (
            <Signal
              key={m.id}
              message={m}
              route={routes.get(pair(m.from, m.to)) ?? "temp"}
              gap={GAP / zoom}
              count={stack ? (stack[0] === m ? stack.length : 0) : 1}
              ask={
                stack ? stack.some((s) => s.kind === "ask") : m.kind === "ask"
              }
            />
          )
        })}
        {asking.map((id) => (
          <AskWaiting key={id} nodeId={id} />
        ))}
      </div>
    </ViewportPortal>
  )
}

// Same geometry as the edge between the two nodes, in either direction; a straight line when there is none.
function usePath(from: string, to: string, route: Route) {
  const s = useInternalNode(from)
  const t = useInternalNode(to)
  const ends = s && t && floatingEnds(s, t)
  if (!ends) return null
  return (route === "link" ? getBezierPath : getStraightPath)(ends)[0]
}

// Count 0 means folded into another signal's stack.
const Signal = memo(function Signal({
  message: m,
  route,
  gap,
  count,
  ask,
}: {
  message: Message
  route: Route
  gap: number
  count: number
  ask: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const first = useRef(m.state).current
  const d = usePath(m.from, m.to, route)
  const path = useMemo(() => (d ? track(d, gap) : null), [d, gap])
  const travel = useRef<Animation>(null)
  const [arrived, setArrived] = useState(() => first !== "sent" || reduced())
  const accepted = m.state === "accepted"
  const folded = count === 0 && arrived
  // An accepted message keeps the visibility it had while waiting.
  const wasFolded = useRef(false)
  useLayoutEffect(() => {
    if (!accepted) wasFolded.current = folded
  })
  const hidden = accepted ? wasFolded.current : folded
  const absorbed = useRef(false)

  // WAAPI on transform, so travel runs on the compositor with no React render per frame.
  useLayoutEffect(() => {
    const el = ref.current
    const prev = travel.current
    if (!el || !path || arrived || prev?.playState === "finished") return
    const duration = travelMs(path.length)
    const a = el.animate(
      path.points.map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)` })),
      { duration, easing: EASE_IN_OUT }
    )
    // A node moved or the zoom changed mid-flight: carry on along the new path from the same fraction of the trip.
    if (prev) {
      const done =
        Number(prev.currentTime) / Number(prev.effect?.getTiming().duration)
      a.currentTime = done * duration
      prev.cancel()
    }
    travel.current = a
    a.finished.then(
      () => setArrived(true),
      () => {}
    )
  }, [path, arrived])

  useLayoutEffect(() => {
    const el = ref.current
    if (
      !accepted ||
      absorbed.current ||
      first === "accepted" ||
      wasFolded.current ||
      !el ||
      !path
    )
      return
    absorbed.current = true
    travel.current?.finish()
    const [sx, sy] = path.stop
    const [ex, ey] = path.end
    el.animate(
      reduced()
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { transform: `translate(${sx}px, ${sy}px) scale(1)`, opacity: 1 },
            { transform: `translate(${ex}px, ${ey}px) scale(0.4)`, opacity: 0 },
          ],
      { duration: ABSORB_MS, easing: EASE_OUT, fill: "forwards" }
    )
  }, [accepted, first, path])

  if (!path || first === "accepted") return null
  const [x, y] = path.stop
  return (
    <div
      ref={ref}
      data-slot="signal"
      data-message={m.id}
      data-kind={m.kind}
      data-state={m.state}
      data-count={count}
      className="absolute top-0 left-0 transition-opacity duration-(--duration-fast)"
      style={{
        transform: `translate(${x}px, ${y}px)`,
        opacity: hidden ? 0 : undefined,
      }}
    >
      {count > 1 ? (
        <span
          className={cn(
            "absolute grid h-4 min-w-4 -translate-1/2 scale-(--signal-scale) place-items-center px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-background",
            ask
              ? "rounded-[3px] bg-signal-ask text-signal-ask-foreground"
              : "rounded-full bg-signal text-primary-foreground"
          )}
        >
          {count}
        </span>
      ) : (
        // Ask is a diamond, the rest are dots: shape tells them apart, not colour alone.
        <span
          className={cn(
            "absolute block -translate-1/2 scale-(--signal-scale) ring-2 ring-background",
            ask
              ? "size-2.5 rotate-45 rounded-[2px] bg-signal-ask"
              : "size-2 rounded-full bg-signal"
          )}
        />
      )}
    </div>
  )
})

// Dashed stand-in for the missing edge, drawn while a message between unlinked nodes is in flight or waiting.
function TempPath({ from, to }: { from: string; to: string }) {
  const d = usePath(from, to, "temp")
  return (
    d && (
      <svg
        aria-hidden
        width={1}
        height={1}
        className="absolute top-0 left-0 overflow-visible"
      >
        <path
          data-slot="signal-path"
          d={d}
          fill="none"
          strokeWidth={1.5}
          strokeDasharray="4 4"
          className="stroke-muted-foreground"
        />
      </svg>
    )
  )
}

// The sender of an ask is blocked until the reply in its thread is accepted.
function AskWaiting({ nodeId }: { nodeId: string }) {
  const n = useInternalNode(nodeId)
  if (!n?.measured.width) return null
  const { x, y } = n.internals.positionAbsolute
  return (
    <div
      data-slot="ask-waiting"
      data-node={nodeId}
      className="absolute top-0 left-0"
      style={{ transform: `translate(${x + n.measured.width}px, ${y}px)` }}
    >
      <span className="absolute right-0 bottom-0 flex origin-bottom-right scale-(--signal-scale) [transform:translateY(-6px)] items-center gap-1 rounded-[3px] bg-signal-ask px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-signal-ask-foreground shadow-sm">
        <HourglassMediumIcon weight="bold" className="size-3" />
        Waiting for reply
      </span>
    </div>
  )
}
