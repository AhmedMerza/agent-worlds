# Agent Worlds

## Keep agent chats native

Changes to Agent Worlds must preserve each agent CLI's normal conversation in its terminal,
including its own permission prompts and questions. **Needs you** may mirror a request and offer
another way to answer it, but it must not suppress, replace, or delay the agent's native prompt.
If an agent cannot support both answer paths, keep its terminal prompt and show an informational
card that directs the user to the terminal. Do not use an approval bypass mode or a held hook that
leaves the terminal silent while **Needs you** waits for an answer.

Verify the affected agent's terminal and **Needs you** together. Do not assume Claude Code behavior
also applies to Codex or another CLI.

## Never touch the user's tmux server

Every session you run in lives inside the user's real tmux server. Inside tmux, `$TMUX` points at
that server and beats `TMUX_TMPDIR`, so `TMUX_TMPDIR=… tmux kill-server` kills the live server and
every session on it (this happened 2026-10-18: 17 sessions lost).

For test servers always clear `$TMUX` and use a named socket:

    TMUX= tmux -L aw-test-<name> new-session -d …
    TMUX= tmux -L aw-test-<name> kill-server

Never run a bare `tmux kill-server` / `kill-session` against the default socket.
