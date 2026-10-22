import { $, $$, browser } from "@wdio/globals"

type Invoke = (cmd: string, args?: object) => Promise<unknown>
export type Project = { id: string; name: string }

// Real IPC into the Rust store, from inside the webview.
export function invoke<T>(cmd: string, args: object = {}) {
  return browser.execute(
    (cmd, args) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }
      ).__TAURI_INTERNALS__.invoke(cmd, args),
    cmd,
    args
  ) as Promise<T>
}

export const folder = (name: string) => `/tmp/ceo-e2e/${name}`

// Rows carry the folder path as their title.
export const row = (name: string) =>
  $(`ul[aria-label=Projects] button[title="${folder(name)}"]`)

export const rowNames = () =>
  $$("ul[aria-label=Projects] li .truncate").map((el) => el.getText())
