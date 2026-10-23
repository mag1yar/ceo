import { cn } from "@workspace/ui/lib/utils"
import {
  type NodeProps,
  NodeResizer,
  NodeToolbar,
  useReactFlow,
} from "@xyflow/react"
import {
  memo,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useState,
} from "react"
import Markdown, { type Components } from "react-markdown"
import { returnFocus, useEnterToEdit } from "./keyboard"
import { NodeHandles } from "./NodeHandles"
import {
  freshNotes,
  NOTE_BG,
  NOTE_COLORS,
  type NoteColor,
  type NoteNode,
} from "./note"

export const NoteNodeView = memo(function NoteNodeView({
  id,
  data,
  selected,
}: NodeProps<NoteNode>) {
  const { updateNodeData } = useReactFlow()
  const [fresh] = useState(() => freshNotes.has(id))
  const [editing, setEditing] = useState(fresh)
  useEffect(() => {
    freshNotes.delete(id)
  }, [id])
  const edit = useCallback(() => setEditing(true), [])
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  useEnterToEdit(frame, "node", edit)
  // One commit per editing session, so undo steps over the whole edit.
  const finish = (text: string) => {
    setEditing(false)
    if (text !== data.text) updateNodeData(id, { text })
  }
  return (
    <NoteFrame
      ref={setFrame}
      color={data.color}
      selected={selected}
      fresh={fresh}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={140}
        minHeight={72}
        lineClassName="border-primary/60!"
        handleClassName="size-2! rounded-xs! border-primary! bg-background!"
      />
      <NoteColors
        value={data.color}
        onChange={(color) =>
          color !== data.color && updateNodeData(id, { color })
        }
      />
      {editing ? (
        <NoteEditor id={id} text={data.text} onDone={finish} />
      ) : (
        <NoteView text={data.text} onEdit={edit} />
      )}
      <NodeHandles />
    </NoteFrame>
  )
})

function NoteFrame({
  ref,
  color,
  selected,
  fresh,
  children,
}: {
  ref: Ref<HTMLDivElement>
  color: NoteColor
  selected: boolean
  fresh: boolean
  children: ReactNode
}) {
  return (
    <div
      ref={ref}
      data-color={color}
      className={cn(
        "group size-full rounded-lg border text-sm text-foreground shadow-xs",
        NOTE_BG[color] ?? NOTE_BG.default,
        selected && "border-primary ring-1 ring-primary",
        fresh &&
          "transition-[opacity,scale] duration-(--duration-base) ease-out starting:scale-90 starting:opacity-0 motion-reduce:starting:scale-100"
      )}
    >
      {children}
    </div>
  )
}

// Links and images never render live: a click must not navigate the webview, and notes fetch nothing remote.
const MARKDOWN: Components = {
  a: ({ children }) => <span className="underline">{children}</span>,
  img: ({ alt }) => <span className="text-muted-foreground">{alt}</span>,
}

const NoteView = memo(function NoteView({
  text,
  onEdit,
}: {
  text: string
  onEdit: () => void
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click edits like a canvas; the textarea is the accessible editor.
    <div
      onDoubleClick={onEdit}
      className="size-full overflow-hidden px-3 py-2 break-words [&_*+*]:mt-1.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:list-disc [&_ul]:pl-4"
    >
      {text ? (
        <Markdown components={MARKDOWN}>{text}</Markdown>
      ) : (
        <p className="text-foreground/70">Double-click to write</p>
      )}
    </div>
  )
})

const focusEnd = (el: HTMLTextAreaElement | null) => {
  if (!el) return
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
}

function NoteEditor({
  id,
  text,
  onDone,
}: {
  id: string
  text: string
  onDone: (text: string) => void
}) {
  return (
    <textarea
      ref={focusEnd}
      aria-label="Note text"
      defaultValue={text}
      onBlur={(e) => onDone(e.currentTarget.value)}
      // Focus goes back to the note, which commits the edit through blur and keeps the keyboard on the board.
      onKeyDown={(e) =>
        e.key === "Escape" && returnFocus("node", id, e.currentTarget)
      }
      className="nodrag nopan nowheel size-full resize-none bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none select-text"
    />
  )
}

function NoteColors({
  value,
  onChange,
}: {
  value: NoteColor
  onChange: (color: NoteColor) => void
}) {
  return (
    <NodeToolbar
      offset={8}
      className="flex gap-1 rounded-lg border bg-popover p-1 shadow-md"
    >
      {NOTE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          tabIndex={0}
          aria-label={`${c} colour`}
          aria-pressed={c === value}
          onClick={() => onChange(c)}
          className={cn(
            "size-5 rounded-full border transition-transform duration-(--duration-fast) ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-90",
            NOTE_BG[c],
            c === value &&
              "ring-2 ring-primary ring-offset-1 ring-offset-popover"
          )}
        />
      ))}
    </NodeToolbar>
  )
}
