# Illustrated worlds validation

The active change covers room artwork, live agent labels, selection, office pagination, the searchable session list, and connecting walkways. Terminal, Needs you, details, and chat layout rules stay at their original values. `full-height-layout.css` is an unused prototype, not imported by the application.

## Reproduce the load fixture

Build from the repository root with `npm run build`, then:

```sh
cd web
MOCK_SESSIONS=25 MOCK_SINGLE_WORLD=1 MOCK_NOTICK=1 node mock/server.mjs
```

Open `http://127.0.0.1:4322`. Omit `MOCK_SINGLE_WORLD` to spread sessions across Web, Mobile, and Tools. Use `MOCK_SESSIONS=50` for the larger fixture. These are synthetic sessions; no actual agent processes run.

## Checks performed

- Clicked all 25 named agents across their office pages: every click selected the correct session terminal. Previously, 24 of 25 label clicks selected another agent.
- Opened all sessions using search in fixtures with 25 and 50 sessions spread across three worlds.
- Verified empty search results and navigation between World and Chats.
- Verified touch search and selection at 390×844, removal of sessions while viewing the final page, an empty world, and loading with reduced motion enabled.
- Measured unchanged canvas image draws over two seconds: 988 before, zero after. This is a rendering-work measurement, not a claim about running 25 CLI processes or every browser's frame rate.
- Checked page overflow at 390, 768, 1280, 1920, and 2560 pixels: zero. Desktop terminal placement follows the original breakpoints.
- Unit regression for label selection failed with the original overlapping hit targets, then passed after the fix.
- Pagination regression covers all 25 and 50 sessions exactly once. Deliberately dropping the last item of each page made it fail; restoration passed.

Rooms show four agents at a time, with Previous/Next controls and a searchable Sessions list. Selecting a session from another surface moves its room to the corresponding page. Artwork is redrawn on relevant data, hover, selection, asset-load or size changes; unchanged illustrations do not repaint continuously.

Verification uses local Chromium and mock data. Real agent concurrency, native prompts in real CLI processes, Safari, and Firefox were not load-tested by this change. The terminal/inbox protocol code was not modified.

The final frontend checks are `npm --prefix web test` (156 passing tests) and `npm run build` (typecheck and production build). This repository has no frontend ESLint setup; TypeScript and the targeted runtime checks were used. The pre-existing Vite large-bundle warning remains.

## Blind walkthrough

Three fresh personas used isolated copies of the mock build. Sami located session-25 and session-02 through exact search; Noor selected a waiting Mobile session and returned to All worlds; Lee inspected a session through the adjacent Chats flow. All reached their scoped inspection goals with friction. No permissions were answered and no session was changed.

Remaining observations: the overview's names are small; the existing global Needs you queue does not follow world filtering or session selection; and the existing session-open action focuses the terminal. Those surrounding behaviors are unchanged, in line with the requested scope. The fixed mock conversation history can contradict synthetic error states and is not evidence of a production status regression. Remote phone access was not enabled or tested.

The saved report is `.claude/persona-walkthrough/2026-10-26-world-load/report.md` (local run history). The browser driver downsizes desktop screenshots; direct browser dimensions and interaction tests complement those observations. Lee's screenshots after step 008 were excluded from the blind findings because the orchestrator started a viewport sweep before Lee finished. A fresh responsive sweep was then run separately.
