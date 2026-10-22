import { cn } from "@workspace/ui/lib/utils"
import {
  Handle,
  type NodeProps,
  NodeResizer,
  NodeToolbar,
  Position,
  useReactFlow,
} from "@xyflow/react"
import { memo, useEffect, useState, useSyncExternalStore } from "react"
import type { DiagramNode } from "./diagram"
import { darkScheme, renderDiagram } from "./render"

const PREVIEW_DELAY = 250

const subscribe = (onChange: () => void) => {
  darkScheme.addEventListener("change", onChange)
  return () => darkScheme.removeEventListener("change", onChange)
}

// Renders after a pause while typing; a failed render keeps the last good SVG.
function useDiagram(source: string, delay: number) {
  const dark = useSyncExternalStore(subscribe, () => darkScheme.matches)
  const [result, setResult] = useState<{ svg?: string; error?: string }>({})
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      renderDiagram(source, dark).then(
        (svg) => live && setResult({ svg }),
        (e) =>
          live &&
          setResult((r) => ({
            svg: r.svg,
            error: e instanceof Error ? e.message : String(e),
          }))
      )
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [source, dark, delay])
  return result
}

export const DiagramNodeView = memo(function DiagramNodeView({
  id,
  data,
  selected,
}: NodeProps<DiagramNode>) {
  const { updateNodeData } = useReactFlow()
  const [draft, setDraft] = useState<string>()
  const editing = draft !== undefined
  const { svg, error } = useDiagram(
    draft ?? data.source,
    editing ? PREVIEW_DELAY : 0
  )
  // One commit per editing session, so undo steps over the whole edit.
  const finish = (source: string) => {
    setDraft(undefined)
    if (source !== data.source) updateNodeData(id, { source })
  }
  return (
    <div
      className={cn(
        "group size-full rounded-lg border bg-card text-foreground shadow-xs",
        selected && "border-primary ring-1 ring-primary"
      )}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={120}
        lineClassName="border-primary/60!"
        handleClassName="size-2! rounded-xs! border-primary! bg-background!"
      />
      <NodeToolbar isVisible={editing} position={Position.Right} offset={12}>
        {editing && (
          <DiagramEditor
            source={draft}
            error={error}
            onChange={setDraft}
            onDone={finish}
          />
        )}
      </NodeToolbar>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click edits like a canvas; the textarea is the accessible editor. */}
      <div
        data-slot="diagram"
        onDoubleClick={() => setDraft(data.source)}
        className="relative size-full overflow-hidden p-3"
      >
        {svg ? (
          <div
            className="size-full [&>svg]:mx-auto [&>svg]:block [&>svg]:size-full"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's strict security level sanitises its own SVG.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <p className="grid size-full place-items-center text-xs text-muted-foreground">
            {error && !editing ? "Could not render" : "Rendering"}
          </p>
        )}
        {svg && error && !editing && (
          <span className="absolute bottom-2 left-3 text-xs text-destructive">
            Could not render
          </span>
        )}
      </div>
      <DiagramHandles />
    </div>
  )
})

const focusEnd = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
}

function DiagramEditor({
  source,
  error,
  onChange,
  onDone,
}: {
  source: string
  error?: string
  onChange: (source: string) => void
  onDone: (source: string) => void
}) {
  return (
    // Commits when focus leaves the whole panel, so the error text stays selectable.
    <fieldset
      aria-label="Diagram editor"
      onBlur={(e) =>
        !e.currentTarget.contains(e.relatedTarget) && onDone(source)
      }
      className="nodrag nopan nowheel flex w-80 origin-left flex-col gap-1.5 rounded-lg border bg-popover p-1.5 shadow-md transition-[opacity,scale] duration-(--duration-fast) ease-out starting:scale-97 starting:opacity-0 motion-reduce:starting:scale-100"
    >
      <textarea
        ref={focusEnd}
        aria-label="Diagram source"
        spellCheck={false}
        value={source}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) =>
          (e.key === "Escape" || (e.key === "Enter" && e.metaKey)) &&
          e.currentTarget.blur()
        }
        className="h-56 resize-none bg-transparent px-2 py-1.5 font-mono text-xs leading-5 outline-none select-text"
      />
      {error && (
        <pre
          role="alert"
          tabIndex={-1}
          className="max-h-28 overflow-auto rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap text-destructive outline-none select-text"
        >
          {error}
        </pre>
      )}
    </fieldset>
  )
}

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left]

// Same handles as notes: every side is a source, and the board's loose mode lets any take a link.
function DiagramHandles() {
  return SIDES.map((side) => (
    <Handle
      key={side}
      id={side}
      type="source"
      position={side}
      className="size-2.5! rounded-full! border! border-primary! bg-background! opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100"
    />
  ))
}
