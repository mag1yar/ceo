# CEO - design direction

Status: set by task #2 (window shell and design system), 2026-10-22.

## Direction

A native macOS work tool in the line of Claude desktop and Orca: calm, dense, quiet chrome, content first. The app should feel like it shipped with the system, not like a web page in a window. Mode is Operate: scanability, consistency and native expectations beat expression. Brand lives in precise details, not decoration.

- **Calm.** Neutral greys, one accent used sparingly (focus, selection, the primary action). No gradients, no glows, no decorative colour.
- **Dense.** 13px control text, 4px spacing grid, 48px title bar. Rows and labels take Orca's density as the reference.
- **Native.** Overlay title bar with the traffic lights inset into the sidebar, real window vibrancy behind the sidebar, the system font, system light and dark appearance, native double-click-to-zoom on the header.
- **Smooth.** Movement uses springs or strong ease-out curves under 300ms, never `ease-in`, and reduced motion removes movement while keeping fades.

## Window

- `titleBarStyle: Overlay`, `hiddenTitle: true` (title stays "CEO" in config), `trafficLightPosition { x: 18, y: 26 }`, which centres the lights in the 48px header.
- `transparent: true` with `windowEffects: sidebar` (`NSVisualEffectMaterialSidebar`, follows the window active state, goes grey when the window is inactive). This needs `macOSPrivateApi` and the `macos-private-api` Tauri feature, so the app cannot go to the Mac App Store as is.
- `html` and `body` are transparent. The sidebar has no background of its own; the main area is opaque `--background`, so the material shows only behind the sidebar. System "Reduce transparency" is handled by the native material itself.
- Headers carry `data-tauri-drag-region="deep"`: dragging moves the window, double-click zooms through the native `zoom:` (Tauri's built-in drag script). Buttons inside a header stay clickable. Needs `core:window:allow-start-dragging`.

## Layout: `AppShell`

`packages/ui/src/components/app-shell.tsx`, composed with slots, no boolean variant props:

```tsx
<AppShell>
  <Sidebar>
    <SidebarHeader />          {/* drag region, clears the traffic lights */}
    <SidebarContent>...</SidebarContent>
  </Sidebar>
  <Main>
    <MainHeader>...</MainHeader>  {/* drag region, shifts right when collapsed */}
    <MainContent>...</MainContent>
  </Main>
  <SidebarTrigger />            {/* fixed next to the traffic lights, never moves */}
</AppShell>
```

- `AppShell` owns the state (collapsed, width) and exposes it through `useAppShell()`. It sets `data-sidebar="expanded|collapsed"` and `--sidebar-width` on the root; children style themselves with `group-data-[sidebar=collapsed]/shell:`.
- Cmd+B toggles the sidebar through the command registry (Cmd only: Ctrl+B is the tmux prefix in terminals). The trigger sits right of the traffic lights in both states, like Finder and Claude desktop.
- The sidebar resizes by dragging its right edge (200 to 400px, default 256). During a drag the width is written straight to the CSS variable and committed on release. Double-click the edge resets the width; the edge is a focusable `separator`, arrow keys move it by 16px.
- Width and collapsed state persist in `localStorage` (`ceo.sidebar.width`, `ceo.sidebar.collapsed`) until the storage task replaces it.
- Slots for later work: project list in `SidebarContent` (#4), board in `MainContent` (#5).

## Tokens

All tokens live in `packages/ui/src/styles/globals.css` as Tailwind v4 theme variables, so shadcn components pick them up through their usual names (`bg-primary`, `text-muted-foreground`, `rounded-lg`, `shadow-md`, `ease-out`).

### Colour

Neutral OKLCH greys (chroma 0) plus one accent, a calm system-like blue: `oklch(0.56 0.19 257)` light, `oklch(0.66 0.17 257)` dark. The accent is `--primary`, `--ring` and the text selection; nothing else is coloured except `--destructive`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | white | `oklch(0.215 0 0)` | main area |
| `--foreground` | `oklch(0.2 0 0)` | `oklch(0.94 0 0)` | text |
| `--muted-foreground` | `oklch(0.52 0 0)` | `oklch(0.68 0 0)` | secondary text |
| `--border` | black 9% | white 9% | hairlines |
| `--sidebar` | clear | clear | sits on vibrancy |
| `--sidebar-foreground` | black 85% | white 85% | label colour over the material |
| `--sidebar-muted-foreground` | black 50% | white 50% | secondary label |
| `--sidebar-accent` | black 6% | white 8% | hover and selected rows |

Text over the material uses translucent label colours, as AppKit does, so it stays legible whatever the wallpaper tint is. Dark mode follows `prefers-color-scheme` (the `dark:` variant is a media query); there is no in-app theme toggle.

### Typography

System font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`, which gives SF Pro with its optical sizes. Mono: `ui-monospace, "SF Mono", Menlo`. Body and controls are 13px (`text-sm`, the macOS body size); tracking tightens as size grows.

| Class | Size / line | Tracking | Use |
|---|---|---|---|
| `text-xs` | 11 / 14 | +0.006em | section labels, captions |
| `text-sm` | 13 / 18 | -0.006em | body, controls (default) |
| `text-base` | 14 / 20 | -0.01em | reading text |
| `text-lg` | 15 / 20 | -0.012em | emphasised titles |
| `text-xl` | 17 / 22 | -0.02em | pane titles |
| `text-2xl` | 22 / 28 | -0.022em | rare large titles |

Hierarchy comes from weight and opacity before size: section labels are 11px semibold at 50%.

### Space, radii, shadows

- Spacing: Tailwind's 4px grid. Shell sizes: `--titlebar-height: 3rem`, `--traffic-lights-width: 5rem`.
- Radii from `--radius: 0.5rem`: `sm` 4, `md` 6, `lg` 8, `xl` 12, `2xl` 16px. Rows and buttons use `md`/`lg`, popovers `xl`.
- Shadows `shadow-xs` to `shadow-lg` map to `--elevation-1..4`; dark mode deepens them and adds a 0.5px light edge so surfaces separate on dark backgrounds.

### Motion

| Token | Value | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | entering, fades, hover |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | on-screen movement |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | sheets and drawers |
| `--ease-spring` + `--duration-spring` (300ms) | `linear()` of a spring, damping 1.0, response 0.25s | default movement, no overshoot |
| `--ease-spring-bounce` + `--duration-spring-bounce` (350ms) | damping 0.8, response 0.3s | only after a gesture with momentum |
| `--duration-fast` / `-base` / `-slow` | 120 / 200 / 300ms | press, popovers, modals |
| `--duration-move` | `= --duration-spring`, `0ms` under reduced motion | anything that changes position or size |

The sidebar collapse animates width and the header inset with `--ease-spring` over `--duration-move`; the sidebar content fades with `--ease-out` over `--duration-base`. A fixed inner width means content clips instead of reflowing. CSS transitions, not keyframes, so a second Cmd+B mid-flight retargets from the current value. Resizing turns transitions off so the edge tracks the pointer 1:1.

`prefers-reduced-motion: reduce` sets `--duration-move` to 0: the sidebar snaps, fades remain.

## Commands and shortcuts

Set by task #10. One registry, `apps/desktop/src/features/commands/registry.ts`, lists every app command with its id, title, group, icon and shortcuts. The keyboard listener, the Cmd+K palette, the help dialog (Cmd+/) and the macOS menu bar all read it; components bind run functions with `useCommand(id, run)`, and a command without one is unavailable.

- Shortcuts match the physical key (`code`), so they work on any layout. They do nothing while the keyboard is in an input, a textarea (the note and diagram editors, xterm's helper), a contenteditable, a menu or an open dialog. The focus mode keys from #15 are the exception and work inside the focused terminal.
- The menu bar is built in JS with `@tauri-apps/api/menu`: the standard App, Edit and Window menus, plus one menu per registry group. Only Cmd shortcuts become accelerators. Undo and Redo stay the native Edit items so text fields keep their own undo.
- Measured in the hidden app (#10): WebKit gives the page the keydown first; a cancelled key never reaches the menu, an uncancelled one (Cmd+K in a terminal) is handed on to the menu afterwards. A menu action therefore stands down when the page saw its keys in the last 500ms.
- The palette opens and closes without animation (it is opened by keyboard many times a day) and moving through its rows is instant. The help dialog keeps the standard 100ms fade and drops its scale under reduced motion.

## Icons

Phosphor only (`@phosphor-icons/react`), 16px default in buttons, regular weight.

## Not yet decided

- Theme toggle (not planned), custom accent from the system accent colour.
- Honouring the "double-click title bar to minimise" system setting; the header always zooms today.
