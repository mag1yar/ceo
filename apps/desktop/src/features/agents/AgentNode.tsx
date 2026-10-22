import {
  CheckCircleIcon,
  CrownSimpleIcon,
  QuestionIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
import { Handle, type NodeProps, Position } from "@xyflow/react"
import { createContext, memo, type ReactNode, use } from "react"
import { type AgentNode, MODEL_LABEL } from "./agent"
import { type Live, STATUS_LABEL, type Status, useLive } from "./status"

type Ctx = { data: AgentNode["data"]; live: Live }
const Agent = createContext<Ctx | null>(null)
const useAgent = () => use(Agent) as Ctx

const HANDLE =
  "size-2! min-h-0! min-w-0! rounded-full border border-card bg-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/agent:opacity-100 [&.connectingto]:opacity-100 [&.connectingto:not(.valid)]:bg-destructive [&.valid]:bg-primary"

// Shared frame: surface, status tint, selection and handles. Variants set shape and weight.
function AgentFrame({
  id,
  data,
  selected,
  className,
  children,
}: Pick<NodeProps<AgentNode>, "id" | "data" | "selected"> & {
  className: string
  children: ReactNode
}) {
  const live = useLive(id)
  return (
    <Agent value={{ data, live }}>
      <div
        data-status={live.status}
        className={cn(
          "group/agent relative bg-card text-card-foreground transition-[border-color] duration-200 ease-out",
          "data-[status=error]:border-agent-error/60 data-[status=waiting]:border-agent-waiting",
          selected && "ring-2 ring-primary",
          className
        )}
      >
        {live.status === "waiting" && (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-0.5 animate-agent-attention opacity-0 rounded-[inherit] border-2 border-agent-waiting motion-reduce:hidden"
          />
        )}
        <Handle type="target" position={Position.Top} className={HANDLE} />
        {children}
        <Handle type="source" position={Position.Bottom} className={HANDLE} />
      </div>
    </Agent>
  )
}

function AgentName({ className }: { className: string }) {
  return <div className={cn("truncate", className)}>{useAgent().data.name}</div>
}

function AgentModel({ prefix }: { prefix?: string }) {
  const model = MODEL_LABEL[useAgent().data.model]
  return (
    <div className="truncate text-xs text-muted-foreground">
      {prefix ? `${prefix} · ${model}` : model}
    </div>
  )
}

function AgentStatus({ className }: { className?: string }) {
  const { status, action } = useAgent().live
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}>
      <StatusIcon status={status} />
      <span className="shrink-0 font-medium">{STATUS_LABEL[status]}</span>
      <span className="truncate text-muted-foreground" title={action}>
        {action}
      </span>
    </div>
  )
}

// Shape carries meaning without colour: hollow idle, turning ring, filled glyphs for the rest.
export function StatusIcon({ status }: { status: Status }) {
  const glyph = "size-3.5"
  return (
    <span aria-hidden className="grid size-3.5 shrink-0 place-items-center">
      {status === "idle" && (
        <span className="size-2 rounded-full border-[1.5px] border-agent-idle" />
      )}
      {status === "working" && (
        <span className="size-2.5 animate-agent-spin rounded-full border-2 border-agent-working border-t-transparent motion-reduce:animate-none motion-reduce:border-t-agent-working" />
      )}
      {status === "waiting" && (
        <QuestionIcon
          weight="fill"
          className={cn(glyph, "text-agent-waiting")}
        />
      )}
      {status === "error" && (
        <WarningCircleIcon
          weight="fill"
          className={cn(glyph, "text-agent-error")}
        />
      )}
      {status === "done" && (
        <CheckCircleIcon
          weight="fill"
          className={cn(glyph, "text-agent-done")}
        />
      )}
    </span>
  )
}

export const CeoNode = memo(function CeoNode(props: NodeProps<AgentNode>) {
  return (
    <AgentFrame
      {...props}
      className="w-64 rounded-2xl border-2 p-3.5 shadow-lg"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background">
          <CrownSimpleIcon weight="fill" className="size-4.5" />
        </span>
        <div className="min-w-0">
          <AgentName className="text-lg font-semibold" />
          <AgentModel />
        </div>
      </div>
      <AgentStatus className="mt-3" />
    </AgentFrame>
  )
})

export const LeadNode = memo(function LeadNode(props: NodeProps<AgentNode>) {
  return (
    <AgentFrame {...props} className="w-56 rounded-xl border p-3 shadow-md">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <UsersThreeIcon weight="bold" className="size-4" />
        </span>
        <div className="min-w-0">
          <AgentName className="font-semibold" />
          <AgentModel prefix="Lead" />
        </div>
      </div>
      <AgentStatus className="mt-2.5" />
    </AgentFrame>
  )
})

export const MemberNode = memo(function MemberNode(
  props: NodeProps<AgentNode>
) {
  return (
    <AgentFrame
      {...props}
      className="w-52 rounded-lg border px-2.5 py-2 shadow-xs"
    >
      <div className="flex items-baseline justify-between gap-2">
        <AgentName className="font-medium" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {MODEL_LABEL[props.data.model]}
        </span>
      </div>
      <AgentStatus className="mt-1" />
    </AgentFrame>
  )
})
