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
- `subscribe(receive, report?)` installs a server-private committed-publication listener in queue order and resolves to an idempotent, immediate unsubscribe function. See Stage 8.6 below; this is not a network subscription.

Every mutation, including a clock callback, enters the same per-game promise queue. Scheduled callbacks carry a generation and branch/head identity; canceled or obsolete callbacks cannot execute an old turn. Explicit out-of-turn card commands still reach the engine and remain punishable. Accepted command receipts are deduplicated before rules run; a reused command ID with a different payload is rejected.

The optional awaited `commit(checkpoint)` adapter atomically stores staged history and runtime metadata. Public `read()` and command acknowledgments remain at the committed view until it completes; persistence failure faults the runtime. Deadline callbacks are armed only after successful commit. `dispose()` does not save; call `checkpoint()` first for a healthy graceful shutdown. Never mutate/read the private history draft as an alternative to the published runtime view.

Use `systemInputs(onError)` for a monotonic process clock, cryptographic bounded randomness, and UUID command IDs. Tests use `FakeClock` instead. The host must keep exactly one runtime writer per game and dispose the old instance before creating its replacement. `PostgresGameHost` now owns this local writer lifecycle and consolidates trusted seat connections; see `game-host.md`. Socket adapters must authenticate/revalidate bindings before attaching and detach revoked/expired connections. They must not independently report per-socket disconnects to a shared seat.

## Optional authenticated queue admission — Stage 8.9

The operator approved additive `DispatchOptions.admit(snapshot): boolean | Promise<boolean>`. It runs inside the serialized runtime queue, **before receipt lookup, branch/rule processing or mutation**. Its detached snapshot is private server data. Only `true` admits the command; false produces a headless `RuntimeAdmissionError` with fixed code `unauthorized`. A thrown/rejected guard produces the same fixed exception with code `unavailable`, without retaining its diagnostic/cause. Infrastructure failure is not reported as invalid identity.

Admission denial changes no actions, receipts, persistence, publications or scheduling and does not fault the runtime. A caller can retry the original ID after successful authorization. Existing unguarded internal callers retain their behavior; the guard is not stored in receipts, checkpoints or frames. Once admitted, an atomic decision/commit drains even if its caller subsequently leaves; transport suppresses delivery to invalid peers rather than undoing a committed action.

Guards must be trusted, bounded and non-reentrant: do not call/await runtime or host queue methods, mutate the snapshot as an authority mechanism, or await network delivery. The transport uses non-refreshing credential SQL reads with deployment DB timeouts, followed by current socket/expiry/roster/human-controller checks. This prevents queued disconnections/revocations and cached receipts from bypassing current transport authorization. The runtime does not import credentials, sockets or SQL; engine rules remain unchanged. `src/runtime/admission.test.ts` covers denied admission, queued/cached receipt checks, detached inputs, sanitized sync/async errors, preserved deadlines and draining admitted commits.

## Committed publication subscriptions — Stage 8.6

Subscribe only after obtaining a **live** runtime from `create`, `restore` or a successfully completed `PostgresLobby.startMatch`. No callback is installed through construction options: private successor preparation must never notify before its atomic database transition. Subscriptions do not modify checkpoints, frames, runtime options or existing result/snapshot contracts.

Registration receives one detached `RuntimePublication` with kind `initial`, the current committed snapshot and an empty action list. It never replays preloaded/recovered history, receipts, private peeks or earlier observations. Registration is read-only and does not commit. A failed/faulted/retired/disposed runtime rejects new subscriptions with a fixed unavailable error.

Subsequent notices contain:

- `sequence`: monotonically increasing publication number for this runtime instance, independent of game-head version. It is not persisted, a PostgreSQL revision, a reliable-delivery acknowledgment or a transport epoch. Later hosts must allocate an epoch per live writer lifetime; a late subscriber's initial sequence may already be greater than one.
- `kind`: `update`, `rollback`, `rollback-closed` or terminal `handoff` (plus subscription baseline `initial`).
- `nowMs`: trusted injected runtime time sampled at publication/initial subscription, suitable for scoped live timer projection.
- `snapshot`: the complete final committed **server-only** runtime snapshot, including controls.
- `actions`: exact newly appended per-action `{ before, action, after, delivery: 'fresh' }` pairs, in order. One queue job may contain several actions, e.g. creation/play plus clock reconciliation, but only one final snapshot notice is delivered. Each pair has adjacent same-game/branch heads and can be consumed by the existing authorized action projector. No intermediate snapshot is a separate publication.

Rollback captures only its new child-branch rebase and any new reconciliation, not inherited prefixes or abandoned futures. Rollback before creation has no synthetic pair. Administrative rebases project no card observations. Legacy closure and actual handoff emit explicit same-head metadata notices with no action replay; the legacy closure guard suppresses repeated closure notices in the same instance. Handoff waits for its special atomic publisher and never adds an ordinary old-game commit. Failed transactions emit nothing.

Deadline callbacks use the same publication path as dispatch. Control-only changes notify even if the action head is identical. Duplicate/rejected/checkpoint jobs retain their existing persistence behavior but do not notify if snapshot/control content is unchanged. `observe`, unsubscribe and disposal do not publish. Obsolete/canceled callbacks cannot produce stale notices. Fresh private peek observations are available only through the one fresh action pair; retries and new subscriptions do not reproduce them.

### Delivery and failure semantics

The commit adapter completes first, then `read()` is installed, deadlines are armed, and listeners are invoked synchronously in publication order with a **separate deep clone per listener**. A listener may enqueue follow-up runtime work. Its returned promise is never awaited, so async work, reentrancy or a never-settling delivery cannot hold the game queue or acknowledgment hostage. Synchronous JavaScript work still occupies the event loop: keep the synchronous prefix short and do not create feedback loops.

Synchronous throws, cloning failures and asynchronous rejections are caught outside the runtime fault path. Optional `report(sequence)` receives only the affected publication sequence, never the exception/cause or raw private payload. Reporter throws/rejections are also isolated. Delivery failure cannot roll back committed storage, invalidate an accepted receipt or masquerade as commit failure. This is best-effort invocation, not an outbox, retry ledger, backpressure mechanism or exactly-once network delivery. Async listener completions may arrive out of order; later hosts must bound/order their delivery work and reject stale epochs/branches.

Unsubscribe prevents new invocations immediately; disposal clears subscribers. Already-running async listener work cannot be canceled by the runtime; its failures are still caught/reported. A host must invalidate obsolete queued network work on rollback/handoff/disposal and refresh authorized state after delivery failure, **without replaying one-time private observations**.

### Capturing history and privacy

Every field in `RuntimePublication` is **private server data**, not a generic browser/bot payload. Apply the existing viewer-specific projection/envelope builders only after fresh identity/seat authorization. No sockets, identity binding, transport counters or client delivery are implemented here. Stage 8.7's private host allocates writer-lifetime epochs and can install subscriptions through `withCurrent`; it does not implement network ordering/delivery.

Use the detached notice for later asynchronous work, not a fresh `read()` of a potentially newer game. If a host needs owner-history metadata from its concrete committed history, capture/project that sidecar **synchronously in the listener before the first await**. This synchronous prefix is still at the serialized committed point, including same-head closure. Do not re-read mutable staging history after awaiting or assume matching heads prove a closure committed. Alternatively use a separately retained, validated committed storage frame. The generic History interface is unchanged; this seam does not turn arbitrary history reads into proof of commitment.

Without `commit`, publication is only authoritative in memory, not crash durable. Restore requires a new live runtime/subscription baseline; publication sequence and delivery work are not recovered from checkpoints.

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
