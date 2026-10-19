# Agent Worlds

## Never touch the user's tmux server

Every session you run in lives inside the user's real tmux server. Inside tmux, `$TMUX` points at
that server and beats `TMUX_TMPDIR`, so `TMUX_TMPDIR=… tmux kill-server` kills the live server and
every session on it (this happened 2026-10-18: 17 sessions lost).

For test servers always clear `$TMUX` and use a named socket:

    TMUX= tmux -L aw-test-<name> new-session -d …
    TMUX= tmux -L aw-test-<name> kill-server

Never run a bare `tmux kill-server` / `kill-session` against the default socket.
