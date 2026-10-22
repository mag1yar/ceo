import {
  Menu,
  MenuItem,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu"
import { accelerator, COMMANDS, type Command, runFromMenu } from "./registry"

const native = (...items: PredefinedMenuItemOptions["item"][]) =>
  items.map((item) => ({ item }))

const titleCase = (s: string) =>
  s.replace(/(^|\s)(?!to\s)(\p{Ll})/gu, (m) => m.toUpperCase())

const entries = new Map<string, MenuItem>()

const items = (group: Command["group"]) =>
  Promise.all(
    COMMANDS.filter((c) => c.group === group && c.menu !== false).map(
      async (c) => {
        const item = await MenuItem.new({
          id: c.id,
          text: titleCase(c.title),
          accelerator: accelerator(c.shortcuts?.[0]),
          enabled: false,
          action: runFromMenu,
        })
        entries.set(c.id, item)
        return item
      }
    )
  )

let installed: Promise<unknown> | undefined

/** The macOS menu bar: the standard App, Edit and Window menus plus one menu per registry group. */
export function installMenu() {
  installed ??= (async () => {
    const menu = await Menu.new({
      items: [
        {
          text: "CEO",
          items: native(
            { About: null },
            "Separator",
            "Services",
            "Separator",
            "Hide",
            "HideOthers",
            "ShowAll",
            "Separator",
            "Quit"
          ),
        },
        { text: "Project", items: await items("Project") },
        {
          text: "Edit",
          items: native(
            "Undo",
            "Redo",
            "Separator",
            "Cut",
            "Copy",
            "Paste",
            "SelectAll"
          ),
        },
        {
          text: "View",
          items: [
            ...(await items("View")),
            ...native("Separator", "Fullscreen"),
          ],
        },
        { text: "Board", items: await items("Board") },
        {
          text: "Window",
          items: native("Minimize", "Maximize", "Separator", "CloseWindow"),
        },
        { text: "Help", items: await items("Help") },
      ],
    })
    await menu.setAsAppMenu()
  })()
  return installed
}

/** Greys out the items whose command has no run function bound right now. */
export async function enableMenu(available: Command[]) {
  await installMenu()
  const on = new Set(available.map((c) => c.id))
  await Promise.all(
    [...entries].map(([id, item]) => item.setEnabled(on.has(id)))
  )
}
