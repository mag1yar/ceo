# Research: agent bus (2026-10-22)

All cited repos MIT or Apache-2.0, attribution: ideas and short attributed fragments only, clean-room.

## Bus
- gastown › internal/mail/router.go:1606-1700, internal/mail/mailbox.go:654-716 @ ef70b0b: durable store then separate notify; read distinct from delivery ack; router resolves group addresses.
- vibe-kanban › crates/mcp/src/task_server/mod.rs:49-77 @ d5cbb53 (rmcp, stdio): one MCP binary, tool router per mode, relays to local server over HTTP.
- agent-orchestrator › backend/internal/cli/mcp.go:17-22 @ a95139b: stdio shim relays to loopback daemon.
- (Orca's guide describes the same send/check/ack/ask contract; not in refs, so not a source.)

## Delivery
- gastown › internal/mail/router.go:33-35, 1655-1700; internal/nudge/queue.go:1-9, 92-141, 155-280, 370-410 @ ef70b0b: wait <=3s for idle (two polls, prompt visible, no "esc to interrupt"); idle -> type nudge; busy -> file queue (atomic rename .claimed, TTL, depth cap) injected by UserPromptSubmit hook. Typing into busy pane cancels tool calls.
- agent-orchestrator › backend/internal/adapters/runtime/tmux/tmux.go:918-969, commands.go:144-160 @ a95139b: send-keys -l in chunks, 300ms pause, separate Enter.
- Claude Code: channels are research preview, no ack, dev flag shows confirmation each launch. PostToolUse additionalContext reaches busy agent; Stop decision:block continues (cap 8); type:"http" hooks; asyncRewake unverified for idle wake; Notification idle_prompt ~60s, too slow.

## Spawn and status
- agent-orchestrator › tmux/commands.go:8-33, 60-95; tmux.go:1038-1095 @ a95139b: private socket -L, exact =id target, detach-on-destroy on, new-session -d -x 220 -y 50, respawn-pane -k, attach with -u -T RGB inside PTY.
- agent-orchestrator › backend/internal/adapters/agent/claudecode/hooks.go:24-59; activitydispatch/dispatch.go @ a95139b: hooks SessionStart/UserPromptSubmit/Pre/PostToolUse/PermissionRequest/Stop/StopFailure/Notification/SessionEnd -> working/blocked/idle; sticky blocked cleared by that tool finishing; watchdog.
- orca › src/main/agent-hooks/server.ts, src/shared/agent-hook-types.ts @ 66e50e22: loopback hook listener.
- Worktree pointers not opened: orca › src/main/git/worktree-add.ts; vibe-kanban › crates/worktree-manager/src/worktree_manager.rs; agent-orchestrator › backend/internal/adapters/workspace/gitworktree.

## Visualisation
Weak prior art: Flowise › packages/ui/src/views/agentflowsv2/AgentFlowNode.jsx:115-130, 279-305 @ 9291856 status badges; langflow › src/frontend/src/stores/flowStore.ts:1144-1157 @ 972d56c47d edge.animated. React Flow animating edges example (animateMotion), not in refs.

## Recommended slice
1. messages table (additive): id, from, to, thread, body, state sent|waiting|accepted, delivered_via, timestamps. accepted only by explicit bus_accept/bus_reply.
2. Loopback server in app; per-session stdio shim (app binary mcp-shim mode) with per-session token; tool set by role (CEO spawn_executor/send/interrupt/stop; executor report/ask). ask blocks with timeout, resumable.
3. Delivery: idle -> type short pointer into pane; busy -> PostToolUse http hook additionalContext, Stop hook block.
4. --settings inline: http hooks with session identity, permissions.deny Agent/Workflow, --session-id uuid for --resume.
5. Spawn: git worktree add -b ceo/<task>, tmux -L ceo new-session running claude; terminal.rs PTY runs tmux attach; reconcile list-sessions with SQLite on start.
Risks: bus dies with app (daemon later); typing collides with owner; workspace trust dialog in new worktree (permissions, owner call); ask longer than MCP tool timeout; interrupts skip Stop -> watchdog.
Measure: latency per state per path; lost messages across restart (0); idle false positives; hook gaps; tokens per injected message; tmux attach rendering in xterm.js; worktree create/remove time.
Unverified spikes: custom channel, asyncRewake idle, HTTP MCP reconnect, trust dialog.
