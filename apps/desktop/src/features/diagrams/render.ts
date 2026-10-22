import type { Mermaid } from "mermaid"
import { toRgb } from "./color"

let loading: Promise<Mermaid> | undefined
// Loaded on the first diagram, never in the main bundle.
const load = () =>
  (loading ??= import("mermaid").then(
    (m) => m.default,
    (e) => {
      loading = undefined
      throw e
    }
  ))

export const darkScheme = matchMedia("(prefers-color-scheme: dark)")

function themeVariables(dark: boolean) {
  const root = getComputedStyle(document.documentElement)
  const token = (name: string) => toRgb(root.getPropertyValue(`--${name}`))
  return {
    darkMode: dark,
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: "14px",
    background: token("card"),
    primaryColor: token("secondary"),
    primaryTextColor: token("foreground"),
    primaryBorderColor: token("primary"),
    secondaryColor: token("accent"),
    tertiaryColor: token("muted"),
    lineColor: token("muted-foreground"),
    textColor: token("foreground"),
    edgeLabelBackground: token("card"),
    clusterBkg: token("muted"),
    clusterBorder: token("muted-foreground"),
  }
}

let queue: Promise<unknown> = Promise.resolve()
let seq = 0

// Mermaid is not reentrant, so renders run one at a time; parse throws before a bad source can touch the DOM.
export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await load()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Without it a failed render appends mermaid's error SVG to <body>.
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: themeVariables(dark),
    })
    await mermaid.parse(source)
    return (await mermaid.render(`diagram-${++seq}`, source)).svg
  })
  queue = job.catch(() => {})
  return job
}
