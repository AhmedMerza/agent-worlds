#!/usr/bin/env bash
# usage: run.sh <MOCK_DEMO value or ""> <script.cjs>
# Restarts the mock so every recording starts from a fresh state, then runs one script.
# Needs: a built web/dist (npm run build), Playwright (set PLAYWRIGHT_PATH if it is not importable), ImageMagick.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$HERE/../.."
PID="${TMPDIR:-/tmp}/awrec-mock.pid"
[ -f "$PID" ] && kill "$(cat "$PID")" 2>/dev/null
sleep 0.5
cd "$WEB" && { MOCK_DEMO="$1" MOCK_NOTICK=1 node mock/server.mjs >"${TMPDIR:-/tmp}/awrec-mock.log" 2>&1 & echo $! > "$PID"; }
sleep 1
cd "$HERE" && node "$2"
