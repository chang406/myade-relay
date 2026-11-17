# P0 interactive handoff experiment

This opt-in experiment keeps the normal Claude Code and Codex terminal UIs. It
uses an isolated myade daemon and data directory under `node_modules/`; it does
not read or write the normal `data/` or `~/.myade` stores.

The adapter in `mailbox.cjs` binds one MCP subprocess to one pane ID, so the
model cannot choose its own sender/recipient identity. It never writes to a PTY.
Its audit events distinguish `notification_sent_not_received` from the later
`exchange_receive`, `exchange_reply`, and `exchange_collect` tool results.

## Claude Code

Claude Code 2.1.218 can receive an MCP Channel notification in an already open
interactive session. Custom channels are a research-preview feature and require
the explicit `--dangerously-load-development-channels server:myade` launch flag
and Claude's local-development confirmation. The adapter omits permission relay,
so ordinary MCP tool confirmations stay in the terminal.

Official documentation (links as written at the time; not re-checked when archived):

- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/channels-reference

## Codex

Codex CLI 0.154.0 exposes `codex queue --thread <id> --message <text>`. It wakes
an open idle TUI and preserves the same conversation. A message queued while the
TUI is closed is consumed when that thread is resumed. Normal MCP tool approval
prompts remain in the TUI. `codex app-server` can host a TUI through `--remote`,
but replacing myade's existing PTY ownership with a new app-server client is a
separate product change and was not needed for this experiment.

Official documentation (links as written at the time; not re-checked when archived):

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/hooks

## Running the isolated lab

Build first with `npm test`, then start the lab:

```powershell
node experiments/p0/lab.cjs
```

The lab prints its temporary directory and stays in the foreground to own the
isolated daemon. In another terminal, use `launch.cjs` with that directory and
the locally installed CLI executable. The Claude invocation asks for workspace
trust and development-channel confirmation. Codex is launched with a read-only
sandbox and normal approvals. Do not automate either confirmation screen.

`lab.cjs <existing-lab-directory>` restarts only the isolated daemon while
preserving prior evidence. Audit JSONL and `exchanges.json` remain in the printed
directory for inspection. Stop the foreground lab with Ctrl+C after closing the
two CLIs.

This is a technical experiment, not production wiring. Production work still
needs provider session IDs in myade state, a per-pane adapter lifecycle, and a
UI action for enabling Claude's preview channel or selecting a Codex thread.
