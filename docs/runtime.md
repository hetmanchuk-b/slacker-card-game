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

Use `systemInputs(onError)` for a monotonic process clock, cryptographic bounded randomness, and UUID command IDs. Tests use `FakeClock` instead. The host must keep exactly one runtime writer per game and dispose the old instance before creating its replacement. Socket adapters must consolidate a seat's live connections before reporting disconnect/reconnect.

## Two kinds of time

Gameplay phase and claim/penalty procedure timers belong to rollbackable engine state. A runtime suspension records which timers were running and freezes their remaining milliseconds. It must not restart a reveal paused by a claim or the ballot already suspended inside withdrawal.

Absence duration and the 10-second replacement vote belong to live runtime control state. They continue while gameplay is paused. Replacement proposals require **more than** 30 seconds of absence; exactly 30 seconds is not sufficient. No replacement is automatic without a vote.

## Presence and controllers

Live connections are not rolled back with cards. A disconnected human-controlled participant suspends gameplay. Replacing that seat with a bot removes that absence cause without changing the seat or round target. Human reconnection takes control back after the currently queued atomic action.

Replacement control is available to connected, still-active human participants. Bot policy/decisions are Stage 10 work; Stage 6 assigns controller ownership only. Gameplay stays suspended if no active human participant is connected, so bots do not run a match alone. Finished seats and unknown spectator departures do not introduce participant-absence causes.

## Recovery policy

A recovery checkpoint records its capture time and exact history head. On restart, old sockets are not assumed alive. Gameplay resumes only after presence is reconciled. Remaining gameplay time is preserved as of the captured checkpoint, rather than spent during server downtime. The passive checkpoint contains capture time plus the existing history head; restore appends logical suspension at that capture time, then rebases running timers to actual reconnection time. A checkpoint must not silently overwrite a newer journal head.

Replacement votes use real elapsed time; their recorded deadlines are not reset by a process restart. Durable storage of checkpoints is Stage 7 work. In-memory recovery tests do not imply crash-safe PostgreSQL persistence already exists.

Control audit records retain connection changes, replacement ballots/results, and handovers independently of card history. Recovery preserves accepted receipts, rejects a checkpoint whose head no longer matches the journal, and validates recovery metadata before changing history. JSON checkpoint round-tripping is covered by tests.

Stage 7 rollback must similarly rebase timers using the selected rollback point's time, not subtract the entire abandoned future from a running timer. It must preserve current live connections while discarding abandoned future gameplay occurrences/receipts as appropriate. Checkpoint recovery is not an implementation of owner rollback.

All snapshots, receipts, and checkpoints contain private state and are not network payloads. Stage 8 must apply authorized projections and validate external commands before calling this module.
