# Agent Worlds

A local web GUI for running and watching many Claude Code sessions at once. Sessions are
grouped into **worlds** (a world is a named group of git repos). Each session is the real
`claude` CLI running in its own tmux session; Claude Code hooks report what it is doing,
and the browser shows every session, a "needs you" inbox (permission requests, questions,
finished turns) and a live terminal attached to the session's tmux.

## Requirements

- Node.js 24 or newer (the server is TypeScript run directly by Node; there is no build step)
- tmux, git, curl
- Claude Code (`claude` on your PATH)
- A C/C++ toolchain for `node-pty` if no prebuilt binary matches your platform

## Install

```sh
cd server && npm install
cd ../web && npm install && npm run build
```

Optionally put `bin/agent-worlds` on your PATH, e.g. `ln -s "$PWD/bin/agent-worlds" ~/.local/bin/`.

## Configure worlds

```sh
bin/agent-worlds init      # writes ~/.config/agent-worlds/config.json
```

Edit the file and point each world at your repos (absolute paths to the main checkout;
worktrees of those repos are recognised automatically):

```json
{
  "port": 4317,
  "host": "127.0.0.1",
  "extraHosts": [],
  "worlds": [
    { "id": "web",    "name": "Web",    "color": "#47b4a7", "repos": ["/home/me/code/repo-a", "/home/me/code/repo-b"] },
    { "id": "mobile", "name": "Mobile", "color": "#e0a03a", "repos": ["/home/me/code/repo-c"] }
  ]
}
```

Set `AGENT_WORLDS_HOME` to use a different directory than `~/.config/agent-worlds`.
`extraHosts` lists extra `host:port` origins allowed to call the server (for example
`"localhost:5190"` when running the web UI's dev server).

## Add the hooks

Agent Worlds never edits your Claude settings. Print the hooks block and paste it into
`~/.claude/settings.json` yourself (merge it with any `"hooks"` you already have):

```sh
bin/agent-worlds hooks --print
```

The block wires `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`,
`SubagentStart`, `SubagentStop` and `SessionEnd` to `bin/aw-hook`.

`aw-hook` is safe to leave installed: when the server is not running it exits silently
within about a second, and `AGENT_WORLDS_DISABLE=1` turns it off for one shell.

**Timeouts.** `PermissionRequest` hooks get `timeout: 3600` seconds; the server holds each
request for up to 3540 seconds waiting for you to decide in the browser, then lets go.
Everything else uses `timeout: 10` (the hook itself gives up after 2 seconds).
While a request is held, Claude's own prompt is also on screen in the terminal: answering
either place works, whichever comes first. If no browser is open, the server answers at
once and you get the normal terminal prompt.

## Start

```sh
bin/agent-worlds start     # run the server (keep it running, e.g. in its own tmux window)
bin/agent-worlds url       # prints http://127.0.0.1:4317/?token=...
```

Open the printed URL. It stores the token in a cookie and redirects to the app.

Start sessions as usual (`claude` inside tmux) or let Agent Worlds create one:

```sh
bin/agent-worlds new web ~/code/repo-a "fix the failing login test"
```

This creates a tmux session `aw-<repo>-<id>` running `claude` in that directory.
Sessions that are not inside tmux still show up, but the terminal view and the
"type into session" box need tmux.

## How answers reach Claude

- **Permissions**: the `PermissionRequest` hook is held open until you click allow or
  deny; the server then returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` (or `deny`).
- **Questions** (`AskUserQuestion`): answered through the same held `PermissionRequest`,
  returning `behavior: "allow"` with `updatedInput.answers`. This keeps the terminal
  question usable at the same time, which holding `PreToolUse` would not.
- **Typing**: text from the browser is sent with `tmux send-keys -l` (literal, never
  through a shell), followed by Enter.

## Security

- The server binds `127.0.0.1` by default. Do not expose it on a network: the terminal
  view is a full shell as your user, and allowing a permission runs commands on your machine.
- Every HTTP route and both websockets require the token (cookie `aw_token` or header
  `X-AW-Token`). The token is in `~/.config/agent-worlds/token` (mode 0600); delete it and
  restart to rotate.
- Requests that carry an `Origin` header must come from the server's own host:port or an
  `extraHosts` entry.
- Session state is in memory only. After a restart, a session reappears on its next hook event.

## Development

```sh
cd server && node --test      # unit + HTTP tests
```
