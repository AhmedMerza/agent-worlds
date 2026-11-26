# Expand: Agent Worlds — next milestone (2026-11-26)

Full-mode run, called from `/scout`. Refresh at the next milestone or after ~60 days.
Earlier, narrower run: [expand-change-review.md](expand-change-review.md).

## Frame
- **Have today:** rooms/zones, Needs you inbox (native prompt kept), 6 CLIs in real tmux terminals,
  agent-to-agent mail (MCP), runs, leads that spawn workers, Changes view, Resume, phone via LAN/public
  link + QR + PWA, in-tab notifications + sound, voice capture → issues, worktree per session.
- **Persona:** solo/small-team dev, 5–15 sessions across repos, all day and overnight, phone when away.
- **Moments:** morning catch-up · dispatch · attention juggling · answering from the phone · review & merge ·
  end of day · after a restart · hitting a usage limit.
- **Own pain history (closed + open issues):** survival across restarts (#58 #61 #62 #82 #91), cleanup
  (#51 #120), per-agent prompt parity (#49 #54 #90).

## Market state (verified unless noted)
- Vibe Kanban shut down 2026-04 (community maintenance). Crystal deprecated 2026-02 → Nimbalyst (live, weekly).
- Conductor: Meta acquisition announced 2026-11-04, then "not shutting down" 2026-11-13. Mac-only.
- Happy → teams/desktop; Omnara → cloud sandboxes. Claude Squad slowing (last release 2026-08).
- Live rivals: Nimbalyst, Paradev (ex-Superset), agent-deck, Conductor, Claude Code Desktop/Remote Control.

## Parity matrix
✅ have · 🟡 partial · ❌ missing · ? unknown

| Capability | Conductor | Paradev | Nimbalyst | agent-deck | Claude Desktop/RC | Happy | **Us** |
|---|---|---|---|---|---|---|---|
| Cross-agent "needs you" inbox | 🟡 icons | 🟡 badge | 🟡 iOS list | ✅ conductor | ❌ finish-only | 🟡 | ✅ |
| Push to phone with no tab open | ✅ iOS | ✅ apps | ✅ iOS | ✅ Telegram/Slack | ✅ RC | ✅ | ❌ |
| Worktree setup script / .env copy | ✅ | ? | ? | ? | ✅ .worktreeinclude | n/a | ❌ |
| Worktree archive / cleanup | ✅ archive | ? | 🟡 | ✅ archive | ✅ auto, 30 d | n/a | ❌ |
| Usage / limit view | ✅ 5h/7d | ? | ✅ popover | ✅ budgets | 🟡 plan ring | ❌ | ❌ |
| Auto-resume after limit reset | ✅ 0.99 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PR + CI status, merge in app | ✅ Checks | ✅ | 🟡 | ❌ | ✅ auto-fix | ❌ | ❌ |
| Diff line comments → agent | ✅ | ✅ | 🟡 | ❌ | ✅ | ❌ | ❌ |
| Agents orchestrate other agents | ✅ | ✅ MCP/SDK | ✅ inbox | ✅ | 🟡 Claude-only | ❌ | ✅ |
| Linux / browser / no login / no relay | ❌ Mac | 🟡 no Win | ✅ | ✅ | 🟡 claude.ai login | ❌ relay | ✅ |
| Native CLI terminal kept | ❌ own chat | ✅ | ? | ✅ | ✅ | 🟡 | ✅ |

**Parity gaps (≥2 have, we lack):** phone push, worktree setup, worktree cleanup, usage view, PR/CI + merge,
line comments → agent.

## Tests run here
- **Worktree cleanup — HELD.** 499 worktrees under `/srv/dev/projects/*-worktrees`, ~180 GB
  (oreem 64 GB, flutter-pos 61 GB), disk 82% full. Nothing removes worktrees (`server/src/sys.ts:150` is `add`
  only). 102/499 dirty → "never touch dirty" is mandatory. Squash merges defeat `--is-ancestor`; needs PR state.
- **Worktree setup — HELD.** 118 of 213 worktrees whose main repo has a `.env` lack it (55%).
- **Phone push — real, cost L.** Only in-page `new Notification` (`web/src/notify.ts:41`); no service
  worker, Web Push, VAPID or actions. Allow/Deny on lock screen = second answer path; terminal prompt stays.
- **Usage limits — WEAK standalone, HELD as a grouped pause.** 4 hit-days in 60 days, all Claude weekly
  limit ("resets 8am"), 8–11 sessions stalled each time (incl. 2026-11-25/26). Codex: 0 real hits but
  `rate_limits` is in every rollout. Claude: only the post-hit message carries a reset time.

## Ideas, ranked
| # | Idea | Who · moment · gain | Lens | Evidence | Test | Cost | Tag |
|---|---|---|---|---|---|---|---|
| 1 | Safe worktree cleanup: list by size, merged/clean/dirty; remove merged+clean, never dirty | dev · end of day · ~180 GB back, no lost work | control | #120, VK #765 (19), Claude Desktop discards dirty | HELD | M | parity |
| 2 | Worktree setup per repo: copy listed untracked files (.env), run a setup command | dev · dispatch · worktree runs first time | friction | Squad #260, Conductor HN | HELD | S | parity |
| 3 | Limit pause: one grouped card "N sessions paused, resume 8am" + auto-continue at reset | dev · overnight/limit · no 11-card flood, queue finishes | pain | Claude #16157 (697), Codex #21073 (94) | HELD (grouped) | S | v1 |
| 4 | Web Push to phone, real question text, Allow/Deny actions where the agent allows two paths | dev · away from desk · answer in one tap | pain | Happy #1908; all 6 rivals push | real | L | v1 |
| 5 | Diff line comments sent to the agent | dev · review · precise feedback | parity | 4 rivals | untested | M | v1 |
| 6 | PR + CI status on done cards, merge, then offer worktree cleanup | dev · review & merge · day's work lands from the app | level-changer | Conductor Checks, Paradev, Claude Desktop | untested | M | next |
| 7 | Morning digest: per session overnight one-liner, ordered by "needs a decision" | dev · morning · 2 min orientation | didn't know | none have it | untested | S–M | next |
| 8 | Status evidence on hover + "this is wrong" sample | dev · any · trust in states | little touch | agent-deck #3264/#3266 | untested | S | next |
| 9 | Run templates per world | dev · dispatch · repeatable flows | didn't know | Conductor loadouts | untested | S | later |
| 10 | Compare fan-out: same task, two agents, keep the better diff | dev · risky task · pick best | level-changer | none | untested | M | later |

## Approved (2026-11-26): ideas 1–8 + restart-survival bugs (#61 #62 #82 #91 #92)

### Decisions (scout)
- **Push origin:** Web Push on whatever https origin is in use; re-subscribe when it changes. Plain-HTTP Wi-Fi
  gets no push. The phone dialog and push card must say that a quick-tunnel restart stops push until the new
  link is opened — never fail silently.
- **Cleanup:** automatic. Remove only when the forge (`glab` / `gh`) says the MR/PR merged AND its head SHA
  equals the worktree HEAD, the worktree is clean, nothing is unpushed, no live session, ≥3 days since merge.
  Any failed check or unreachable forge → keep.
- **Setup:** zero-config. Copy the main checkout's `.env*`; run `composer install` (composer.lock) /
  `flutter pub get` (pubspec.yaml); per-repo override in world settings; `.worktreeinclude` wins if present
  (none of the 32 repos has one today). Setup runs visibly before the agent; failure shows on the card.
- **Limit pause:** one grouped card; auto-resume on by default at the parsed reset time, cancellable,
  per-session untick, staggered, typed into the native terminal.
- **Line comments:** drafts batched; "Send N comments" types one prompt (file:line, quoted line, note) into
  the terminal, held until the turn ends if busy.
- **Morning digest:** built from existing per-turn data (no extra model call), delivered via push + a page.

### Order
1. Worktree lifecycle: #2 setup → forge client → #1 auto-cleanup
2. Overnight survival: restart bugs → #3 limit pause → #8 status evidence
3. Away from the desk: #4 Web Push → #7 morning digest
4. Review → merge: #5 line comments → #6 PR/CI + merge (reuses forge client, triggers cleanup)

## Cut
- Per-session $ spend meter — subscriptions, not API billing; limits are weekly-plan-wide; 4 hits/60 d.
- Concurrency cap/queue per world — limits hit ~2×/month; grouped pause (#3) covers it.
- Cloud workspaces / hosted relay — against local-first, our main edge (Paradev #2685, Happy relay outages).
- Remote SSH host — we already are a server you reach from any browser.
- Slack/Linear triggers — no evidence the user works from those.
- Auto-answering waiting workers (agent-deck conductor style) — conflicts with "keep agent chats native".

## Sources
conductor.build/changelog (0.90–0.101, 0.93.0, 0.94.2), conductor.build/docs/reference/checks,
news.ycombinator.com/item?id=50369503, …?id=44594584 · github.com/paradevai/paradev issues 1513 405 2364 2685 2861 ·
github.com/asheshgoplani/agent-deck docs/guide/conductor.md, issues 3135 3164 3220 3264 3266 3270 ·
github.com/smtg-ai/claude-squad issues 56 260 266 312 · github.com/BloopAI/vibe-kanban README, issues 765 1697 1946 2687 2952,
vibekanban.com/blog/shutdown · github.com/Nimbalyst/nimbalyst releases v0.83–0.84.4, issues 49 95 416 ·
github.com/stravu/crystal issues 18 89 · github.com/slopus/happy issues 265 302 661 1908 246 ·
code.claude.com/docs/en/desktop, /claude-code-on-the-web, /remote-control ·
github.com/anthropics/claude-code issues 16157 38335 30154 · github.com/openai/codex issues 28969 3962 21073 ·
cursor.com/docs/cloud-agent
