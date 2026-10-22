import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@workspace/ui/globals.css"
import { App } from "./App.tsx"
import { listenQuit } from "./features/board/quit"

// Statically false outside `vite --mode e2e`, so the mock never reaches a real build.
if (import.meta.env.MODE === "e2e") await import("./e2e/mock-ipc")

listenQuit()

// biome-ignore lint/style/noNonNullAssertion: index.html always has #root
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
