# Changelog

Newest first. Dates are commit dates.

## 2026-10-13
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
