import { useEffect } from "react"

type Kind = "node" | "edge"

// The focusable React Flow wrapper of a board item; editors portaled outside it find their way back here.
const boardItem = (kind: Kind, id: string) =>
  document.querySelector<HTMLElement>(
    `.react-flow__${kind}[data-id="${CSS.escape(id)}"]`
  )

// Closes an editor by handing the keyboard back to its item; the editor's blur commits, also when the item cannot take focus.
export function returnFocus(kind: Kind, id: string, editor: HTMLElement) {
  boardItem(kind, id)?.focus()
  if (document.activeElement === editor) editor.blur()
}

// Enter on the focused item opens its editor: the keyboard twin of the double-click.
export function useEnterToEdit(
  inside: Element | null,
  kind: Kind,
  edit: () => void
) {
  useEffect(() => {
    const item = inside?.closest(`.react-flow__${kind}`)
    const onKeyDown = (e: Event) => {
      if ((e as KeyboardEvent).key !== "Enter" || e.target !== item) return
      e.preventDefault()
      edit()
    }
    item?.addEventListener("keydown", onKeyDown)
    return () => item?.removeEventListener("keydown", onKeyDown)
  }, [inside, kind, edit])
}
