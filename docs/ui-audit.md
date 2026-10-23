# UI audit

Task #11, 2026-10-23. The whole desktop UI: project list and empty state, board (toolbar, zoom, cards, notes, diagrams, links), agent nodes and their terminals, the inspector with its Tokens row, the command palette, the shortcut help, dialogs, context menus and message signals.

Method: every file under `apps/desktop/src` and `packages/ui/src` read against the Vercel Web Interface Guidelines, Impeccable's audit and critique, Emil Kowalski's and Apple's motion rules and `docs/DESIGN.md`; the Impeccable detector (no findings); screenshots from `pnpm test:e2e` in both themes; and two new specs that measure instead of eyeballing:

- `e2e/a11y.spec.ts` (Playwright WebKit, light and dark): Tab walks over the empty state, the board and a dialog, asserting each stop's accessible name and that it looks different from its unfocused self; every icon-only button has an `aria-label`; every visible text meets WCAG AA (4.5:1, 3:1 for large text) against the colours really behind it, composited from computed styles; keyboard editing of notes, diagrams and links; dialog motion with and without reduced motion.
- `e2e/app/motion.ts` (the hidden real app, system WKWebView): `getAnimations()` on each changed motion, its first-frame scale, duration and curve, the dialog's removal timed against its exit, screenshots held mid-animation. Run against the code before this task it fails all four tests (dialog 100ms `ease`, note and editor from 0.97, button 150ms default curve).

The sidebar sits on native vibrancy, which a headless page cannot draw; the contrast check composites sidebar text over a neutral stand-in for the material (rgb 232 light, rgb 48 dark).

Severity: High blocks a keyboard or low-vision user or breaks a stated rule; Medium is a visible defect or a token drift; Low is polish.

## Findings

| Area | Finding | Severity | Status | Reason |
|---|---|---|---|---|
| Keyboard | Project rows and note colour swatches were plain `<button>`s without `tabindex`. WebKit, so the app's WKWebView too, leaves those out of the Tab order: projects could not be reached from the keyboard at all. | High | Fixed | `tabIndex={0}`, as Base UI's buttons already have. A link's label stays out of the order on purpose: the link itself is the stop, and Enter there edits the label. |
| Keyboard | Every agent's read-only overview terminal was a Tab stop (xterm's hidden input) with no visible focus: 11 dead stops on a team of 12. | High | Fixed | The input leaves the Tab order outside focus mode and comes back in it. |
| Keyboard | Notes, diagrams and link labels could be edited only with a double-click. | High | Fixed | Enter on the focused item opens its editor; Escape commits and returns the keyboard to the item. |
| Focus | Board nodes showed no focus at all: React Flow styles focus only for its built-in node types. | High | Fixed | 2px `--ring` outline, 2px out. |
| Focus | A focused link looked exactly like a selected one. | Low | Fixed | The focused link's line thickens to 3px. |
| Focus | Note colour swatches and link labels had only the faint browser default outline; the palette field had none. | Medium | Fixed | Same ring as the rest of the app. |
| Focus | The sidebar button came last in the Tab order although it is first on screen. | Medium | Fixed | Rendered first in the shell. |
| VoiceOver | Board nodes had no name ("group"); links were read as "Edge from 3f2a…-… to 9c1d…-…". | Medium | Fixed | Agents are "name, role", then "Note", "Diagram", "Link: its label" (updated on edit), "Team line". |
| VoiceOver | The zoom percentage button was named "Zoom to 100%" while showing "58%" (WCAG 2.5.3, label in name); icon zoom buttons had no tooltip. | Low | Fixed | Named "58%, zoom to 100%"; every zoom button has a `title` with its shortcut. |
| Contrast | Dark theme primary button ("Add project", "Add anyway"): white on the bright accent, 3.06:1. | High | Fixed | Filled surfaces use the light accent in both themes (4.76:1); the focus ring keeps the bright one. |
| Contrast | Sidebar secondary labels ("Projects", "No projects yet") at 50%: 3.81:1 over the light material. | Medium | Fixed | 60%: 5.39:1 light, 5.83:1 dark. |
| Contrast | "Remove" in the remove-project dialog, destructive text on its tint: 3.92:1 light, 4.02:1 dark. | Medium | Fixed | `--destructive` darker in light, lighter in dark: over 5:1 on its tint. |
| Contrast | Keys in the shortcut help, dark: 4.16:1. | Medium | Fixed | Foreground text on the dark key cap. |
| Contrast | "Double-click to write" on a dark yellow note: 4.07:1. | Medium | Fixed | Foreground at 70% instead of muted. |
| Contrast | React Flow attribution, `#999` on white: 2.85:1. | Low | Fixed | Muted foreground. |
| Motion | Under reduced motion every dialog, alert dialog and context menu still scaled and slid: tw-animate ignores the setting, and only the help dialog opted out. | High | Fixed | One unlayered rule resets tw-animate's scale and translate under reduced motion; popups fade only. |
| Motion | Dialogs, alert dialogs and menus ran 100ms on the browser's `ease`, outside the token scale. | Medium | Fixed | `--duration-fast` (120ms) and `--ease-out`. |
| Motion | Buttons used `transition-all` on Tailwind's default 150ms curve. | Medium | Fixed | Named properties only, `--duration-fast`, `--ease-out`. |
| Motion | A new note and the diagram editor grew from `scale(0.97)`: invisible at board zoom. | Medium | Fixed | From `scale(0.9)`, the visible value the owner set for board motion. |
| Copy | "Rendering" had no ellipsis while the diagram loads. | Low | Fixed | "Rendering…". |
| Copy | "Could not load the board" gave no next step. | Low | Fixed | "Could not load the board. Restart CEO to try again." |
| Keyboard | On the board, Tab reaches links before nodes. | Low | Kept | React Flow draws the edge layer before the node layer; reordering means patching its renderer. Every item is reachable and named. |
| Keyboard | No keyboard way to draw a link between two nodes. | Medium | Kept | React Flow has no keyboard connection; building one is a new feature, which this task excludes. |
| Keyboard | The agent node's context menu opens only with a right click. | Low | Kept | Its one action, focus the terminal, is a labelled button in the node header. |
| Layout | The diagram editor opens to the right of the node and is cut by the window edge when the node sits near it. | Low | Kept | Needs collision-aware placement of React Flow's NodeToolbar; risk to #9's editor, out of scope. |
| Layout | The inspector covers the top-right corner of the board and has no close button. | Low | Kept | Esc or a click on the board deselects the agent and closes it; pinned by design in #7. |
| Dialog | The shortcut help has no close button. | Low | Kept | Esc and a click outside close it, like the palette it sits beside. |
| Copy | Buttons and menu items use sentence case ("Add project"), macOS uses title case. | Low | Kept | Consistent across the app, the menu bar and the specs; changing the house style is the owner's call. |
| Contrast | Mermaid's own text colours and terminal output are outside the contrast check. | Low | Kept | Mermaid's theme (#9) and the program's colours; the terminal's base foreground and background are 15:1 and up. |
| Performance | 300 nodes render without virtualisation (`onlyRenderVisibleElements` off). | Low | Kept | Measured pan of 300 nodes: 58 to 60 fps in Playwright WebKit, 43 fps in the off-screen hidden window on a loaded machine (comment on task #11). Virtualising would remount nodes and their terminals while panning; revisit if boards outgrow that. |
| Motion | Board, sidebar, focus-mode, signal and spawn motion (#2, #15, #18, #19). | n/a | Kept | Each has a reason, runs on the tokens, is interruptible where it can be, and drops movement under reduced motion; already proven in the hidden app by their own tasks. |

## Not checkable here

- `:focus-visible` in the hidden real app: its window is never active, so WebKit does not mark keyboard focus there. Focus rings are proven in Playwright WebKit (`e2e/a11y.spec.ts`); the real app's motion proof drives the button transition through a state change instead.
- Reduced motion in the real app: the system setting may not be changed by tests. Proven in Playwright with `reducedMotion: "reduce"`.
- VoiceOver itself was not run (it would take over the owner's screen); names are asserted through the accessibility tree.
- The native window shell (vibrancy, traffic lights) was not looked at visibly.
