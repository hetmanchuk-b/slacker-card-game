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

**Use an isolated, disposable database ending in `_test`.** The suite performs DDL, injects an INSERT failure, corrupts its own frames/heads, and terminates client connections in that database. Never point it at a shared application database. CI provisions PostgreSQL 18 separately for Node 24 and 26 on Linux; ordinary Windows/Linux checks do not require Docker.

## Migrations

Run migrations explicitly before opening a durable session:

```sh
DATABASE_URL=postgresql://postgres:penky-local-test@127.0.0.1:55432/penky_test npm run db:migrate
```

`migrate(pool)` uses one checked-out client and a transaction-scoped advisory lock. Applied SQL is recorded with a checksum; changing an applied migration is an error. The SQL lives in the root `migrations/` directory, which must accompany a deployed `dist/` build. Both the source CLI and emitted `dist/persistence/cli/migrate.js` resolve that same directory.

The first migration creates:

- `penky_game_heads`: original branch, durable revision and active branch/version.
- `penky_game_frames`: immutable-by-adapter, versioned JSONB frames containing the operation archive, active state snapshot and runtime checkpoint (receipts, controllers and control audit included).
- `penky_schema_migrations`: applied migration checksums.

These are private storage records, not public projections. Checksums detect accidental corruption, not a malicious database administrator.

## Runtime use

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

Each session holds one PostgreSQL advisory lock on a dedicated connection until `close()`. A second writer is refused. A lost connection is not silently reconnected under the old lease. Any failed/ambiguous commit faults the runtime: stop it, discard its draft, and reopen from storage. If COMMIT succeeded but its response was lost, the persisted receipt permits an idempotent client retry after recovery.

Graceful shutdown order: checkpoint if the runtime is healthy, await `runtime.dispose()`, await `session.close()`, then close the pool. `dispose()` cancels callbacks but intentionally does not make a new save. Size the pool for the number of active games plus migration/read capacity, set connection/statement timeouts for the deployment, and attach a redacted pool error handler.

## Recovery and current limits

Recovery normally loads an integrity-checked materialized history cache (branch states, ancestry, ownership, fork receipts and closure), validates its binding to the archive prefix, and replays only the operation tail. Cacheless legacy frames fall back to full archive replay. `PostgresSession.open(pool, gameId, rootBranchId, { recovery: 'replay' })` explicitly selects the independent full-replay path for auditing. Both paths verify the active snapshot/head and produce identical state/indexes in tests. They do not rerun shuffle/reinsertion randomness. Checkpoint timer behavior is described in `runtime.md`. A host can periodically call `runtime.checkpoint()` to bound the unsaved idle interval; there is no running host/heartbeat application yet.

Versioned caches include an archive-prefix digest, a materialized-data digest and invariant/index checks. These are corruption checks over private server-produced data, not permission to accept browser snapshots. Incompatible archive/state/cache contracts must change their schema versions; do not silently reinterpret old records.

Every successful queue job currently stores a full self-contained frame, including the materialized cache. Frame compaction/retention and storage-volume profiling remain work before release; do not silently delete abandoned gameplay branches.

Lobby-scoped chat retention, authenticated ownership binding, and an atomic actual-next-match/lobby transition are not implemented. Stage 8 must also validate user text against JSONB encoding limits (no NUL or unpaired Unicode surrogates) before it reaches the trusted runtime. The persisted `closeForNextMatch()` guard alone does not create a new match. Stage 11a must additionally enforce minigame completion.

## Verification and dependency audit

Integration coverage uses real PostgreSQL: fresh-session and separate-process recovery, immutable revision reads, writer exclusion, rollback branches/audit, exact timers, deadline/controller recovery, finished-match closure, recorded random outcomes, INSERT failure atomicity, connection loss, revision conflicts and corruption rejection.

`npm audit --omit=dev` reports no runtime dependency vulnerabilities at verification time. Full `npm audit` currently reports a pre-existing development-toolchain advisory through `picomatch`/`tinyglobby`/`typescript-eslint`; its suggested forced downgrade would change the established lint toolchain. No forced dependency downgrade was applied. Review this separately before release; it does not justify exposing this unfinished application to untrusted traffic.
