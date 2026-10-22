# Research: token economy (2026-10-22)

Hypothesis confirmed (docs + 2,094 local transcripts): interactive main sessions on subscription write 1h cache; subagents/teammates/workflows/compaction write 5m. Idle gap 5-60 min: main miss 4.8% (2,342 turns), subagent 79% (56). Gap >1h: main miss 98%. Fresh session first turn: median 45k prompt tokens (p90 72k), ~14k cache read, ~26k written. Median main session peaks 110k context (p90 327k). Scripts: /tmp/ceo-research-scripts/.
Docs (code.claude.com/docs/en/prompt-caching): promptCacheTtl / CLAUDE_CODE_PROMPT_CACHE_TTL, subagentPromptCacheTtl; over plan limits main drops to 5m; cache per directory (each worktree pays ~26k first write); idleCompaction; effort change keeps cache, model change does not.
Unverified: how cache reads/writes count against subscription limits.

## Memory
- gastown › docs/HOOKS.md:145-153, 237-243 @ ef70b0b (MIT): `gt prime` on SessionStart + PreCompact reloads state from external store; unread mail injected before prompt; cost on Stop.
- letta-code › src/agent/memory-filesystem.ts:29-33, 307-345; src/tools/impl/memory.ts:254-296; src/agent/subagents/context-budget.ts:12-24 @ e8073d4 (Apache-2.0): git repo of md files, system/ pinned, rest as path+description tree (20k chars cap), startup ~16k tokens.
- hindsight › hindsight-api-slim/hindsight_api/engine/consolidation/triage.py:1-12 @ 5331da2 (MIT): rule triage before LLM rewrite.
- Claude Code: SessionStart fires on startup/resume/clear/compact, 10k char cap per hook; PreCompact can block, not inject.

## Parallel sessions
- gastown › internal/config/cost_tier.go:62-99, 136-177, 225-236 @ ef70b0b (MIT): model/effort tiers per role; `--model sonnet` drops 1M unless `sonnet[1m]`.
- headroom › headroom/cache/prefix_tracker.py:51-60, 86-96, 1355-1380; headroom/cache/ttl_estimator.py:1-30 @ 2912b7b6 (Apache-2.0): label cache misses (expiry / prefix change / unknown), estimate real TTL.

## Compaction
- cloudflare-os › packages/workshop-backend/src/agent-compaction.ts:14-16, 44-65 @ b4f706a1 (Apache-2.0): trigger at budget share, keep 30% tail, handoff summary sections Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context.
- fast-jev-compaction (MIT, card only): drop stale tool results, keep text.

## Recommendation for engine slice
1. Per-project memory dir owned by the app: core.md (<=8k chars) + topic notes with one-line descriptions, git-committed.
2. Prime command on SessionStart (all triggers): core.md + note index + live app snapshot (board, waves, sessions), under 10k chars. Wave state lives in the app.
3. App owns CEO reset: /clear at wave boundary, prime reloads; idleCompaction false for CEO; auto-compaction as backstop with cloudflare-os handoff format.
4. Profiles: CEO Opus medium; Lead Sonnet high; Member Sonnet default, Haiku mechanical, Opus review. Briefs reference files.
Measure: Stop hook records per session/role/task: cache writes 1h vs 5m, reads, output; first-turn prefix; idle-gap miss rate; compactions; CEO context at wave boundary; primed size.
Later: hindsight consolidation, letta description tree, harness2 prompt learning.
