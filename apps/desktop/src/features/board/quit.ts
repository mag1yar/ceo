import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

// Every mounted board's flush; Rust holds the quit until all of them settle.
const flushes = new Set<() => Promise<unknown>>()

export function onQuit(flush: () => Promise<unknown>) {
  flushes.add(flush)
  return () => {
    flushes.delete(flush)
  }
}

// Once per page load, so a quit with no board open is answered at once.
export const listenQuit = () =>
  listen("app://flush", () =>
    Promise.all([...flushes].map((f) => f())).finally(() =>
      invoke("app_flush_done")
    )
  )
