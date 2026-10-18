# Changelog

Newest first. Dates are commit dates.

## 2026-10-18
- Runs: New session can carry one task through steps on different agents (Plan → Review plan → Build → Review code by default, editable), each a session in the same folder. A step ends when its agent calls the new `aw_handoff` MCP tool; Agent Worlds writes a handoff and starts the next step. A step marked Check, or one whose turn ends without a handoff, holds the run under Needs you (Start next / Stop run). A step's panel shows the whole run. Step files go in `.aw/run-<id>/`, added to `.git/info/exclude`. Runs survive a server restart (`<home>/runs.json`) (`POST /api/runs`, `/api/runs/:id/next`, `/api/runs/:id/stop`).
- Text sent to a session (the reply box, the mail notice) now presses Enter a moment after typing it. Codex took an Enter right behind the text as part of a paste and left the message sitting in its input box.
- Sessions message each other, across agents: every session Agent Worlds starts gets the MCP tools `aw_agents`, `aw_send` and `aw_inbox` (through `bin/aw-mcp`, a stdio bridge to `/mcp` that names the pane it runs in). When a session that has mail is free, a one-line notice is typed into its terminal telling it to call `aw_inbox`; a session mid-turn is told when its turn ends. Messages show in both sessions' recent steps. Two sessions get 12 messages without a prompt from you, then are told to ask you.

## 2026-10-15
- "Continue in ▾" (a session's panel, or next to Dismiss on an error card) starts another installed agent in the same folder and branch, so the file changes carry over. It first writes a handoff to `<home>/handoffs/<session id>.md` — task, recent steps, working-tree state, plus Claude's conversation excerpt or a pointer to the other agent's transcript — and the new agent's first message is to read it and carry on. The old session stays untouched (`POST /api/sessions/:id/continue`).
- New sessions can run Kimi Code (`kimi`, 2.1+). It reports through the same hook, from a Kimi home of its own (`<home>/kimi-home`: links to `~/.kimi-code` plus a copy of its config.toml with the hooks), so your Kimi config is never edited. A starting task reaches Kimi as a one-shot `kimi -p` run that `kimi -c` then continues interactively (its TUI drops keys typed before it draws). Kimi doesn't wait on its permission hook, so its cards are answered in the terminal. Esc in Kimi (`Interrupt`) puts the session back at its prompt.

## 2026-10-14
- New sessions can run Codex or Qwen Code instead of Claude Code: an Agent choice in New session, with "Make default" (`defaultAgent` in config.json, Claude when unset or not installed). They report through the same hook (`aw-hook <agent>`), so rooms, the inbox and Allow/Deny work; always-allow rules, permission modes, catch-ups, resume and the terminal Restart stay Claude-only. `GET /api/agents`, `POST /api/agents/default`.
- Terminal: **Restart** quits the session's Claude and resumes the same conversation in a fresh one, in the same tmux pane, which redraws a wrecked screen for good. It keeps the session's permission mode, settings and model, and asks first when Claude is mid-turn (`POST /api/sessions/:id/restart`).
- Terminal text gets wrecked less: the terminal refits once its font has loaded, never squeezes the session to 0 columns while hidden, and starts clean after a reconnect.
- A session whose turn ends with only long-running background tasks (a dev server, an artifact watcher) goes to the Help desk instead of sitting at its desk with a clock: only background work started since your last prompt (a background helper or command, a monitor) means Claude is coming back. This also holds across a server restart.
- Room text stays readable on a phone: name tags and desk labels never shrink below about 10 px. Each chip under a room shows the branch. The overlap `!` sits left of the head, clear of the bubble and timer. README describes the illustrated rooms.
- A helper backgrounded mid-run (Ctrl+B) no longer sends its session to the lounge: it counts as running until it finishes, and neither Claude's idle notice nor the Esc check ends the turn meanwhile.

## 2026-10-13
- Move one session to another world ("Move to another world…" in its panel, or drag its character onto another room with a mouse): its repo and the repo's other sessions stay put; the move survives /clear and restarts (`<home>/placements.json`).
- Rooms are drawn as smooth illustrations instead of pixel art: faces show state (smiling at work, asleep when idle, slumped after a long wait, frowning on error), laptops light faces, the help bell glows while someone waits. Name tags show the branch under the project; the hovered or selected one shows both in full. Busy rooms grow taller (up to 300) so tags have room.
- A crowded zone widens and a quiet one gives way, so three people at the help desk keep their branch names readable. Headings use the same smooth face as the rest of the app (the pixel font is gone). A world created without a colour now gets one of the swatches the world panel offers.
- `/clear` (or a skill that clears) keeps the same terminal selected: the page follows that terminal's new session instead of jumping to another one.
- Recent sessions are grouped by folder (fold a folder shut); "Past sessions here" in a session's panel shows only its repo: its folder, the folders inside it and its worktrees (`GET /api/history?repo=`).
- New session: "Another folder…" is always there, not only for an empty world; the folder browser opens next to the chosen folder and can search the folders it lists.
- Busy but not needing you: a turn that ends with background work running, or a scheduled wake-up, stays at the desks with a clock; compacting shows "…" at the desks. New hooks: `PreCompact`, `PostCompact` (re-merge a global hooks block).
- A session that asked you something stays at the Help desk while its background helpers keep working.
- A session taken back after a server restart in the middle of a long command goes to the desks, not the lounge.
- Phone terminal: scroll back through the conversation; the PC takes its size back when you return to it.
- Sessions are re-adopted after a server restart.
- Phone dialog shows a firewall hint until a phone gets through; the QR code has its own section.
- Public link (opt-in, password-protected), one-click cloudflared install, access log.
- Each session shows what it is doing; reviews follow the worktree a session worked in; one room column on wide screens.
- Connect a phone over Tailscale or LAN with a one-time QR login; stop and resume sessions; world management is easier to find.
- No "Everywhere" scope for shell rules; transcript paths are confined; terminal and socket cleanup.

## 2026-10-12
- Fixed app shell at 1000px and wider: the page never scrolls, each region scrolls on its own.
- Review shows changes since the session started; asking cards for questions; ghost chip; permission mode picker; header split into waiting and review; folder picker shows which world owns a repo; plainer wording.
- Import UI: ghosts for unmanaged Claude sessions, recent sessions, resume.
- Starting state, clearer permission wording, catch-up fallback, Ctrl+] shortcut.
- One-year login cookie, `agent-worlds open` command, friendlier bad-token page.
- GUI-started sessions appear at once; permission cards say what they target; Host header check; clear error when the port is busy.
- Import existing Claude sessions: history, running-process scan, resume, attach. History shows the newest typed prompt.
- README rewrite with screenshots and a demo mode; media recording scripts.
- Room zones with walking sprites, ultrawide layout, crisp canvas scale; rooms fill their card.
- Sessions started from the GUI use our hooks; the task is optional; duplicate hooks removed.
- Manage worlds from the GUI: create, rename, recolour, reorder, delete, folder browser, put a repo in a world.
- Context window defaults to 1M, configurable with `contextLimit`.
- Catch-up summaries (manual button, `C` shortcut), context meter, review, permission scopes, conflict warnings, new sessions from the GUI.
- PWA manifest and icons, notifications, phone tabs.
- Web UI: Vue app, canvas rooms, inbox, terminal panel.
- Server, hook script and CLI.
