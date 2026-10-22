// Shared by the Playwright specs and the hidden-app wdio specs, so both report comparable numbers.
import type { BoardNode } from "../src/lib/store"

export const card = (id: string, x: number, y: number): BoardNode => ({
  id,
  type: "card",
  x,
  y,
  width: null,
  height: null,
  data: { title: `Card ${id}` },
  z: 0,
})

export const cards = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    card(`n${i}`, (i % 20) * 220, Math.floor(i / 20) * 80)
  )

// Runs in the page: records rAF timestamps for `ms`, panning with one wheel event per frame when `pan` is set.
export function recordFrames({ ms, pan }: { ms: number; pan: boolean }) {
  return new Promise<number[]>((resolve) => {
    const pane = document.querySelector(".react-flow__pane") as Element
    const times: number[] = []
    const tick = (t: number) => {
      times.push(t)
      // A slow circle, one turn per second: the pan never stops but ends near where it started.
      const a = (times.length / 60) * 2 * Math.PI
      if (pan)
        pane.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: 12 * Math.cos(a),
            deltaY: 12 * Math.sin(a),
            bubbles: true,
            cancelable: true,
          })
        )
      if (t - times[0] < ms) requestAnimationFrame(tick)
      else resolve(times)
    }
    requestAnimationFrame(tick)
  })
}

export function summarize(frames: number[]) {
  const gaps = frames.slice(1).map((t, i) => t - frames[i])
  const fps = (gaps.length * 1000) / (frames[frames.length - 1] - frames[0])
  return `${frames.length} frames, average ${fps.toFixed(1)} fps, worst frame ${Math.max(...gaps).toFixed(1)} ms`
}
