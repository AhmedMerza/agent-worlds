# Agent Worlds repository rules

## Keep agent chats native

Changes to Agent Worlds must preserve each agent CLI's normal conversation in its terminal,
including its own permission prompts and questions. **Needs you** may mirror a request and offer
another way to answer it, but it must not suppress, replace, or delay the agent's native prompt.
If an agent cannot support both answer paths, keep its terminal prompt and show an informational
card that directs the user to the terminal. Do not use an approval bypass mode or a held hook that
leaves the terminal silent while **Needs you** waits for an answer.

Verify the affected agent's terminal and **Needs you** together. Do not assume Claude Code behavior
also applies to Codex or another CLI.

Before changing tmux handling, read the safety rule in `CLAUDE.md`. Never run a bare `tmux kill-server` or `tmux kill-session` against the user's default server.
