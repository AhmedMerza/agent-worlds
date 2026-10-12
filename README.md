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

## Worlds

Worlds are managed in the app: press `W` to create, rename, recolour, reorder or delete a
world and to pick its repos with the folder browser. Nothing is fixed; a fresh install has
no worlds and every session shows up under "Unsorted" until its repo belongs to one.
Deleting a world never stops its sessions, they just become unsorted.

Each repo belongs to at most one world. Pick the repo's top folder; a worktree counts as its
main repo. Changes are saved to `~/.config/agent-worlds/config.json`.

Editing that file by hand is optional (restart the server afterwards):

```sh
bin/agent-worlds init      # writes a config with no worlds
```

```json
{
  "port": 4317,
  "worlds": [
    { "id": "web", "name": "Web", "color": "#47b4a7", "repos": ["/home/me/code/repo-a", "/home/me/code/repo-b"] }
  ]
}
```

Set `AGENT_WORLDS_HOME` to use a different directory than `~/.config/agent-worlds`.

Optional keys:

| key | default | meaning |
|---|---|---|
| `listen` | `["127.0.0.1"]` | addresses to bind. Add a private VPN address (e.g. a Tailscale `100.x.y.z`) to reach it from your phone. |
| `extraHosts` | `[]` | extra `host:port` origins allowed to call the server, e.g. `"localhost:5190"` when running the web UI's Vite dev server |
| `userSettingsPath` | `~/.claude/settings.json` | where "Always allow: everywhere" writes its rule |
| `claudeBin` | `claude` | the Claude Code binary used for new sessions and catch-up summaries |
| `contextLimit` | `1000000` | context window used for the context % (usage past it, or a `[1m]` model id, counts as a 1M window) |

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

## Features

- **Needs-you inbox**: permission requests, questions and finished turns from every session.
- **Always allow**: on a permission card, "In <repo>" adds the rule to
  `<repo>/.claude/settings.local.json`, "In the <world> world" to every repo of that world,
  "Everywhere" to your user settings. Rules use Claude Code's permission syntax (Claude's own
  suggestion when it offers one, e.g. `Bash(npm run lint *)`; otherwise the exact command or
  `Edit(//abs/path)`). Existing content of those files is kept; a file that is not valid JSON
  is never touched. "Everywhere" is refused for risky requests (pushes, database changes,
  deploys, recursive deletes, writes outside the project, ...).
- **Catch-up** (on request): a short "you asked / it did / it needs" summary of a session,
  made by `claude -p --model haiku` from the transcript. It runs with `AGENT_WORLDS_DISABLE=1`,
  in restricted mode in an empty temp directory, at most two at a time.
- **Context**: how full each session's context window is, from its transcript.
- **Review** when a turn finishes: changed files (uncommitted changes plus commits ahead of
  the default branch, untracked files included), the diff (up to 200 KB) and the last test
  run's result.
- **Conflicts**: sessions in the same folder or on the same branch, running tests in the same
  repo at once (shared database), or working on the same issue number.
- **New task**: start a session from the browser, optionally in a new git worktree
  (`<repo>-worktrees/<branch>`, branch `aw/<task>-<id>` unless you name one).
- **Keyboard shortcuts**: press `?` in the app.

## Install as an app

The web UI is a PWA: in Chrome or Edge use "Install app", on iOS Safari "Add to Home Screen".
The manifest and icons are served without the token so the browser can read them; everything
else still needs it. Phones only offer installation over **https** (or on localhost), so a
plain `http://100.x.y.z:4317` address works in the browser but will not install. Put the
server behind an https proxy on your private network (for example `tailscale serve`) if you
want the installed app on a phone.

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
  If you add an address to `listen` for phone use, make it one only you can reach (a private
  VPN such as Tailscale), never a LAN or public address. Anyone holding the token on that
  network has your shell.
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
