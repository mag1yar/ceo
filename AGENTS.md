# CEO

Desktop workspace for one long-lived CEO agent per project. Product concept: [docs/concept.md](docs/concept.md). Wave plan: [waves.md](waves.md).

## Stack

- pnpm workspaces + Turborepo.
- `apps/desktop`: Tauri 2 (Rust in `src-tauri`), Vite, React 19, TypeScript strict.
- `packages/ui`: shadcn components (monorepo mode, base-nova style on Base UI), Tailwind CSS v4. The app imports them as `@workspace/ui/components/*`.
- Icons: `@phosphor-icons/react` only. `iconLibrary` is `phosphor` in every `components.json`; `lucide-react` must not appear in any `package.json`. After every `shadcn add`, rewrite any lucide imports to Phosphor and recheck.
- Lint and format: Biome (one root `biome.json`). Tests: Vitest for TS, `cargo test` for Rust.

## Commands

- `pnpm install` once, then `pnpm dev` launches the app (`tauri dev`, Vite on port 1420).
- `pnpm gate` runs the whole gate through `turbo run`: Biome check, `tsc --noEmit`, Vitest, `cargo clippy -- -D warnings`, `cargo test`, `test:e2e`. It must be green before a task is done. Quote its `Tasks:` summary line.
- Once per machine: `pnpm --filter desktop exec playwright install webkit`.
- Add scripts to the package that owns them and register them in `turbo.json`; root scripts only call `turbo run`.

## Tasks and skills

Tasks live on the KDD board (`kdd show <id>`). Each task lists the skills it needs under "Скиллы"; load every one of them with the Skill tool before writing code. Each task ends with its acceptance check (next section).

## Testing without touching the owner's screen

The owner works on this Mac while agents test. Checks run invisibly, in three layers:

- **Rust commands:** `cargo test` (in the gate). Commands go through `tauri::test` IPC, see `src-tauri/src/store/ipc_tests.rs`.
- **Interface:** `pnpm test:e2e` (in the gate). Playwright, headless WebKit, against `vite --mode e2e`, where `src/e2e/mock-ipc.ts` replaces the Rust backend with an in-memory store. Projects `light` and `dark` set `colorScheme`. The port is per worktree (`E2E_PORT` overrides). Specs live in `apps/desktop/e2e/*.spec.ts`.
- **Real app, hidden:** `pnpm test:e2e:app` (not in the gate). A debug build with cargo feature `e2e` (`tauri-plugin-wdio-webdriver` on localhost, Accessory policy, no focus, borderless window at x -20000, in-memory WebKit storage, `app.ceo.desktop.e2e` identifier and a throwaway HOME per run) driven by `@wdio/tauri-service`. Specs live in `apps/desktop/e2e/app/`. Run it when a change touches Rust commands or IPC.

Acceptance for a UI task: quote the `Tasks:` line of `pnpm gate` and the summary of `pnpm test:e2e`, and attach its light and dark screenshots (`kdd attach`, files under `apps/desktop/test-results/`).

Forbidden while testing: posting CGEvents, osascript keystrokes or clicks, changing the system appearance (`AppleInterfaceStyle`), bringing any app window to the front, and launching `pnpm dev` to look at the UI (it opens a visible window). The native window shell (vibrancy, title bar, traffic lights) is checked visibly only when the owner asks.

## Commits

- Commits are allowed only on task branches inside a worktree.
- One conventional line with the task id, for example `feat(desktop): add sidebar (#4)`. No body, no trailers.
- Only the owner merges into main. Push only on the owner's word.
