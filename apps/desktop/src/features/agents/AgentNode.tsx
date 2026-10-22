import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CheckCircleIcon,
  CrownSimpleIcon,
  QuestionIcon,
  UserIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { Handle, type NodeProps, Position } from "@xyflow/react"
import { createContext, memo, type ReactNode, use } from "react"
import { NodeTerminal } from "@/features/terminal/NodeTerminal"
import { AgentMenu } from "./AgentMenu"
import { toggleFocus, useFocus } from "./AgentTerminals"
import { type AgentNode, MODEL_LABEL, ROLE_LABEL, type Role } from "./agent"
import { type Live, STATUS_LABEL, type Status, useLive } from "./status"
import { NODE_SIZE } from "./team"

type Ctx = { data: AgentNode["data"]; live: Live }
const Agent = createContext<Ctx | null>(null)
const useAgent = () => use(Agent) as Ctx

const HANDLE =
  "size-2! min-h-0! min-w-0! rounded-full border border-card bg-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/agent:opacity-100 [&.connectingto]:opacity-100 [&.connectingto:not(.valid)]:bg-destructive [&.valid]:bg-primary"

// Shared frame: surface, status tint, selection and handles, sized for the terminal or for focus.
function AgentFrame({
  id,
  type,
  data,
  selected,
  focused,
  className,
  children,
}: Pick<NodeProps<AgentNode>, "id" | "type" | "data" | "selected"> & {
  focused: boolean
  className: string
  children: ReactNode
}) {
  const live = useLive(id)
  const focus = useFocus(id)
  return (
    <Agent value={{ data, live }}>
      <AgentMenu
        nodeId={id}
        focused={focused}
        data-status={live.status}
        style={focus?.size ?? NODE_SIZE[type]}
        className={cn(
          "group/agent relative flex flex-col bg-card text-card-foreground transition-[width,height,border-color] duration-(--duration-move) ease-(--ease-spring)",
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
        <Handle
          type="target"
          id="in"
          position={Position.Top}
          className={HANDLE}
        />
        {children}
        <Handle
          type="source"
          id="out"
          position={Position.Bottom}
          className={HANDLE}
        />
      </AgentMenu>
    </Agent>
  )
}

function AgentHeader({
  id,
  role,
  focused,
}: {
  id: string
  role: Role
  focused: boolean
}) {
  const { data } = useAgent()
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the double click mirrors the focus button beside it.
    <header
      onDoubleClick={(e) => {
        if (!(e.target as Element).closest("button")) toggleFocus(id)
      }}
      className="flex h-12 shrink-0 items-center gap-2.5 border-b px-3"
    >
      {AVATAR[role]}
      <div className="min-w-0 max-w-44 shrink-0">
        <div
          className={cn(
            "truncate leading-5",
            role === "ceo" ? "font-semibold" : "font-medium"
          )}
        >
          {data.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {ROLE_LABEL[role]} · {MODEL_LABEL[data.model]}
        </div>
      </div>
      <AgentStatus className="flex-1" />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={focused ? "Exit focus" : "Focus terminal"}
        aria-pressed={focused}
        title={focused ? "Exit focus (⌘Esc)" : "Focus terminal"}
        onClick={() => toggleFocus(id)}
        className="text-muted-foreground"
      >
        {focused ? <ArrowsInSimpleIcon /> : <ArrowsOutSimpleIcon />}
      </Button>
    </header>
  )
}

const AVATAR: Record<Role, ReactNode> = {
  ceo: (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background">
      <CrownSimpleIcon weight="fill" className="size-4" />
    </span>
  ),
  lead: (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
      <UsersThreeIcon weight="bold" className="size-4" />
    </span>
  ),
  member: (
    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
      <UserIcon weight="bold" className="size-3.5" />
    </span>
  ),
}

// Weight follows rank: the CEO carries the heaviest frame, Members the lightest.
const FRAME: Record<Role, string> = {
  ceo: "rounded-2xl border-2 shadow-lg",
  lead: "rounded-xl border shadow-md",
  member: "rounded-lg border shadow-xs",
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

// One component for every rank: a header over the agent's live terminal.
const AgentCard = memo(function AgentCard(props: NodeProps<AgentNode>) {
  const focused = useFocus(props.id) !== undefined
  return (
    <AgentFrame {...props} focused={focused} className={FRAME[props.type]}>
      <AgentHeader id={props.id} role={props.type} focused={focused} />
      <NodeTerminal id={props.id} focused={focused} />
    </AgentFrame>
  )
})

export const CeoNode = AgentCard
export const LeadNode = AgentCard
export const MemberNode = AgentCard
