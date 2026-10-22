# CEO - concept

Status: agreed direction, 2026-10-22. Not yet planned or implemented.

A desktop workspace where the owner talks to one long-lived CEO agent per project. The CEO turns tracker tasks into ordered waves, hands them to Lead sessions, and reports back. Every agent is a visible terminal session on a Miro-like canvas.

## Hierarchy

- **CEO** - one per project, long-lived, talks to the owner. Never does task work itself. Needs durable memory that survives `/clear` and compaction (see Open research).
- **Lead** - one per wave or task group. Receives tasks from the CEO, splits them inside its team, answers team questions, escalates to the CEO what it cannot answer, merges team work, reports back. Other Lead kinds (research, UI review) come later as profiles, not now.
- **Member** - executes one task. Talks only to its Lead and its teammates.

Allowed links: CEO <-> Lead, Lead <-> Lead, Member <-> own Lead, Member <-> own teammates. Members never reach the CEO or other Leads; this is enforced by which bus tools each session gets, not by prompt.

No functional roles (frontend/backend). A member is a clean session plus a brief plus a profile (model, effort, permissions, acceptance check). Models: Claude 5.5 family only, Haiku to Opus.

## Hard rules

- **No subagents, no Workflow.** Every agent is a visible `claude` process the owner can open, type into, interrupt or stop at any time. Enforced with `permissions.deny: ["Agent", "Workflow"]` in the settings the app passes to each session.
- **Two-level isolation.** Lead works in its own worktree and branch off the integration branch; each member works in its own worktree and branch off the Lead branch. Merges go up: member -> Lead -> CEO, with the project gate run at each level.
- **Nothing reaches main without the owner's yes**, in every mode.

## Waves

The CEO reads tasks from a tracker (KDD first, through its MCP), orders them by dependencies and forms waves. Tasks that touch the same files never share a wave. The wave plan is a canvas note the owner can edit before launch.

Modes are one mechanism with three knobs: who starts a wave, where results merge, what limits apply.

| Mode | Starts a wave | Merges into | Limit |
|---|---|---|---|
| Autonomous | CEO | owner-chosen integration branch | none |
| Collaborative | owner approves; one task or a few at a time; side tasks allowed | after owner OK | none |
| Night | CEO | nothing; produces a report note | deadline time + usage budget |

Night mode estimates from recorded history (duration and usage per task and wave), not guesses. With no history it runs one wave, then re-checks remaining time and budget before the next.

## Review

After a Lead merges its team's work: a fresh clean-session reviewer runs `/code-review`, then a separate fresh session fixes the findings. Passes go high -> medium -> low; stop early when a pass finds nothing. UI review and others come later, per project.

Every wave ends with a report note: what was done per task, which checks passed, what agents could not verify, how the owner checks it (ports, scenarios), and the diff. Merging is a button on that note.

## Canvas

- Free graph: CEO in the centre, Leads around it, members around their Lead. Edges show who talks to whom.
- Terminals open on click (all-open is too heavy for the webview). Unopened nodes show status and last output lines.
- **Notes are memory.** A note linked to an agent is loaded into that agent at session start. The CEO prepares a note before creating a Lead; the Lead prepares notes for its members; members do not create notes. A Lead's note is cleaned up when the Lead is removed. Notes have priority and a size budget; the CEO consolidates them.
- The CEO can draw on the board for the owner: mermaid, charts, tables.
- Multiple projects, each with its own canvas, notes and CEO (like Orca).

## Ports

The app assigns each worktree a port range through `PORT`, and detects listening ports in each session's process tree. Ports show on the node and in a Ports panel with open and stop. Servers stop when their worktree closes.

## Stack direction

- Tauri 2 (not Electron, to keep the Mac light), React Flow canvas, xterm.js terminals. Turborepo monorepo.
- Sessions live in tmux, so night work survives a UI crash or close; the app re-attaches.
- Bus: an MCP server the app runs. CEO: `create_lead`, `send`, `interrupt`, `stop`, `tasks.*`, notes. Lead: team spawn and control, `report`, `ask_ceo`. Member: `report`, `ask_lead`, `message_teammate`.
- Waking a busy session: Claude Code channels if stable, otherwise the app types into its terminal.
- Other terminal agents (Codex, OpenCode) later; the contract is the bus MCP, no adapter layer until a second agent exists.

## Open research

1. **CEO memory and token economy.** What the CEO keeps, where, what loads at start, how it survives `/clear` and compaction, how notes are consolidated, measured token cost. Sources: refs corpus (mem0, hindsight, supermemory, memoripy, TencentDB-Agent-Memory, letta-code, fast-jev-compaction, headroom, cloudflare-os compaction) plus Claude Code memory, `PreCompact`/`SessionStart` hooks, CLAUDE.md.
2. **CEO learning by prompt edits** (harness2 in refs): size cap, consolidation, every edit a revertible commit, owner approval or auto-apply with a log.
3. **Hypothesis to measure:** subagents and teammates use a 5-minute prompt cache versus 1 hour for interactive sessions on a subscription, which may explain past usage spikes.

## Prior art (refs)

orca (MIT), gastown (MIT), agent-orchestrator (Apache-2.0), harness2, vibe-kanban (worktree-manager), buzz (Tauri terminal runtime), Flowise/langflow (React Flow canvas). OpenAlice is AGPL: ideas only.
