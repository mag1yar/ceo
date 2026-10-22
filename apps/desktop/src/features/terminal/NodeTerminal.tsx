import "@xterm/xterm/css/xterm.css"
import { cn } from "@workspace/ui/lib/utils"
import { WebglAddon } from "@xterm/addon-webgl"
import { memo, useEffect, useRef } from "react"
import { useSession } from "./terminals"

// Lets a resize transition settle before the PTY gets new cols and rows.
const FIT_DELAY = 60

// The agent's shell inside its node: read-only DOM output in overview, WebGL and keyboard in focus.
export const NodeTerminal = memo(function NodeTerminal({
  id,
  focused,
}: {
  id: string
  focused: boolean
}) {
  const session = useSession(id)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !session) return
    const { term, fit } = session
    // Off-screen nodes keep filling the buffer; xterm pauses their rendering on its own (IntersectionObserver).
    if (term.element) el.appendChild(term.element)
    else term.open(el)
    let timer = 0
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (el.clientWidth && el.clientHeight) fit.fit()
      }, FIT_DELAY)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [session])

  useEffect(() => {
    if (!session || !focused) return
    const { term } = session
    term.options.disableStdin = false
    // shortcut: WebKit keeps about 16 WebGL contexts, so only the focused terminal holds one.
    let webgl: WebglAddon | undefined
    try {
      webgl = new WebglAddon()
      // A lost context falls back to the DOM renderer.
      webgl.onContextLoss(() => webgl?.dispose())
      term.loadAddon(webgl)
    } catch {}
    term.focus()
    return () => {
      webgl?.dispose()
      term.options.disableStdin = true
      term.blur()
    }
  }, [session, focused])

  return (
    <div
      data-slot="node-terminal"
      className={cn(
        // xterm.css paints its viewport black under the themed layer; scaled edges would show it.
        "min-h-0 flex-1 overflow-hidden rounded-b-[inherit] bg-terminal-background py-1 pr-1 pl-2 [&_.xterm-viewport]:bg-transparent!",
        // Overview passes the pointer to the node so it drags and the wheel pans the board.
        focused ? "nodrag nopan nowheel cursor-text" : "pointer-events-none"
      )}
    >
      <div ref={ref} className="size-full" />
    </div>
  )
})
