import "@xterm/xterm/css/xterm.css"
import { CaretDownIcon, CaretUpIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { WebglAddon } from "@xterm/addon-webgl"
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react"
import { useProjects } from "@/features/projects/projects"
import {
  closeTerminal,
  selectTerminal,
  setShown,
  type Tab,
  useTerminals,
} from "./terminals"

const HEIGHT_KEY = "ceo.terminal.height"
const HEIGHT = { min: 120, default: 280 }
// The board keeps at least this much room above the dock.
const BOARD_MIN = 160

function storedHeight() {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || HEIGHT.default
  } catch {
    return HEIGHT.default
  }
}

// Bottom dock under the board: tabs of the active project, every terminal of every project stays mounted.
export function TerminalDock({ projectId }: { projectId?: string }) {
  const { tabs, active, shown } = useTerminals()
  const mine = tabs.filter((t) => t.projectId === projectId)
  const activeKey = projectId ? active[projectId] : undefined
  const open = shown && mine.length > 0
  const section = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(storedHeight)
  const hasTabs = mine.length > 0
  const { projects } = useProjects()

  // A removed project takes its shells with it.
  useEffect(() => {
    if (!projects) return
    for (const t of tabs)
      if (!projects.some((p) => p.id === t.projectId)) closeTerminal(t.key)
  }, [projects, tabs])

  useEffect(() => {
    if (!projectId || !hasTabs) return
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.code !== "Backquote") return
      const t = e.target as HTMLElement
      const editing =
        t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName)
      if (editing && !t.closest("[data-slot=terminal-dock]")) return
      e.preventDefault()
      setShown(projectId as string, !open)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [projectId, hasTabs, open])

  if (!tabs.length) return null

  const clamp = (h: number) => {
    const room = (section.current?.parentElement?.clientHeight ?? 0) - BOARD_MIN
    return Math.round(Math.max(HEIGHT.min, Math.min(room, h)))
  }
  const commit = (h: number) => {
    const next = clamp(h)
    setHeight(next)
    try {
      localStorage.setItem(HEIGHT_KEY, String(next))
    } catch {}
  }

  return (
    <section
      ref={section}
      data-slot="terminal-dock"
      aria-label="Terminals"
      hidden={!hasTabs}
      className="relative flex shrink-0 flex-col border-t bg-terminal-background text-terminal-foreground"
    >
      {open && (
        <ResizeHandle
          height={height}
          clamp={clamp}
          onDrag={(h) => body.current?.style.setProperty("height", `${h}px`)}
          onCommit={commit}
        />
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div
          role="tablist"
          aria-label="Open terminals"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {mine.map((t) => (
            <TabButton key={t.key} tab={t} selected={t.key === activeKey} />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={open ? "Hide terminals" : "Show terminals"}
          title={open ? "Hide terminals (⌃`)" : "Show terminals (⌃`)"}
          onClick={() => projectId && setShown(projectId, !open)}
          className="text-muted-foreground"
        >
          {open ? <CaretDownIcon /> : <CaretUpIcon />}
        </Button>
      </div>
      <div
        ref={body}
        hidden={!open}
        // Also caps a stored height on a smaller window: title bar, tab bar and the board's minimum stay visible.
        style={{
          height: `min(${height}px, 100svh - 5.25rem - ${BOARD_MIN}px)`,
        }}
        className="relative min-h-0"
      >
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            tab={t}
            visible={t.projectId === projectId && t.key === activeKey}
          />
        ))}
      </div>
    </section>
  )
}

function TabButton({ tab, selected }: { tab: Tab; selected: boolean }) {
  return (
    <div
      data-selected={selected || undefined}
      className="group/tab flex h-7 max-w-48 shrink-0 items-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) ease-out hover:bg-muted hover:text-foreground data-selected:bg-muted data-selected:text-foreground"
    >
      <button
        type="button"
        role="tab"
        id={`terminal-tab-${tab.key}`}
        aria-selected={selected}
        aria-controls={`terminal-${tab.key}`}
        onClick={() => selectTerminal(tab.key)}
        className="flex h-full min-w-0 items-center truncate rounded-md pr-1 pl-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={cn("truncate", tab.exited && "opacity-60")}>
          {tab.title}
        </span>
        {tab.exited && <span className="ml-1 opacity-60">(exited)</span>}
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${tab.title}`}
        title="Close terminal"
        onClick={() => closeTerminal(tab.key)}
        className="mr-0.5 size-5 opacity-0 group-hover/tab:opacity-100 group-data-selected/tab:opacity-100 focus-visible:opacity-100"
      >
        <XIcon />
      </Button>
    </div>
  )
}

const TerminalView = memo(function TerminalView({
  tab,
  visible,
}: {
  tab: Tab
  visible: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { term, fit } = tab

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (term.element) el.appendChild(term.element)
    else {
      term.open(el)
      // shortcut: one WebGL context per terminal, WebKit keeps about 16; past that the oldest fall back to the DOM renderer. Share or drop contexts of hidden tabs if people open that many.
      try {
        const webgl = new WebglAddon()
        // A lost context falls back to the DOM renderer.
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {}
    }
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (el.clientWidth && el.clientHeight) fit.fit()
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [term, fit])

  return (
    <div
      role="tabpanel"
      id={`terminal-${tab.key}`}
      aria-labelledby={`terminal-tab-${tab.key}`}
      hidden={!visible}
      className="absolute inset-0 pt-1 pr-1 pb-2 pl-3"
    >
      <div ref={ref} className="size-full" />
    </div>
  )
})

function ResizeHandle({
  height,
  clamp,
  onDrag,
  onCommit,
}: {
  height: number
  clamp: (h: number) => number
  onDrag: (h: number) => void
  onCommit: (h: number) => void
}) {
  const drag = useRef<{ y: number; start: number; h: number }>(null)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, start: height, h: height }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.h = clamp(d.start + d.y - e.clientY)
    // Straight to the DOM so a drag does not re-render the dock on every move.
    onDrag(d.h)
  }

  function onPointerUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    onCommit(d.h)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowUp" ? 16 : e.key === "ArrowDown" ? -16 : 0
    if (!step) return
    e.preventDefault()
    onCommit(height + step)
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter has no native element.
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminals"
      aria-valuemin={HEIGHT.min}
      aria-valuenow={height}
      tabIndex={0}
      data-slot="terminal-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={() => onCommit(HEIGHT.default)}
      onKeyDown={onKeyDown}
      className="group/handle absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize outline-none"
    >
      <div className="my-auto h-0.5 w-full translate-y-[3px] bg-transparent transition-colors duration-(--duration-base) ease-out group-hover/handle:bg-ring group-hover/handle:delay-150 group-focus-visible/handle:bg-ring group-active/handle:bg-ring" />
    </div>
  )
}
