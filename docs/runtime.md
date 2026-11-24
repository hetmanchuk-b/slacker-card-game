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

## Durable permitted bot memory — Stage 10.3

Runtime checkpoints now write schema version2 with a version1 `botMemory` payload. Version1 runtime checkpoints remain readable but initialize knowledge as unknown. Every seat's memory is runtime-owned regardless of controller or subscriber presence; raw runtime snapshots/publications still never become bot-policy inputs. Exact fresh action pairs pass through the existing seat adapters/reducer before the same authoritative frame commit. Same-head observations can update current knowledge but cannot overwrite a captured pre-command target. Failed commits publish neither state nor knowledge and fault the runtime.

The payload stores current per-seat memories and at most256 FIFO pre-command knowledge checkpoints (at most8 seats each). Eviction affects knowledge only, never retained game history. Rollback selects the exact command-bound prior checkpoint; missing/evicted targets restore unknown. Recovery validates strict shapes, versions, seat/game bindings, command/head binding, ancestor provenance and capacity before using knowledge. It restores recorded memory without replaying archived observations. Recovery/rollback suppress historical initial notices and reveals; new game-start/draw actions release that suppression. Current own/public projections remain separate from reconstructed knowledge. No bot scheduler or autonomous command is added.

Memory lives only in server-private checkpoints, not generic runtime snapshots, publications or network projections. The host's existing checkpoint restoration and atomic successor handoff carry it without a new writer or SQL table. `src/runtime/memory.test.ts`, `src/bots/memory-storage.test.ts` and `src/persistence/bot-memory.test.ts` cover the boundary. Runtime instances without `commit` remain memory-only, not crash durable.

## Exact opening-boundary memory — D013 prerequisite

D013 amends the original10.2/10.6 play-only proof: a fresh contiguous numeric boundary from `round:n` or `between-rounds:n` to `between-rounds:n+1`, with nonempty play/pickup-only seat observations, can grant known entitlement to an active own seat with final empty hand and stumps. Own transfers/openings/violations exclude it; omitted unrelated transfers do not affect the seat's boundary counts. This does not authenticate freshness by itself: the runtime still supplies exact newly committed pairs. Missing/duplicate-redacted/gapped evidence and same-head retrospective repair remain forbidden. Recovery/rollback never replay archives to fill knowledge, and suspension may still clear continuity.

The prior deterministic2/4/5/8 policy-driven runtime traces now finish, but remain human-bound policy loops, not installed-runner acceptance evidence. No runtime/checkpoint/projection contract or schema change is added; full10.9 is unverified.

## Runner lifecycle integration — Stage 10.8

Cross-feature tests exercise the installed runner rather than treating assigned bot controllers as autonomous execution. Coverage combines rollback-to-null/current live presence, exact permitted knowledge exclusion after rollback, nested timer remainder with multiple absences and no-human pause/resume, fresh-process host recovery and existing autonomous storage-fault cleanup. Old writer references and new-game seat memories are checked separately; no abandoned-future observations or cross-game knowledge are used to make a bot progress.

These are lifecycle tests, not complete autonomous-match acceptance. Trusted finishing is allowed only as an explicitly labeled successor precondition; D010/D011 unknown-order/right waits remain unchanged. No runner policy, gameplay rule, persistence format or human-command fence is changed by this increment.

## Conservative procedure responses — Stage 10.7

`chooseProcedureResponse(view)` uses the seat-private current projection only: explicitly abstain on eligible unanswered claim ballots, approve eligible unanswered withdrawal consent, and refuse eligible unanswered penalty contributions (D012). Eligibility, own-answer strict null and unpaused top-level timer/control are required. A false prior approval is answered, not absent. `suspendedVote` is context only, never an actionable second ballot. Evidence type is not inferred from claim text or hidden history. Bots never initiate accusations/withdrawal requests or answer human-only replacement votes.

Runner decisions retain exact procedure IDs and existing queued exact-head/tenure/cancellation fences; each new committed publication cancels/reconsiders pending work. Nested timers and FIFO resolution remain engine-owned. Existing `choosePenaltyRefusal` is a compatible wrapper. No new projection, persistence, command shape or card-contribution strategy is added. Policy/runtime and real PostgreSQL host tests cover nested clocks, multiple bots, stale commands and recovery without duplicate responses.

## Conservative legal round play — Stage 10.6

`chooseRoundPlay(view, memory)` receives only permitted own-seat current observations and committed memory at the same game/seat/branch/head. On its own turn, an active bot leads the first hand card, beats with the first card for which `canBeat` is proven, or picks the bottom with a nonempty hand. Unknown trump means comparison under every allowed trump, not known no-trump. With an empty hand it opens only a positively remembered current-round entitlement; unknown rights wait even indefinitely (D011), with no peek/probe or bypass pickup. The server alone normalizes automatic empty-hand pickups and fixed N. No voluntary out-of-turn opening, strategy search or social-policy expansion is added.

All four deterministic2/4/5/8-seat runtime match fixtures reached approved unknown-right waits, not complete matches. Engine/projector scenarios separately verify repetition completion and preserved/consumed rights. The runner retains10.4 admission/lifecycle fences and10.5 dealing. This safety slice does not establish complete-match liveness under missing knowledge.

## Committed seat memory and dealing — Stage 10.5

`readBotMemory(seatId)` returns detached knowledge for one existing seat from the same successfully persisted publication as `read()`. Draft memory is not visible during blocked commits; failed runtimes reject reads. This is a trusted server seam, not a network endpoint or a whole-checkpoint policy input. It rejects closed runtimes and invalid/null-state seat bindings.

`chooseDealingDraw(view, memory)` uses only the own initial notice or permitted successful clockwise-draw memory bound to the exact game/seat/branch/head. Missing order waits, even if stalled (D010); neither authoritative order nor historical trump supplies a shortcut. Procedures, pause and final reveal prevent drawing. Existing fresh reveal capture remembers permitted trump, including known no-trump versus unknown, without any expiry command. Runner keeps refusal and10.4 admission/lifecycle fencing; no round-play policy is added.

## Bot-only queued admission — Stage 10.4

`botAdmission(seatId, signal)` captures this live runtime's exact head, committed publication sequence and process-local controller tenure, returning ordinary bot dispatch options. Its guard runs inside serialized admission before receipt lookup. Cancellation, retirement, pause, changed head/control publication or bot→human→bot tenure rejects stale work without faulting the runtime. Runtime-instance ownership fences recovery/writer replacement; host-owned runner disposal fences lifecycle retirement. These fences are process-local, never persisted or applied to ordinary human commands. Once admitted, the existing atomic action drains even if cancellation arrives later.

`src/bots/runner.ts` subscribes to committed notices and passes only detached seat projections to `choosePenaltyRefusal`. Eligible unanswered unpaused bot penalty contributions are explicitly refused;10.5 separately adds legal dealing as described above. The runner never submits timeout commands or originates accusations;10.6 adds conservative legal round play and10.7 adds the approved abstention/withdrawal-consent responses described above. Each new publication cancels unadmitted decisions and reconsiders from fresh observations; duplicate publications are ignored. Stop cancels pending tokens and unsubscribes. No-human suspension remains authoritative. Tests in `src/bots/runner.test.ts` cover stale work, exact-head and tenure fences, handback/ABA, cancellation, pause and already-admitted completion.

## Optional authenticated queue admission — Stage 8.9

The operator approved additive `DispatchOptions.admit(snapshot): boolean | Promise<boolean>`. It runs inside the serialized runtime queue, **before receipt lookup, branch/rule processing or mutation**. Its detached snapshot is private server data. Only `true` admits the command; false produces a headless `RuntimeAdmissionError` with fixed code `unauthorized`. A thrown/rejected guard produces the same fixed exception with code `unavailable`, without retaining its diagnostic/cause. Infrastructure failure is not reported as invalid identity.

Admission denial changes no actions, receipts, persistence, publications or scheduling and does not fault the runtime. A caller can retry the original ID after successful authorization. Existing unguarded internal callers retain their behavior; the guard is not stored in receipts, checkpoints or frames. Once admitted, an atomic decision/commit drains even if its caller subsequently leaves; transport suppresses delivery to invalid peers rather than undoing a committed action.

Guards must be trusted, bounded and non-reentrant: do not call/await runtime or host queue methods, mutate the snapshot as an authority mechanism, or await network delivery. The transport uses non-refreshing credential SQL reads with deployment DB timeouts, followed by current socket/expiry/roster/human-controller checks. This prevents queued disconnections/revocations and cached receipts from bypassing current transport authorization. The runtime does not import credentials, sockets or SQL; engine rules remain unchanged. `src/runtime/admission.test.ts` covers denied admission, queued/cached receipt checks, detached inputs, sanitized sync/async errors, preserved deadlines and draining admitted commits.

## Queued claim resolution — Stage 8.11

The operator approved additive `dispatchClaim(request, resolver, options?)`. `ClaimRequest` contains the server-bound claimant, accused, reason and exact incident reference, but no scope. It shares dispatch's queue and admission guard. Authorization and branch checks precede accepted-receipt lookup; a cached claim compares the original request fields, excluding only server-derived scope/number. Exact retries return the original historical receipt before any new resolution, including after scope changes and recovery. Changed reasons/evidence/accused/actors or controller collisions reject normally. Existing canonical `dispatch` behavior and persisted receipt formats are unchanged.

A new claim passes current controller/presence/suspension checks, then invokes a bounded, non-reentrant trusted resolver with detached `{ snapshot, history, branches }` captured at that serialized committed point. Resolution supplies scope/number or `invalid-claim`/`scope-closed`; the engine still owns eligibility, scope-open checks, incident deduplication and procedures. Resolution and execution share one queue job: no timeout/play/rollback can overtake an awaited evidence lookup. Do not call runtime/host queue methods or await network delivery from a resolver.

Resolver exceptions become headless `RuntimeAdmissionError('unavailable')`, with no receipt, commit, publication or timer change and no runtime fault. Semantic rejections retain ordinary dispatch rejection/checkpoint behavior. Once admission succeeds, the operation drains atomically even if its peer departs; delivery is suppressed by final transport authentication. All captures remain server-private. `claim-admission.test.ts` covers retry ordering, recovery, queue ordering, fresh admission before duplicates and sanitized failure/health.

## Immutable committed-capture seam — transport migration increment1

`subscribeCommittedCapture(receive, report?)` is an additive server-private subscription, not authorization or a wire/bot payload. Registration shares the existing runtime queue: one action-free baseline at that committed point, then ordered committed updates including same-head controls. Baselines are separately owned; each update is cloned once, transitively frozen across records/arrays, and shared only among this seam's listeners. Authority/history/caller graphs are never frozen. `read()` and existing `subscribe()` still return mutable isolated clones.

Callbacks/reporters preserve existing nonblocking failure isolation and immediate unsubscribe semantics. Registration rejects closed/faulted runtimes; rejected storage commits publish no capture. Recovery/resync baselines replay no action observations. `src/runtime/committed-capture.test.ts` tests ownership, mutation attempts and registration across awaited commits, timeout, control and rollback work. No host/transport adoption, state-root intern, quotas or performance claim is included; see `transport-capture-adr.md` for the staged migration.

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

Every field in `RuntimePublication` is **private server data**, not a generic browser/bot payload. Apply the existing viewer-specific projection/envelope builders only after fresh identity/seat authorization. No sockets, identity binding, transport counters or client delivery are implemented here. Stage 8.7's private host allocates writer epochs; Stage 8.10's approved host lifecycle subscription now follows live replacements and forwards this private seam. Its separate transport publisher authorizes/projects and bounds delivery; no network acknowledgment is awaited by runtime listeners.

Use the detached notice for later asynchronous work, not a fresh `read()` of a potentially newer game. If a host needs owner-history metadata from its concrete committed history, capture/project that sidecar **synchronously in the listener before the first await**. This synchronous prefix is still at the serialized committed point, including same-head closure. Do not re-read mutable staging history after awaiting or assume matching heads prove a closure committed. Alternatively use a separately retained, validated committed storage frame. The generic History interface is unchanged; this seam does not turn arbitrary history reads into proof of commitment.

Without `commit`, publication is only authoritative in memory, not crash durable. Restore requires a new live runtime/subscription baseline; publication sequence and delivery work are not recovered from checkpoints. Stage 8.10's host observer automatically rebinds after successful replacement, with synchronous old-epoch invalidation and no recovered action replay. See `game-host.md` and `transport.md`.

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

After a fork, gameplay/replacement commands require an explicit current branch ID. Live disconnect/reconnect notices remain branch-independent. `handoff(publish, expected?, options?)` runs the actual transition in that queue: after verifying the game is still finished, it stages rollback closure and awaits an atomic publisher for the old/new frames and lobby pointer. Only success retires the old runtime. `PostgresLobby.startMatch()` supplies that publisher. Rollback queued first reopens the game and prevents handoff; handoff completed first rejects later mutations of the retired runtime. Preparation errors leave the old live runtime usable; failed transition transactions require recovery from the unchanged durable state. The legacy `closeForNextMatch()` guard is not the actual-start path.

Stage 8.18 adds the optional trusted `handoff(..., { deferClosure: true })` publisher mode for atomic readiness admission. Its callback receives the still-open checkpoint and returns `void` on durable success or `false` on a fully rolled-back pre-write policy refusal. The PostgreSQL publisher builds/persists a closed copy of the old history; only successful commit closes the live history and retires the runtime. False preserves the exact history, current view, writer, timers and rollback window, with no publication/ordinary commit. Returning false without deferred closure is an error; existing callers' default closure behavior is unchanged. Thrown storage/cleanup failures still fault the runtime. The option is captured at call time and introduces no receipt/checkpoint/frame format change. `handoff.test.ts` tests refusal followed by successful reuse; the TLS successor regression withdraws acceptance after private preparation and verifies the same old writer remains usable.

Stage 8.14's approved optional handoff `options.admit(snapshot)` uses the existing admission pattern **outside** mutation/fault/publication, before finished/head checks and rollback closure. It receives a detached committed snapshot and must be bounded/non-reentrant. False yields headless unauthorized; thrown callback failure is sanitized unavailable. Denial/failed authorization changes no closure, state, receipt, commit, timer or publication, and leaves a healthy runtime usable. Do not authorize in the publisher callback: closure is already staged by then. Once admitted, the atomic handoff drains even if the peer departs; final transport authorization suppresses its acknowledgment rather than undoing the commit. Existing unguarded trusted callers retain behavior. No checkpoint or receipt format changes. `handoff.test.ts` verifies queued denial, sanitized failure and unchanged private history, then successful reuse.

`observe(operation)` orders read-only external operations, such as canonical chat context capture, against play/rollback without appending game actions. Stage 8.12's host also uses it to capture committed concrete owner history and resolve ordinal rollback targets, checking `runtime.read()` health before touching concrete history. It exits observe before dispatching the canonical rollback; intervening actions fail exact-head checks rather than retargeting. Existing runtime APIs, receipts and recovery contracts are unchanged. It is queued before database lookups; observer errors do not fault gameplay or stop its timers. Never re-enter the same runtime queue from an observer. Future Stage 11a must add its agreed minigame-completion gate.

See `docs/history.md` for the in-memory rollback interface and remaining durable work. Checkpoint recovery and owner rollback are separate operations.

All snapshots, receipts, and checkpoints contain private state and are not network payloads. Stage 8 must apply authorized projections and validate external commands before calling this module.
