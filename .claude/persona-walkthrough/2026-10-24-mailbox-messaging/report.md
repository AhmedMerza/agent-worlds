# Agent Worlds mailbox and handoff walkthrough

Date: 2026-10-24

## Question

Can a lead reliably find the intended session and hand it a task, and does a message sent while the recipient is busy survive startup identity changes?

## Result

The backend bug is fixed in `6fe3d95`. When a CLI first registers under a launch placeholder (`starting:<tmux-name>`) and then its first hook supplies the real session ID, pending mailbox messages and peer registration now move to the real ID. The regression test verifies `aw_agents`, `aw_inbox`, and the persisted mailboxed registry after the rename. A second unit test verifies the message exchange limit follows the rename.

A busy recipient still receives mail only after becoming free; that is the intended queue behavior. The MCP tool descriptions now say to use the session `id` from `aw_agents`, rather than a branch, repo@branch label, or tmux name.

## Verification

- `node --test test/mailbox.test.ts`: 10 tests passed.
- `npm run typecheck` in the server worktree: passed.
- `npm run build` in the web worktree: passed (existing large-chunk warning).
- `git diff --check`: passed.
- Clean persona walkthroughs ran against three isolated deterministic demo instances; a separate responsive sweep covered dashboard, chat, and terminal at mobile, laptop, desktop, and ultrawide widths. No active Agent Worlds session or default tmux server was touched.

The browser demo cannot exercise the MCP-only mailbox queue, so the integration regression test is the direct verification of that behavior. Persona exploration supplements it by checking whether people can understand and route work in the UI.

## Persona findings

| Persona | Goal | Outcome |
| --- | --- | --- |
| Elliot, engineering lead | Find an idle helper, hand off a task, and confirm receipt | Could spot an idle session, but `+ New chat` opened a new session in the default repo rather than handing work to the selected idle session. He could not confirm delivery through the dashboard. |
| Layla, Arabic-first coordinator on mobile | Check that a photo-upload task reached the right session | Had difficulty distinguishing sessions from clipped task/branch labels and found no visible mailbox receipt indicator. The dashboard does not expose the MCP queue. |
| Morgan, cautious first-time manager | Explore the workspace safely | Found the main areas, but “Worlds”, “New run”, the default permission wording, and opening a terminal from a character were not self-explanatory. |

## Follow-up opportunities

1. Make the selected session explicit when starting a chat or handing a task to an idle helper; show the recipient and delivery state.
2. Improve mobile session identification by prioritizing task names and avoiding clipped branch labels.
3. Explain that MCP mail is sent from agent tools and queued while the recipient is working, with a clear received/awaiting status where the product can observe it.
4. Review first-run wording for “Worlds”, “New run”, and permission defaults.

These UI items are separate from the fixed backend identity-transfer bug and were not changed in this patch.
