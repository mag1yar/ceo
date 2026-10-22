import { SidebarSimpleIcon } from "@phosphor-icons/react"
import { cn } from "cn"
import {
  type ComponentProps,
  type CSSProperties,
  createContext,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Button } from "./button"

const SIDEBAR_WIDTH = { min: 200, default: 256, max: 400 }
const WIDTH_KEY = "ceo.sidebar.width"
const COLLAPSED_KEY = "ceo.sidebar.collapsed"

function clampSidebarWidth(value: number) {
  if (!Number.isFinite(value)) return SIDEBAR_WIDTH.default
  return Math.min(
    SIDEBAR_WIDTH.max,
    Math.max(SIDEBAR_WIDTH.min, Math.round(value))
  )
}

// shortcut: localStorage until the storage task (#3) lands, then move these two values there.
function readStored(key: string) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {}
}

type AppShellContextValue = {
  collapsed: boolean
  toggleSidebar: () => void
  width: number
  setWidth: (width: number) => void
  rootRef: RefObject<HTMLDivElement | null>
}

const AppShellContext = createContext<AppShellContextValue | null>(null)

function useAppShell() {
  const context = use(AppShellContext)
  if (!context) throw new Error("useAppShell must be used inside <AppShell>")
  return context
}

function AppShell({ className, style, ...props }: ComponentProps<"div">) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(
    () => readStored(COLLAPSED_KEY) === "true"
  )
  const [width, setWidthState] = useState(() => {
    const stored = readStored(WIDTH_KEY)
    return stored === null ? SIDEBAR_WIDTH.default : clampSidebarWidth(+stored)
  })

  const toggleSidebar = useCallback(() => setCollapsed((value) => !value), [])

  useEffect(() => writeStored(COLLAPSED_KEY, String(collapsed)), [collapsed])

  const setWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value)
    writeStored(WIDTH_KEY, String(next))
    setWidthState(next)
  }, [])

  const context = useMemo(
    () => ({ collapsed, toggleSidebar, width, setWidth, rootRef }),
    [collapsed, toggleSidebar, width, setWidth]
  )

  return (
    <AppShellContext value={context}>
      <div
        ref={rootRef}
        data-slot="app-shell"
        data-sidebar={collapsed ? "collapsed" : "expanded"}
        style={{ "--sidebar-width": `${width}px`, ...style } as CSSProperties}
        className={cn(
          "group/shell relative flex h-svh overflow-hidden data-resizing:cursor-col-resize",
          className
        )}
        {...props}
      />
    </AppShellContext>
  )
}

function Sidebar({ className, children, ...props }: ComponentProps<"aside">) {
  const { collapsed } = useAppShell()
  return (
    <>
      <aside
        data-slot="sidebar"
        inert={collapsed}
        className={cn(
          "h-full w-(--sidebar-width) shrink-0 overflow-hidden transition-[width] duration-(--duration-move) ease-spring group-data-[sidebar=collapsed]/shell:w-0 group-data-resizing/shell:transition-none",
          className
        )}
        {...props}
      >
        {/* Fixed inner width so content clips instead of reflowing while the sidebar animates. */}
        <div className="flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground transition-opacity duration-(--duration-base) ease-out group-data-[sidebar=collapsed]/shell:opacity-0">
          {children}
        </div>
      </aside>
      <SidebarResizeHandle />
    </>
  )
}

function SidebarResizeHandle() {
  const { width, setWidth, rootRef } = useAppShell()
  const drag = useRef<{ startX: number; startWidth: number; width: number }>(
    null
  )

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width, width }
    rootRef.current?.setAttribute("data-resizing", "")
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current) return
    current.width = clampSidebarWidth(
      current.startWidth + event.clientX - current.startX
    )
    // Written straight to the DOM so a drag does not re-render the shell on every move.
    rootRef.current?.style.setProperty("--sidebar-width", `${current.width}px`)
  }

  function onPointerUp() {
    const current = drag.current
    if (!current) return
    drag.current = null
    rootRef.current?.removeAttribute("data-resizing")
    setWidth(current.width)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0
    if (!step) return
    event.preventDefault()
    setWidth(width + step)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter has no native element.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      data-slot="sidebar-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={onKeyDown}
      className="group/handle relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize outline-none group-data-[sidebar=collapsed]/shell:hidden"
    >
      <div className="mx-auto h-full w-0.5 bg-transparent transition-colors duration-(--duration-base) ease-out group-hover/handle:bg-ring group-hover/handle:delay-150 group-focus-visible/handle:bg-ring group-data-resizing/shell:bg-ring" />
    </div>
  )
}

function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-1 pr-2 pl-[calc(var(--traffic-lights-width)+2.25rem)]",
        className
      )}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarTrigger({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  const { collapsed, toggleSidebar } = useAppShell()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      data-slot="sidebar-trigger"
      aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
      title={collapsed ? "Show sidebar (⌘B)" : "Hide sidebar (⌘B)"}
      onClick={toggleSidebar}
      className={cn(
        "absolute top-[calc((var(--titlebar-height)-1.75rem)/2)] left-(--traffic-lights-width) z-20 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground dark:hover:bg-sidebar-accent",
        className
      )}
      {...props}
    >
      <SidebarSimpleIcon />
    </Button>
  )
}

function Main({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      data-slot="main"
      className={cn(
        "relative flex min-w-0 flex-1 flex-col border-sidebar-border bg-background group-data-[sidebar=expanded]/shell:border-l",
        className
      )}
      {...props}
    />
  )
}

function MainHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      data-slot="main-header"
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-(--titlebar-height) shrink-0 items-center gap-2 px-4 transition-[padding] duration-(--duration-move) ease-spring group-data-[sidebar=collapsed]/shell:pl-[calc(var(--traffic-lights-width)+2.75rem)] group-data-resizing/shell:transition-none",
        className
      )}
      {...props}
    />
  )
}

function MainContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="main-content"
      className={cn("flex min-h-0 flex-1 flex-col overflow-auto", className)}
      {...props}
    />
  )
}

export {
  AppShell,
  clampSidebarWidth,
  Main,
  MainContent,
  MainHeader,
  SIDEBAR_WIDTH,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarTrigger,
  useAppShell,
}
