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
- `pnpm gate` runs the whole gate through `turbo run`: Biome check, `tsc --noEmit`, Vitest, `cargo clippy -- -D warnings`, `cargo test`. It must be green before a task is done. Quote its `Tasks:` summary line.
- Add scripts to the package that owns them and register them in `turbo.json`; root scripts only call `turbo run`.

## Tasks and skills

Tasks live on the KDD board (`kdd show <id>`). Each task lists the skills it needs under "Скиллы"; load every one of them with the Skill tool before writing code. Each task ends with its acceptance check: the `pnpm gate` summary and screenshots from the running app.

## Commits

- Commits are allowed only on task branches inside a worktree.
- One conventional line with the task id, for example `feat(desktop): add sidebar (#4)`. No body, no trailers.
- Only the owner merges into main. Push only on the owner's word.
