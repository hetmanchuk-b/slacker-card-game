# Branch history and rollback — Stage 7

## Interface and scope

Continue at the approved persistence and runtime seams (`docs/architecture.md`). Tests use the real engine, `MemoryHistory`, and `GameRuntime`; only time/randomness are controlled. These branch tests cover integrity, atomic rollback, trusted authorization and timer restoration, not socket authentication or public history redaction. Separate real PostgreSQL coverage now exercises the durable session described in `postgres.md`.

`History.read(branchId?)` reads the active or a retained branch. `rollbackPoint(commandId)` resolves a completed action on the active branch to its private pre-action state and the action's occurrence time. `fork(expectedHead, request)` atomically validates and creates an active child branch at that point, retaining the abandoned future. `branches()` and `audit()` expose detached server-only metadata. `closeRollback()` is the storage hook used by runtime `closeForNextMatch()`; the latter serializes closure with rollback and verifies the match is still finished. Branch versions count the inherited prefix plus new branch actions.

A fork is authorized against the original game's owner seat, using a server-authenticated actor binding. It requires explicit acknowledgment that rollback cannot undo human knowledge. The runtime serializes rollback with gameplay and timeout callbacks; transport authentication remains Stage 8. Technical rejections never trigger gameplay punishment.

The pre-action time is the selected action's timestamp, not the preceding action's timestamp: a ballot submitted four seconds after voting began has a pre-action timer with six seconds remaining. A recorded `clock-rebased` event captures remaining running time at that point and rebases it to the actual rollback time. Already-paused nested timers stay paused. Current socket/controller presence is not restored from the past; the runtime decides whether the restored state must remain suspended.

Rollback is a new administrative operation, not a replay of old randomness. It restores the inherited game state and repetition ledger, including wins/results and pending procedures; it does not count abandoned future occurrences. A successful fork has a persistent-in-adapter audit record usable for an all-player notification. Do not expose the private point/snapshot to the owner UI: Stage 8 must project it without hidden cards.

New branch commands must carry the new branch ID. Old callbacks are invalidated by the runtime generation and head guards. Connection notifications are live facts, not old gameplay commands. The original game creation may also be a target (empty pre-game state), without losing the stored owner binding or releasing the administrative command ID. A rollback targeting an earlier synthetic clock rebase uses that event's captured time, avoiding consumption of the abandoned timeline twice.

## Durable runtime seam (current increment)

Extend the approved persistence/runtime seams with an awaited runtime `commit(checkpoint)` adapter. A complete queue job (including logical suspension, receipts and live control changes) is staged in private history; one database transaction stores its versioned history archive, active-state snapshot, checkpoint and revision. The public runtime view and acknowledgment are published only after commit. Commit failure faults the runtime; discard its draft and recover from storage. Do not schedule gameplay callbacks before the initial durable commit.

`PostgresSession.open(pool, gameId, rootBranchId)` owns one advisory-locked connection per game. It provides the loaded `history`, last `checkpoint`, awaited `commit(checkpoint)` and `close()`. A second writer must be refused. SQL migrations run explicitly through `migrate(pool)`, not silently during game creation. Recovery replays a versioned operation archive, including forks/closure, and checks it against the stored snapshot. Tests cross these public interfaces against real PostgreSQL and `GameRuntime`, not SQL-call mocks. Fault injection is restricted to the test database. Socket authorization and visible owner-history projections remain outside this seam.

## Snapshot-assisted recovery seam

`MemoryHistory.snapshot()` captures a versioned, integrity-checked materialized cache of all branch states and indexes at an operation-archive offset. `restoreSnapshot(archive, cache)` validates the cache and its binding to that archive prefix, restores the prefix without executing its gameplay events, then replays only the operation tail. Full `restore(archive)` remains an independent replay path. Tests compare both paths through existing history/runtime interfaces, including rollback metadata and nested timers; snapshots remain private storage data, never accepted from browsers.

## Durable implementation and remaining work

`MemoryHistory.archive()` records a versioned, replayable operation archive, including forks and irreversible closure. `MemoryHistory.restore()` replays it without fresh randomness and restores ancestry, ownership and deduplication metadata. JSON object key ordering is not command identity: action duplicate checks use structural equality, including after JSONB round-tripping.

`PostgresSession` now persists that archive, the active-state snapshot and runtime checkpoint in one awaited transaction. The in-memory `History` remains a private staging interface; its synchronous append alone is not a durable acknowledgment. `GameRuntime.read()` exposes a detached committed view, never an in-flight storage draft. Failed commits make the runtime unusable until recovered; do not reuse its staged history.

Snapshot-assisted recovery is implemented and verified against full replay, including a snapshot followed by further fork/closure operations. PostgreSQL defaults to that cache path while retaining explicit full replay for audits and fallback for old cacheless frames. Durable lobby chat and actual lobby transitions are now implemented through `PostgresLobby`; start uses queued runtime handoff and one transaction, not the legacy preflight guard. Closure/branch metadata and start receipts survive recovery. Storage compaction/profiling remain release-hardening work. Minigame lifecycle is a later Stage 11a integration. See `postgres.md` for setup, tests and current operational limits.
