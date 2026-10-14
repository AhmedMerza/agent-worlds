# Recording the README media

Scripts that produced `docs/media/*` against the mock server in demo mode.

- `run.sh <demo> <script>` restarts the mock (`MOCK_DEMO=<demo>`), then runs one script. Use demo `1` for `hero` and `term`, `worlds` for `worlds`, and `""` (the full mock, with cards waiting) for `shots`.
- `rec.cjs` shared helpers (browser, video capture, ffmpeg to GIF). Output goes to `docs/media` (override with `MEDIA_OUT`).
- `hero.cjs`, `term.cjs`, `worlds.cjs` record the GIFs; `shots.cjs` takes the still screenshots.

Needs `npm run build` first, Playwright (set `PLAYWRIGHT_PATH` if `require('playwright')` does not resolve), and ImageMagick (`convert`) for the GIFs. Set `MOCK_URL` if the mock is not on `http://127.0.0.1:4322`.
