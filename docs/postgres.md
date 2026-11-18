# PostgreSQL persistence — Stage 7

## Local disposable database

Requires Docker Engine/Compose and Node 24+. This configuration is **test-only**, binds to localhost, uses a public fixture password, and keeps data on tmpfs. Stopping it destroys the test data. It is not a production deployment.

```sh
npm ci
npm run db:test:up
PENKY_TEST_DATABASE_URL=postgresql://postgres:penky-local-test@127.0.0.1:55432/penky_test npm run test:postgres
npm run db:test:down
```

PowerShell environment setup:

```powershell
$env:PENKY_TEST_DATABASE_URL = 'postgresql://postgres:penky-local-test@127.0.0.1:55432/penky_test'
npm run test:postgres
```

`npm test` runs the PostgreSQL suite only when `PENKY_TEST_DATABASE_URL` is set; otherwise that suite is explicitly skipped. `npm run test:postgres` fails if the variable is missing. With the variable set, `npm run check` includes all integration scenarios.

**Use an isolated, disposable database ending in `_test`.** The suite performs DDL, injects an INSERT failure, corrupts its own frames/heads, and terminates its own writer connections in that database. Never point it at a shared application database. CI provisions PostgreSQL 18 on Linux; ordinary Windows/Linux checks do not require Docker.

## Migrations

Run migrations explicitly before opening a durable session:

```sh
DATABASE_URL=postgresql://postgres:penky-local-test@127.0.0.1:55432/penky_test npm run db:migrate
```

`migrate(pool)` uses one checked-out client and a transaction-scoped advisory lock. Applied SQL is recorded with a checksum; changing an applied migration is an error. The SQL lives in the root `migrations/` directory, which must accompany a deployed `dist/` build. Both the source CLI and emitted `dist/persistence/cli/migrate.js` resolve that same directory.

The migration runner and first migration create:

- `penky_game_heads`: original branch, durable revision and active branch/version.
- `penky_game_frames`: immutable-by-adapter, versioned JSONB frames containing the operation archive, active state snapshot and runtime checkpoint (receipts, controllers and control audit included).
- `penky_schema_migrations`: applied migration checksums.

`002_lobbies.sql` adds `penky_lobbies` (durable owner binding/current game), `penky_lobby_chat` (append-only original messages with context/sequence) and `penky_match_starts` (idempotent start receipts).

`003_guest_access.sql` adds hash-only guest credentials with stable identities/expiry/revocation and retained lobby memberships constrained to eight unique clockwise seats. It does not fabricate credentials for old trusted lobby owner strings or change private game frame formats. Authenticated match transitions recheck the durable ordered roster under the lobby lock, rejecting stale preparation. Existing applied migration files remain unchanged. See `guest-access.md`.

These are private storage records, not public projections. Checksums detect accidental corruption, not a malicious database administrator.

## Runtime use

Stage 8.7 adds `PostgresGameHost` as the local owner of leased runtime lifecycles, current-lobby routing and aggregate trusted presence; see `game-host.md`. It performs existing-game-only metadata lookup and checkpoint restoration, respects writer refusal without automatic retry, and adopts only atomically committed successors. The lower-level library seam remains:

After host-owned IDs, authenticated connected seats, and a configured `pg` pool are available:

```ts
const session = await PostgresSession.open(pool, gameId, rootBranchId);
const options = {
  ...systemInputs(reportRedactedError),
  history: session.history,
  connectedSeatIds,
  commit: session.commit,
};
const checkpoint = session.checkpoint;
const runtime = checkpoint
  ? await GameRuntime.restore(options, checkpoint)
  : await GameRuntime.create(options);
```

Always restore an existing checkpoint; calling `create` instead would discard its receipts/control metadata. Restoration does not assume old sockets are alive. The host must authenticate reconnects before reporting live presence. Storage does not authenticate browser/session identities.

Only one runtime may mutate a session's private `history`. Do not mutate it directly once the runtime is active, or publish its in-flight draft. The public `runtime.read()` remains at the last successfully committed view while a save is pending.

One queue job stages engine actions, suspension/reconciliation, receipt and control changes. The awaited commit stores the complete frame and updates the head with optimistic revision checking in one transaction. Only then does the runtime publish state/acknowledge. Initial scheduling also waits for commit. Deadline-driven and control-only changes use the same persistence path. Obsolete callbacks do not save after disposal.

Each session holds one PostgreSQL advisory lock on a dedicated connection until `close()`. A second writer is refused. A lost connection is not silently reconnected under the old lease. After a faulted session destroys its connection, the server may release its advisory lock slightly later than local close completion. Recovery must respect writer refusal, never force a second writer; a bounded acquisition retry may handle teardown, but other integrity/storage errors must not be retried as lock contention. Any failed/ambiguous commit faults the runtime: stop it, discard its draft, and reopen from storage. If COMMIT succeeded but its response was lost, the persisted receipt permits an idempotent client retry after recovery.

Graceful shutdown order: checkpoint if the runtime is healthy, await `runtime.dispose()`, await `session.close()`, then close the pool. `dispose()` cancels callbacks but intentionally does not make a new save. Size the pool for the number of active games plus migration/read capacity, set connection/statement timeouts for the deployment, and attach a redacted pool error handler.

## Recovery and current limits

Recovery normally loads an integrity-checked materialized history cache (branch states, ancestry, ownership, fork receipts and closure), validates its binding to the archive prefix, and replays only the operation tail. Cacheless legacy frames fall back to full archive replay. `PostgresSession.open(pool, gameId, rootBranchId, { recovery: 'replay' })` explicitly selects the independent full-replay path for auditing. Both paths verify the active snapshot/head and produce identical state/indexes in tests. They do not rerun shuffle/reinsertion randomness. Checkpoint timer behavior is described in `runtime.md`. A host can periodically call `runtime.checkpoint()` to bound the unsaved idle interval. The local host library now checkpoints healthy entries on shutdown; there is no running server/heartbeat application yet.

Versioned caches include an archive-prefix digest, a materialized-data digest and invariant/index checks. These are corruption checks over private server-produced data, not permission to accept browser snapshots. Incompatible archive/state/cache contracts must change their schema versions; do not silently reinterpret old records.

Every successful queue job currently stores a full self-contained frame, including the materialized cache. Frame compaction/retention and storage-volume profiling remain work before release; do not silently delete abandoned gameplay branches.

Lobby chat and atomic actual-next-match transitions are implemented; see `lobby-persistence.md`. Persisted owner session IDs are trusted identifiers, not proof of browser authentication. Stage 8.5 now provides the durable credential/membership gate and cookie helpers; existing storage APIs remain trusted internals, not authenticated endpoints. Actual token-to-request/socket binding, current-game participation checks and incoming game/branch routing remain transport work. Chat storage rejects NUL/unpaired Unicode without changing verbatim valid text; Stage 8 must validate all other user text against JSONB limits as well. Stage 11a must add minigame completion to the transition gate before that feature ships.

## Verification and dependency audit

Integration coverage uses real PostgreSQL: fresh-session and separate-process recovery, immutable revision reads, writer exclusion, rollback branches/audit, exact timers, deadline/controller recovery, finished-match closure, recorded random outcomes, INSERT failure atomicity, connection loss, revision conflicts and corruption rejection. A second suite covers retained lobby chat, original author/scope metadata, concurrent retries, actual match handoff/restart, failed preparation/INSERT and rollback/start races. A third covers hash-only guest credentials, durable ownership/membership, concurrent seat allocation, expiration/revocation without seat release, fresh-process authentication, atomic creation failures, join/rollback locking and stale-roster rejection. A fourth covers local host acquisition/lease contention, aggregated connections, durable fault recovery, stale routing, failed detach lookup, deadline failure without external host access, corruption cleanup, nested timers, failed/successful successor adoption and multi-game shutdown failure. Writer-connection fault injection is tagged per game so the suites can run concurrently.

`npm audit --omit=dev` reports no runtime dependency vulnerabilities at verification time. Full `npm audit` currently reports a pre-existing development-toolchain advisory through `picomatch`/`tinyglobby`/`typescript-eslint`; its suggested forced downgrade would change the established lint toolchain. No forced dependency downgrade was applied. Review this separately before release; it does not justify exposing this unfinished application to untrusted traffic.
