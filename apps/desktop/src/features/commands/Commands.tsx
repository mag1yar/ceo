import { FolderSimpleIcon } from "@phosphor-icons/react"
import { useAppShell } from "@workspace/ui/components/app-shell"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@workspace/ui/components/command"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Kbd, KbdGroup } from "@workspace/ui/components/kbd"
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { useProjects } from "@/features/projects/projects"
import { enableMenu, installMenu } from "./menu"
import {
  COMMANDS,
  GROUPS,
  keys,
  matches,
  onKeyDown,
  runCommand,
  type Shortcut,
  useAvailableCommands,
  useCommand,
} from "./registry"

const PALETTE = COMMANDS.find((c) => c.id === "palette")

// Mounted once inside <AppShell>: the keyboard listener, the app menu, the palette and the shortcut help.
export function Commands() {
  const { toggleSidebar } = useAppShell()
  const { add } = useProjects()
  const [open, setOpen] = useState<"palette" | "help" | null>(null)
  // Opened by keyboard there is no trigger to return to, so focus goes back where it was (a terminal keeps its keys).
  const back = useRef<Element | null>(null)
  const remember = useCallback(() => {
    back.current ??= document.activeElement
  }, [])
  // After the close finishes: a command that moved focus on purpose keeps it.
  const restore = useCallback((opened: boolean) => {
    if (opened) return
    const el = back.current
    back.current = null
    const idle =
      !document.activeElement || document.activeElement === document.body
    if (idle && el instanceof HTMLElement && el.isConnected) el.focus()
  }, [])

  useCommand(
    "palette",
    useCallback(() => {
      remember()
      setOpen((o) => (o === "palette" ? null : "palette"))
    }, [remember])
  )
  useCommand(
    "help",
    useCallback(() => {
      remember()
      setOpen("help")
    }, [remember])
  )
  useCommand("sidebar.toggle", toggleSidebar)
  useCommand("project.add", add)

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true)
    // Headless specs have no native menu behind the mocked IPC.
    if (import.meta.env.MODE !== "e2e") installMenu().catch(console.error)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])

  const available = useAvailableCommands()
  useEffect(() => {
    if (import.meta.env.MODE !== "e2e")
      enableMenu(available).catch(console.error)
  }, [available])

  const close = (next: boolean) => !next && setOpen(null)
  return (
    <>
      <Palette
        open={open === "palette"}
        onOpenChange={close}
        onOpenChangeComplete={restore}
      />
      <ShortcutHelp
        open={open === "help"}
        onOpenChange={close}
        onOpenChangeComplete={restore}
      />
    </>
  )
}

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete: (open: boolean) => void
}

function Palette({ open, onOpenChange, onOpenChangeComplete }: DialogProps) {
  const commands = useAvailableCommands()
  const { projects, select } = useProjects()
  // Close first, so a command that opens a dialog of its own is not covered by the palette.
  const run = (fn: () => void) => {
    onOpenChange(false)
    fn()
  }
  // The input takes the keys, so Cmd+K closes the palette from here.
  const onKeyDown = (e: KeyboardEvent) => {
    if (PALETTE?.shortcuts?.some((s) => matches(s, e.nativeEvent))) {
      e.preventDefault()
      onOpenChange(false)
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title="Command palette"
      description="Search for a command or a project"
      // Opened by keyboard many times a day, so it appears and leaves without animation.
      className="sm:max-w-lg data-open:animate-none data-closed:animate-none"
    >
      <Command loop onKeyDown={onKeyDown}>
        <CommandInput autoFocus placeholder="Type a command or a project…" />
        <CommandList>
          <CommandEmpty>Nothing found</CommandEmpty>
          {GROUPS.map((group) => {
            const shown = commands.filter(
              (c) => c.group === group && c.id !== "palette"
            )
            if (!shown.length) return null
            return (
              <CommandGroup key={group} heading={group}>
                {shown.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={c.title}
                    onSelect={() => run(() => runCommand(c.id))}
                  >
                    <c.icon />
                    {c.title}
                    {c.shortcuts && (
                      <CommandShortcut>
                        <Keys shortcut={c.shortcuts[0]} />
                      </CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}
          {!!projects?.length && (
            <CommandGroup heading="Switch project">
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.path}`}
                  onSelect={() => run(() => select(p.id))}
                >
                  <FolderSimpleIcon />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto max-w-1/2 truncate text-xs text-muted-foreground">
                    {p.path}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

function ShortcutHelp({
  open,
  onOpenChange,
  onOpenChangeComplete,
}: DialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <DialogContent
        showCloseButton={false}
        className="gap-3 sm:max-w-md motion-reduce:data-closed:zoom-out-100 motion-reduce:data-open:zoom-in-100"
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Every app shortcut, grouped by menu
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 max-h-[60vh] overflow-y-auto px-4">
          {GROUPS.map((group) => {
            const listed = COMMANDS.filter(
              (c) => c.group === group && c.shortcuts
            )
            if (!listed.length) return null
            return (
              <section key={group} aria-label={group} className="py-1.5">
                <h3 className="py-1 text-xs font-semibold text-muted-foreground">
                  {group}
                </h3>
                <ul>
                  {listed.map((c) => (
                    <li
                      key={c.id}
                      className="flex h-7 items-center justify-between gap-4"
                    >
                      {c.title}
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        {c.shortcuts?.map((s, i) => (
                          <span key={keys(s).join()} className="contents">
                            {i > 0 && "or"}
                            <Keys shortcut={s} />
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Screen readers mangle the modifier glyphs, so the group carries the spoken form.
const SPOKEN: Record<string, string> = { "⌘": "Command", "⇧": "Shift" }

function Keys({ shortcut }: { shortcut: Shortcut }) {
  const caps = keys(shortcut)
  return (
    <KbdGroup aria-label={caps.map((k) => SPOKEN[k] ?? k).join(" ")}>
      {caps.map((k) => (
        <Kbd key={k} aria-hidden className="dark:bg-foreground/10">
          {k}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
