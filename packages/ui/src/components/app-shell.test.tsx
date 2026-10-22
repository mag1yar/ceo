import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"

import {
  AppShell,
  clampSidebarWidth,
  Main,
  SIDEBAR_WIDTH,
  Sidebar,
  SidebarTrigger,
} from "./app-shell"

test("sidebar width is clamped and falls back to the default", () => {
  expect(clampSidebarWidth(10)).toBe(SIDEBAR_WIDTH.min)
  expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH.max)
  expect(clampSidebarWidth(300.4)).toBe(300)
  expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default)
})

test("app shell composes sidebar and main, expanded by default", () => {
  const html = renderToStaticMarkup(
    <AppShell>
      <Sidebar>projects</Sidebar>
      <Main>board</Main>
      <SidebarTrigger />
    </AppShell>
  )
  expect(html).toContain('data-sidebar="expanded"')
  expect(html).toContain(`--sidebar-width:${SIDEBAR_WIDTH.default}px`)
  expect(html).toContain('role="separator"')
  expect(html).toContain('aria-label="Hide sidebar"')
})
