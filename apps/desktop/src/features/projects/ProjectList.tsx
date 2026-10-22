import { PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import { Input } from "@workspace/ui/components/input"
import {
  AnimatePresence,
  MotionConfig,
  motion,
  Reorder,
  type Transition,
} from "motion/react"
import { type KeyboardEvent, useRef, useState } from "react"
import type { Project } from "@/lib/store"
import { useProjects } from "./projects"

// Matches --ease-spring in DESIGN.md: no overshoot, settles in 300ms.
const spring: Transition = { type: "spring", duration: 0.3, bounce: 0 }

export function ProjectList() {
  const { projects, activeId, add, reorder } = useProjects()
  const [removing, setRemoving] = useState<Project | null>(null)
  if (!projects) return null

  return (
    <>
      <div className="flex h-7 items-center justify-between pr-0.5 pl-2">
        <p className="text-xs font-semibold text-sidebar-muted-foreground">
          Projects
        </p>
        {projects.length > 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add project"
            title="Add project"
            onClick={add}
            className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground dark:hover:bg-sidebar-accent"
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      {projects.length === 0 ? (
        <p className="px-2 text-sm text-sidebar-muted-foreground">
          No projects yet
        </p>
      ) : (
        // Reduced motion drops transforms and keeps fades, as in DESIGN.md.
        <MotionConfig reducedMotion="user">
          <Reorder.Group
            axis="y"
            values={projects}
            onReorder={reorder}
            aria-label="Projects"
            className="relative flex flex-col gap-0.5"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  active={project.id === activeId}
                  onRemove={() => setRemoving(project)}
                />
              ))}
            </AnimatePresence>
          </Reorder.Group>
        </MotionConfig>
      )}
      <RemoveProjectDialog
        project={removing}
        onClose={() => setRemoving(null)}
      />
    </>
  )
}

function ProjectRow({
  project,
  active,
  onRemove,
}: {
  project: Project
  active: boolean
  onRemove: () => void
}) {
  const { select, saveOrder, move } = useProjects()
  const [renaming, setRenaming] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  // Rename starts once the menu has closed, and the menu then skips its focus return so the input keeps focus.
  const renameOnClose = useRef(false)

  function onKeyDown(event: KeyboardEvent) {
    const delta = event.altKey
      ? { ArrowUp: -1, ArrowDown: 1 }[event.key]
      : undefined
    if (delta) {
      event.preventDefault()
      move(project.id, delta)
    } else if (event.key === "F2") {
      event.preventDefault()
      setRenaming(true)
    } else if (event.metaKey && event.key === "Backspace") {
      event.preventDefault()
      onRemove()
    }
  }

  return (
    <Reorder.Item
      value={project}
      dragListener={!renaming}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={spring}
      whileDrag={{ zIndex: 1 }}
      onDragEnd={saveOrder}
      data-active={active || undefined}
      className="group/row relative rounded-md"
    >
      {active && (
        <motion.div
          layoutId="active-project"
          transition={spring}
          className="pointer-events-none absolute inset-0 rounded-md bg-sidebar-accent"
        />
      )}
      {renaming ? (
        <RenameInput
          project={project}
          onDone={(refocus) => {
            setRenaming(false)
            if (refocus) requestAnimationFrame(() => button.current?.focus())
          }}
        />
      ) : (
        <ContextMenu
          onOpenChangeComplete={(open) => {
            if (!open && renameOnClose.current) setRenaming(true)
          }}
        >
          <ContextMenuTrigger
            render={
              <button
                ref={button}
                type="button"
                aria-current={active ? "page" : undefined}
                title={project.path}
                onClick={() => select(project.id)}
                onDoubleClick={() => setRenaming(true)}
                onKeyDown={onKeyDown}
              />
            }
            className="relative flex h-7 w-full cursor-default items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-active/row:font-medium group-data-active/row:text-sidebar-accent-foreground group-data-active/row:hover:bg-transparent"
          >
            <Initials name={project.name} />
            <span className="truncate">{project.name}</span>
          </ContextMenuTrigger>
          <ContextMenuContent
            finalFocus={() => {
              const renaming = renameOnClose.current
              renameOnClose.current = false
              return !renaming
            }}
          >
            <ContextMenuItem
              onClick={() => {
                renameOnClose.current = true
              }}
            >
              <PencilSimpleIcon />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onRemove}>
              <TrashIcon />
              Remove from list…
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </Reorder.Item>
  )
}

function Initials({ name }: { name: string }) {
  const words = name.split(/[\s\-_.]+/).filter(Boolean)
  const initials = words
    .slice(0, 2)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase()
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-sidebar-foreground/10 text-[10px] font-semibold tracking-normal text-sidebar-foreground"
    >
      {initials || "?"}
    </span>
  )
}

function RenameInput({
  project,
  onDone,
}: {
  project: Project
  onDone: (refocus: boolean) => void
}) {
  const { rename } = useProjects()
  const finished = useRef(false)

  function finish(name: string | null, refocus: boolean) {
    if (finished.current) return
    finished.current = true
    if (name?.trim()) rename(project.id, name.trim())
    onDone(refocus)
  }

  return (
    <Input
      autoFocus
      aria-label="Project name"
      defaultValue={project.name}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value, false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value, true)
        if (event.key === "Escape") finish(null, true)
      }}
      className="relative h-7 rounded-md bg-background px-1.5 dark:bg-background"
    />
  )
}

function RemoveProjectDialog({
  project,
  onClose,
}: {
  project: Project | null
  onClose: () => void
}) {
  const { remove } = useProjects()
  // Keeps the text while the dialog animates out after `project` clears.
  const shown = useRef(project)
  if (project) shown.current = project

  return (
    <AlertDialog
      open={project !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{shown.current?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The project and its board leave CEO. Files on disk are not touched:
            the folder <span className="break-all">{shown.current?.path}</span>{" "}
            stays as it is.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (project) remove(project.id)
              onClose()
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
