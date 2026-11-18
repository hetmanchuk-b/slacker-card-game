# Game runtime — Stage 6

## Interface and test seam

The approved runtime seam covers command ordering, injected time/randomness, timer scheduling, and connection suspension. Tests use the real engine and in-memory history through `GameRuntime`; only the clock is replaced by a controlled adapter.

Implemented interface:

- `GameRuntime.create(options)` initializes one serialized runtime per game.
- `dispatch(command, options?)` processes a gameplay or trusted connection/replacement command in arrival order. Caller identity and human/bot origin must be bound by the server, not a browser field.
- `read()` returns a detached, server-only committed snapshot, including live seat controllers and the control vote.
- `checkpoint()` captures recovery metadata at a known history head.
- `GameRuntime.restore(options, checkpoint)` restores control metadata against that exact history head, with sockets disconnected.
- `dispose()` stops scheduling; an old runtime must not act after a replacement runtime is created.

Every mutation, including a clock callback, enters the same per-game promise queue. Scheduled callbacks carry a generation and branch/head identity; canceled or obsolete callbacks cannot execute an old turn. Explicit out-of-turn card commands still reach the engine and remain punishable. Accepted command receipts are deduplicated before rules run; a reused command ID with a different payload is rejected.

The optional awaited `commit(checkpoint)` adapter atomically stores staged history and runtime metadata. Public `read()` and command acknowledgments remain at the committed view until it completes; persistence failure faults the runtime. Deadline callbacks are armed only after successful commit. `dispose()` does not save; call `checkpoint()` first for a healthy graceful shutdown. Never mutate/read the private history draft as an alternative to the published runtime view.

Use `systemInputs(onError)` for a monotonic process clock, cryptographic bounded randomness, and UUID command IDs. Tests use `FakeClock` instead. The host must keep exactly one runtime writer per game and dispose the old instance before creating its replacement. Socket adapters must consolidate a seat's live connections before reporting disconnect/reconnect.

## Two kinds of time

Gameplay phase and claim/penalty procedure timers belong to rollbackable engine state. A runtime suspension records which timers were running and freezes their remaining milliseconds. It must not restart a reveal paused by a claim or the ballot already suspended inside withdrawal.

Absence duration and the 10-second replacement vote belong to live runtime control state. They continue while gameplay is paused. Replacement proposals require **more than** 30 seconds of absence; exactly 30 seconds is not sufficient. No replacement is automatic without a vote.

## Presence and controllers

Live connections are not rolled back with cards. A disconnected human-controlled participant suspends gameplay. Replacing that seat with a bot removes that absence cause without changing the seat or round target. Human reconnection takes control back after the currently queued atomic action.

Replacement control is available to connected, still-active human participants. Bot policy/decisions are Stage 10 work; Stage 6 assigns controller ownership only. Gameplay stays suspended if no active human participant is connected, so bots do not run a match alone. Finished seats and unknown spectator departures do not introduce participant-absence causes.

## Recovery policy

A recovery checkpoint records its capture time and exact history head. On restart, old sockets are not assumed alive. Gameplay resumes only after presence is reconciled. Remaining gameplay time is preserved as of the captured checkpoint, rather than spent during server downtime. The passive checkpoint contains capture time plus the existing history head; restore appends logical suspension at that capture time, then rebases running timers to actual reconnection time. A checkpoint must not silently overwrite a newer journal head.

Replacement votes use real elapsed time; their recorded deadlines are not reset by a process restart. Durable checkpoint storage is now implemented through `PostgresSession`; real PostgreSQL tests include a fresh Node process and injected storage failures. See `postgres.md`. Persistence is opt-in: runtime instances without a commit adapter are still in-memory only.

Control audit records retain connection changes, replacement ballots/results, and handovers independently of card history. Recovery preserves accepted receipts, rejects a checkpoint whose head no longer matches the journal, and validates recovery metadata before changing history. JSON checkpoint round-tripping is covered by tests.

Runtime `dispatch` now accepts a trusted `rollback` command with an expected head, target completed command ID, actor and explicit knowledge-warning acknowledgment. In-memory rollback rebases timers using the selected pre-action time and preserves current live connections/controllers. Accepted receipts retain their historical branch heads, but abandoned gameplay cannot execute again through a cached old-branch receipt. Checkpoint validation permits receipts referring to retained branches. A branch change cancels pending replacement voting; cancellation records distinguish rollback from target reconnection (the optional reason field is absent in legacy checkpoints).

After a fork, gameplay/replacement commands require an explicit current branch ID. Live disconnect/reconnect notices remain branch-independent. `handoff(publish)` runs the actual transition in that queue: after verifying the game is still finished, it stages rollback closure and awaits an atomic publisher for the old/new frames and lobby pointer. Only success retires the old runtime. `PostgresLobby.startMatch()` supplies that publisher. Rollback queued first reopens the game and prevents handoff; handoff completed first rejects later mutations of the retired runtime. Preparation errors leave the old live runtime usable; failed transition transactions require recovery from the unchanged durable state. The legacy `closeForNextMatch()` guard is not the actual-start path.

`observe(operation)` orders read-only external operations, such as canonical chat context capture, against play/rollback without appending game actions. It is queued before database lookups; observer errors do not fault gameplay or stop its timers. Never re-enter the same runtime queue from an observer. Future Stage 11a must add its agreed minigame-completion gate.

See `docs/history.md` for the in-memory rollback interface and remaining durable work. Checkpoint recovery and owner rollback are separate operations.

All snapshots, receipts, and checkpoints contain private state and are not network payloads. Stage 8 must apply authorized projections and validate external commands before calling this module.
