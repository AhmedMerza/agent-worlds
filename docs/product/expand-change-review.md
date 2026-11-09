# Expand: per-session change review (2026-11-09)

Ask: "no way to see the changes each session is doing… like VS Code's Source Control tab."

## What Agent Worlds already has
- `server/src/review.ts:54` `reviewOf()` — files (+/−), commits, uncommitted, untracked, one diff capped at 200 KB, vs `baseSha`.
- Refreshed on every `Stop` hook (`server/src/insights.ts:87`), shown only on **done** cards (`web/src/components/ReviewBlock.vue`): flat file list + one collapsed diff, no per-file view.

## Parity matrix
✅ have · 🟡 partial · ❌ missing

| Capability | Conductor | Vibe Kanban | Superset | Claude Squad | Codex app | Cursor | Claude Code desktop | **Us** |
|---|---|---|---|---|---|---|---|---|
| Live diff while working | ✅ | 🟡 stale (#2561) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ done only |
| Changed-file list, click → that file's diff | ✅ | ✅ tree+search | ✅ | ❌ | ✅ | ✅ | ✅ | 🟡 list, no click |
| Side-by-side toggle | ❌ | ✅ (not remembered) | ? | ❌ | ? | ? | ? | ❌ |
| Scope: uncommitted / branch / commit / last turn | 🟡 commit+turn | ❌ branch only | ? | ❌ | ✅ all five | 🟡 | 🟡 | 🟡 branch+uncommitted |
| Per-turn diff | ✅ 0.22 | ❌ (#2086) | ? | ❌ | ✅ | 🟡 checkpoints | 🟡 /rewind | ❌ |
| Mark file viewed (resets on change) | ✅ 0.29.1 | ❌ | ? | ❌ | 🟡 PR plugin | ❌ | ❌ | ❌ |
| Line comments sent to the agent | ✅ | ✅ batched | ✅ | ❌ | ✅ | ❌ | ✅ batched | ❌ |
| Revert file/hunk | ❌ | ❌ (#2106) | ? | ❌ | ✅ | 🟡 | 🟡 | ❌ |
| Open in editor | ? | ? | ✅ | ❌ | ✅ | n/a | ? | ❌ |
| Cross-session overlap warning | ❌ | ❌ | ❌ (says so) | ❌ | ❌ | ❌ | ❌ | ❌ |

Parity gaps (≥2 have, we lack): live diff, click-to-file diff, per-turn diff, line comments → agent.

## Top complaints (evidence)
1. Re-reading already-reviewed changes — VK #2086, claude-code #105603, Conductor shipped turn diffs + viewed.
2. Stale diffs needing reload — VK #2561, Crystal #97.
3. Big diffs freeze — Claude Squad #64/#280, Conductor 0.84.0 fix. (We already cap at 200 KB, but that truncates.)
4. Side-by-side not remembered — VK #2300, #1605.
5. Review comments lost on close — VK #1437.

## Tests run here
- **Overlap (HELD):** live `agent-worlds` worktrees 2026-11-09 — 6 branches with changes, 11 files touched by ≥2 branches, `TerminalPanel.vue` by 3. No competitor has this.
- **Per-turn feasibility (HELD):** `Stop` already fires for Claude/Codex/Gemini and already calls `updateReview`; a turn snapshot is a tree written from a temp index (`GIT_INDEX_FILE=… git add -A; git write-tree`) — no stash stack, no worktree change.

## Sources
conductor.build/docs/reference/diff-viewer · conductor.build/changelog/0.22.0… · …/0.29.1… · …/0.84.0… ·
github.com/BloopAI/vibe-kanban docs/workspaces/changes.mdx, docs/reviewing-code.mdx, issues 2086 2561 2300 1605 1437 2106 1141 ·
github.com/smtg-ai/claude-squad issues 27 64 170 280 · github.com/stravu/crystal issues 96 97 100 108 65 ·
github.com/superset-sh/superset · learn.chatgpt.com/docs/code-review?surface=app · openai/codex issues 16415 35156 15367 30919 ·
cursor.com/docs/agent/review · code.claude.com/docs/en/desktop · code.claude.com/docs/en/checkpointing · anthropics/claude-code#105603
