# P0 technical validation

> Archive note: the evidence folders referenced below (`.relay/verification*/`) were never committed and are not included. Thread, session and request IDs were replaced with placeholders; the same ID uses the same placeholder in every document.

Date: 2026-09-14

## Verified new-thread lifecycle on 2026-09-15

- Codex CLI 0.154.0 exposes loopback WebSocket App Server, TUI `--remote`, and queue `--remote` support.
- Relay started App Server, connected the real TUI, and learned thread id `<id-1>` from the official `thread/started` notification without terminal or rollout-file parsing.
- Request `<id-2>` was delivered with `codex queue --remote`. Codex explicitly called `relay_receive`, producing `accepted`, and `relay_reply`, producing `replied` with answer `NEW-THREAD-ROUNDTRIP-OK`.
- The Claude Channel answer notification was sent. The source Claude session explicitly called `relay_collect`, and the persisted exchange reached final status `delivered` at `2026-09-14T18:14:01.295Z`.
- Two discarded approaches established an important boundary: an empty App Server `thread/start` id cannot be resumed or addressed by a separate non-remote queue process because no rollout exists yet. Their failed attempts remain in `.relay/verification3/`.

## Verified with real interactive CLIs

- Claude Code 2.1.218 launched in its normal interactive terminal through `myade-relay launch`.
- Codex CLI 0.154.0 resumed the existing thread `<id-3>` in its normal interactive terminal.
- Both CLIs connected to separate stdio MCP adapters whose relay identity was fixed by launcher configuration.
- Claude called `relay_send` for request `<id-4>`.
- The isolated relay changed the request from `queued` to `delivery_attempted` only after the exact registered Codex binary returned success from `codex queue`.
- The open Codex conversation woke, called `relay_receive`, calculated `31 + 11`, and called `relay_reply` with answer `42`, calculation evidence, and no uncertainty.
- The exchange then had status `replied`. This was the first state proving that the target agent had accepted the request and returned an answer.
- The Claude Channel adapter sent an answer notification into the still-open Claude session. Claude woke and requested `relay_collect`.
- After the normal one-time MCP permission confirmation, Claude collected and displayed the answer. The persisted final status was `delivered`.
- No terminal keystroke injection exists in relay. Workspace trust, development Channel confirmation, and MCP tool confirmations stayed visible in the provider terminals.

The evidence is preserved under `.relay/verification2/` and excluded from source control. The isolated directory kept the experiment separate from the default `~/.myade-relay` data store and provider-owned configuration.

## Explicit retry verified by automated tests on 2026-09-15

- `retry --session ID --request REQUEST_ID --direction request|answer` stores a direction-specific retry request without deleting previous attempts.
- Request retry is owned by the source session; answer retry is owned by the target session.
- A request cannot be retried after target acceptance, and an answer cannot be retried after collection or cancellation.
- The consumed delivery attempt records `trigger: explicit`; ordinary attempts retain `trigger: automatic`.
- An explicit retry can make one further attempt after the automatic two-failure limit, then the limit applies again.
- Exchanges written before these fields existed load with compatibility defaults.

## Explicit retry against an interrupted real Codex queue on 2026-09-15

- An isolated run used `.relay/verification4/data`, an independent loopback port, and the installed Codex CLI 0.154.0 binary. It did not touch the earlier verification data or the default data directory.
- Exchange `<id-5>` targeted an intentionally closed App Server endpoint at `ws://127.0.0.1:65491`. The actual `codex queue` process exited 1 with Windows connection-refused error 10061.
- The first request attempt was persisted as `codex_queue: failed`, `trigger: automatic`. After the source requested a request-direction retry through the exchange store, the next actual queue attempt was persisted as `codex_queue: failed`, `trigger: explicit`. The earlier attempt remained intact and `retryRequested.request` returned to `false`.
- The final state was `queued`. This verifies that explicit retry causes another real provider transport attempt after an interruption; it does not establish transport recovery, target receipt, or a completed roundtrip. The isolated script called the exchange store directly, so the CLI retry entry point in this scenario remains covered only by automated tests.

## Restored Codex queue retry with real receipt on 2026-09-15

- An isolated run used `.relay/verification5/data` and the installed Codex CLI 0.154.0 binary. A real interactive Codex TUI started a new thread `<id-6>`, registered from the official `thread/started` notification, and stayed connected to its loopback App Server during the retry.
- Exchange `<id-7>` first targeted a closed loopback endpoint. The actual `codex queue` exited 1 with connection-refused error 10061, leaving a request attempt with `trigger: automatic`, `outcome: failed` and status `queued`.
- The target session's remote endpoint was restored to the live App Server. The source used the real CLI `retry --session source --request <id-7> --direction request`. The next actual queue attempt returned success and was stored with `trigger: explicit`, `outcome: sent`; status became `delivery_attempted`.
- The real Codex session called `relay_receive`, advancing the persisted exchange to `accepted`. This proves target receipt separately from queue success. The isolated source was a manually registered test session, and this run did not observe `relay_reply` or source `relay_collect`; the earlier real roundtrip evidence covers those actions on an ordinary delivery path.

## Server restart recovery on 2026-09-15

- `node .relay/verification6/process-restart.mjs .relay/verification7/data` started a loopback Relay server in one Node process, stored three exchanges, stopped that process, and started a new process with the same isolated data. Request `<id-8>` remained `queued`, request `<id-9>` remained `delivery_attempted`, and request `<id-10>` remained `replied`.
- The source's request retry flag set before process exit survived restart. Its next attempt recorded `trigger: explicit`, and the stored reply was collected after restart, reaching `delivered`. This process experiment used manually recorded transport attempts and did not launch a provider CLI.
- A new automated restart test reloads fresh server registries from the same JSON and checks coordinator behavior. A `queued` request is attempted, a `delivery_attempted` request with no retry is not replayed, an unsent `replied` answer is attempted, a sent answer is not replayed, direction-specific explicit retries are consumed, and the two-failure automatic limit remains effective. `npm test` passes 16 tests.
- The actual crash window between a successful provider transport return and a persisted attempt record remains unverified. Based on the current code order, such a crash could leave `queued` and permit a duplicate notification on restart; this is an inference, not an observed provider outcome.

## Doctor verified against installed CLIs on 2026-09-15

- `doctor` completed with `ok: true` against the isolated Relay server at `127.0.0.1:4320` and `.relay/verification3`.
- It identified Claude Code 2.1.218 and Codex CLI 0.154.0, confirmed the Codex queue subcommand and Claude MCP/development Channel flags, and did not launch an interactive provider session.
- Data and runtime directory writability, an unused candidate session id, and active Codex thread registration all passed.
- The first sandboxed probe could not execute the external Codex binary and exposed that Claude's development Channel flag is hidden from ordinary help. The final check directly exercised help parsing for the hidden flag and reran external executable checks with the required execution permission.

## Failure found and fixed during the real run

The first isolated run attempted `codex queue` twice with the bare command `codex` and received `spawn codex ENOENT` both times. The retry limit stopped after two failures and the exchange remained `queued`.

The cause was that the launcher knew the absolute Codex executable path but the server did not. Relay sessions now persist `deliveryCommand`, and the delivery coordinator uses that exact path without a shell. The second isolated run recorded `codex_queue: sent` and completed the real roundtrip.

## Not yet verified

- Interrupted real Claude Channel delivery and its explicit retry. The restored Codex experiment established queue recovery and target receipt, but did not observe a reply or collection on that retry exchange.
- The optional `scripts/session-start.cjs` provider hook against both providers' installed hook configuration. Core delivery did not need it for the verified known-thread path.
- A sudden process exit between a successful provider transport return and its persisted attempt record. The parked `queued`, `delivery_attempted`, and `replied` states were restored, but this in-flight window was not exercised with a provider.
- Multiple simultaneous Claude and Codex sessions under sustained traffic.
- macOS/Linux launcher behavior.
- Claude Code showed a duplicate `no MCP server configured with that name` startup message even though `/mcp` showed `relay` connected with six tools and Channel messages actually woke the session. This UI inconsistency needs a smaller reproduction against Claude Code updates.

## Next steps

1. Verify simultaneous Claude and Codex sessions and request contention.
2. Exercise the in-flight provider transport crash window and controlled Claude Channel retry without bypassing provider permissions.
3. Keep the product CLI-only until repeated use shows a concrete need for a small session/request view.
