# Penky — Implementation Plan

## 1. Purpose and source of truth

Implement a multiplayer card game for 2–8 players using TypeScript and Three.js. Players must be able to attempt specified rule-breaking actions and receive in-game consequences; the client must not silently prevent every illegal move.

Authoritative product documents:

- [Game rules, revision 1.3](docs/game-rules.md)
- [Step-by-step scenarios](docs/game-scenarios.md)

This plan describes implementation, not changes to agreed rules. If implementation reveals an unresolved gameplay decision, record it and obtain agreement before inventing behavior.

### Initial baseline

- Node.js 24+, npm, strict TypeScript, and a minimal test command are configured.
- `src/game/cards.ts` implements deck construction, trump selection, and card comparison.
- `src/game/cards.test.ts` covers deck uniqueness and rank/suit combinations.
- The complete game engine, server, client, durable persistence, and bots are not implemented.

### Progress — increment 19

**New approved direction, documentation only:** rules revision 1.4 adds a post-game little-finger/deck minigame and treats all participants remaining at a repetition draw as losers, preserving earlier winners. The current implementation still follows revision 1.3 for this outcome. No minigame or result changes have been implemented. Resolve §16.5 before implementing the affected behavior; planned work is tracked in Stage 11a below.

- **Stage 1: complete.** Tooling/CI, domain contracts, rule-to-test matrix, and architecture decisions are in place. `.gitattributes` enforces LF on Windows/Linux checkouts.
- **Stage 2: complete for the executable engine.** Creation, replay, invariants, atomic in-memory history, version checks, and duplicate protection are tested.
- **Stage 3: complete for the engine scope.** Dealing-time claims vote immediately, defer punishments correctly, and drain before the first lead. The reveal timer pauses and resumes across queued claims.
- **Stage 4: complete for the agreed engine scope.** Rounds, automatic pickups, stumps, exits, and settled-action repetition work. D001 was approved and resolved: both in-round and boundary cycles draw at the third occurrence.
- **Stage 5: complete for the trusted engine interface.** Scoped claims, FIFO voting, false-claim punishments, timeout abstentions, unanimous withdrawal, deferred-punishment cancellation, and episode-key deduplication are implemented. Binding chat/action references to authoritative evidence remains transport work in Stage 8.
- **Stage 6: complete for the runtime interface.** Serialized dispatch, automatic deadlines, nested timer suspension, multiple absences, replacement voting, controller handover, idempotent receipts, and checkpoint recovery are implemented. Bot decisions remain Stage 10; durable checkpoint storage is implemented in Stage 7.
- **Stage 7: complete for the trusted server/storage interface.** PostgreSQL persists action archives, snapshots, receipts, branch/audit metadata, controllers and timers before publication. Materialized snapshot recovery agrees with full replay. Lobby chat retains immutable author/context metadata across rollback and matches. Actual match handoff validates the observed result head and commits the old rollback closure, new initial frame, lobby pointer and start receipt atomically. Fault/race tests and generated rollback checkpoints cover nested procedures and all supported seat counts. Browser/session authentication, readiness UI and future minigame gating remain their planned later stages.
- **Stage 8: started, authoritative claim submission now implemented.** Increments 8.1–8.11 add private projections, protocol validation, durable guest access/host, guarded gameplay, bounded action/state publication and queued authoritative claim evidence resolution. D002–D004 record approved policies. Admin/chat/start/history routing, canonical retries, rollback-selector resolution and rule-complete external multiplayer flows remain incomplete.
- Verification for increment 19 / Stage 8.11: normal `npm run check` passes **285 non-database tests with five explicit PostgreSQL suite skips**; database-enabled `npm run check` passes **396 checks / no skips**; `npm run test:postgres` passes **111 checks / no skips** on a newly created disposable tmpfs PostgreSQL 18 container. Eight new unit tests cover queued claim resolution/retries/failures and evidence scopes/provenance; eight new TLS/PostgreSQL scenarios cover external claims, recovery, scopes and queued credential/liveness rejection. Independent read-only review approved with no confirmed defects. The verified 8.10 baseline was committed/pushed as `ea7e185` before this increment. No rule, dependency, protocol DTO or persistence-format changes.
- **Stages 9–12 (including 11a): not started.** A bounded TLS session/presence/resync component exists; no browser application or externally playable game is claimed.
- Verification for increment 18 / Stage 8.10: `npm run check` passes **277 non-database tests with 5 explicit PostgreSQL suite skips**; the database-enabled gate passes **380 checks / no skips**. `npm run test:postgres` passes all **103 database checks** on a newly created disposable tmpfs PostgreSQL 18 container. New coverage is four outbound unit tests, two host lifecycle scenarios and eleven TLS/PostgreSQL stream scenarios, including 2/4/8 privacy, exact multi-action jobs, replay suppression, invalidation, replacement baselines and backpressure. Independent review found resync resetting a socket rate bucket through rotated stream IDs; a failing regression reproduced it, the lifetime-stable key fixed it, and follow-up approved. No new dependencies or engine/runtime/persistence/protocol DTO formats changed. Existing 8.8–8.9 work was committed and pushed as `c933dd5` before starting, as requested. No browser UI, complete external match or reliable/exactly-once delivery is claimed.
- Full deterministic engine matches for every seat count from 2 through 8 finish and replay identically in `src/game/match.test.ts`. The formerly looping 5-seat match now draws. This is engine integration coverage, not browser/online coverage.
- Red/green checks cover the engine behaviors plus runtime scheduling, logical clock suspension, presence reconciliation, bot-replacement control, checkpoint restoration, recovery-metadata validation, and native system adapters.
- Increment 1 was committed and pushed as `17d2c96` before increment 2 work began.
- See `docs/architecture.md`, `docs/history.md`, `docs/postgres.md`, `docs/lobby-persistence.md`, `docs/rule-test-matrix.md`, and `README.md` for current interfaces, scope, and commands.

**Dependency clarification:** Stage 3 originally depended on the claim handlers assigned to Stage 5. That cross-stage integration is now implemented and tested with real procedures, not placeholder handlers. Milestones A (engine) and B (recoverable runtime/storage) are complete for the trusted server interfaces. Functional online play begins with Stage 8.

### Execution rules

- Execute the stages in dependency order; finish the exit criteria before moving on.
- For each behavior, add a failing test, implement the smallest complete slice, then refactor.
- Test through module interfaces rather than coupling tests to private implementation details.
- Keep stage status, verification commands, and unresolved decisions in this file as work progresses.
- Do not build 3D gameplay before the same behavior works on the functional multiplayer table.
- Ship history and rollback as core capabilities, not a post-release addition.

## 2. Target architecture

### Proposed stack

- **Shared logic:** strict TypeScript, immutable domain values, explicit commands and events.
- **Server:** Node.js + Socket.IO, one serialized command processor per game.
- **Client:** React + Vite for lobby, chat, procedures, and history; Three.js for the table.
- **Persistence:** PostgreSQL for game metadata, event branches, snapshots, and chat. Start with an in-memory adapter for tests; finalize the database driver in Stage 1.
- **Testing:** existing Node test runner for engine tests, property-based testing for invariants, Playwright for browser scenarios.

No accounts, matchmaking, voice chat, microservices, or complex bot intelligence are required for the first complete version. Stable guest sessions must still authenticate seat ownership and owner privileges.

### Module seams

| Module | Responsibility | Must not own |
| --- | --- | --- |
| Game engine | Deterministic rules, procedures, results, repetition state | Sockets, database calls, React, Three.js |
| Game runtime | Command ordering, clock, randomness, persistence coordination | Rendering or independent rule decisions |
| Projections | Per-viewer game state and redacted history | Hidden information disclosure through generic serialization |
| Persistence | Atomic event append, snapshots, branches, recovery | Gameplay decisions |
| Transport | Session identity, validation, delivery, resynchronization | Trusting client-supplied seat or owner identities |
| Bot | Decisions from a seat's permitted observations | Full authoritative game state |
| Client | Input, presentation, animation, local interaction state | Authoritative legality, timers, or random outcomes |

Keep these modules deep: a small interface should hide sequencing, privacy, and recovery complexity from callers.

### Suggested repository shape

Adapt the existing layout incrementally; do not reorganize working card logic without a concrete need.

```text
src/
  game/          # Cards, commands, events, state, rules, procedures, tests
  projections/   # Player views, owner history, protocol-safe data
  runtime/       # Command processor, clock, randomness, pause orchestration
  persistence/   # In-memory and PostgreSQL adapters, migrations
  protocol/      # Runtime schemas and shared transport contracts
  server/        # Sessions, rooms, Socket.IO handlers
  bot/           # Observation memory and legal strategy
  client/        # React application and Three.js table
tests/           # Integration, property-based, and browser tests
docs/            # Rules, scenarios, architecture decisions, operations
```

## Stage 1 — Foundation and executable rule map

**Depends on:** existing baseline.

- [x] Re-run the existing tests and TypeScript checks; preserve their coverage.
- [x] Add consistent formatting, linting, build commands, and continuous integration.
- [x] Create a rule-to-test matrix referencing the numbered specification sections and all 19 scenarios.
- [x] Define stable identifiers for cards, seats, games, commands, events, claims, procedures, and history branches.
- [x] Define discriminated state types for dealing, last-card reveal, pre-game penalties, between-round play, active rounds, and finished games.
- [x] Model disconnect suspension separately from the underlying gameplay procedure; do not flatten all pauses into one flag.
- [x] Define the engine interface: command decision, event application, and invariant validation.
- [x] Define injected clock/randomness inputs. Production randomness must use a suitable server-side source; tests use controlled outcomes.
- [x] Record the storage and guest-session decisions, including secure reconnect and lobby ownership.

**Exit criteria:** the baseline remains green; domain types and the test matrix cover every agreed rule without importing rendering or transport dependencies.

## Stage 2 — Deterministic events and replay skeleton

**Depends on:** Stage 1.

- [x] Implement command results that distinguish accepted play, accepted rule-breaking attempts, and rejected malformed/unauthorized input.
- [x] Implement event application without consulting wall-clock time, sockets, or fresh randomness.
- [x] Record random outcomes in events, including shuffle order, initial recipient, and random reinsertion positions.
- [x] Represent a command's resulting event batch as one atomic decision; internal events must not become arbitrary rollback points.
- [x] Add branch/version metadata and replay fixtures using the in-memory persistence adapter.
- [x] Implement card-conservation and structural state invariants.

**Exit criteria:** replaying the same committed event sequence produces the same state; invalid transport-like commands cannot become arbitrary penalties.

## Stage 3 — Dealing and initial trump reveal

**Depends on:** Stage 2.

- [x] Implement random first recipient and clockwise one-card dealing.
- [x] Deal two face-down stumps per seat over two full passes, then distribute all remaining cards to hands.
- [x] Make deck click and drag represent the same draw command; input handling comes later.
- [x] For out-of-order draws, return the card to a recorded random deck position, preserve the correct recipient, and queue a penalty.
- [x] Support claims during dealing and defer resulting penalties until before the first round.
- [x] Implement the 10-second final-card reveal, trump/no-trump selection, and last-recipient first move.
- [x] Complete all pending-procedure integration before the first lead, including dealing claims and deferred punishments.
- [x] Test every player count from 2 through 8, including uneven hand distributions.

**Exit criteria:** scenario 1 and the dealing parts of scenario 12 pass; all 36 cards are accounted for; no persistent draw-turn or trump hint is required.

## Stage 4 — Rounds, stumps, exits, and results

**Depends on:** Stage 3; use explicit test fixtures for procedures not implemented until Stage 5.

- [x] Implement lead, beat-top, and take-bottom commands.
- [x] Fix the round target N at round start; count table cards, not turns or seat rotations.
- [x] End a round on N table cards or an empty table; select the correct next leader.
- [x] Keep empty-handed seats in the round and perform the specified automatic bottom pickup when they have no stump-opening entitlement.
- [x] Model one-use stump-opening entitlement across the between-round period and following round.
- [x] Preserve unused entitlement while the hand is temporarily nonempty; expire/renew it at the correct round transition.
- [x] Allow entitled opening outside the owner's turn without blocking other players from starting the round.
- [x] Require opening before the entitled empty-handed player's action; produce a violation for taking instead.
- [x] Implement premature own-stump peeking as private knowledge plus a violation, without moving the card to the hand.
- [x] Finalize exits only at round end; support one loser and simultaneous all-player victory.
- [x] Implement canonical settled-action state comparison and threefold repetition, preserving previous winners.
- [x] Exclude hand order, timestamps, chat, and event/round identifiers from repetition equality.
- [x] Resolve D001: detect repetition inside a round as well as between rounds, after all automatic consequences settle.

**Exit criteria:** scenarios 2–10, 15, and 16 pass; the six-round cycle draws at its third state occurrence, not merely after three similar clicks.

## Stage 5 — Claims, voting, withdrawal, and penalties

**Depends on:** Stage 4.

- [x] Implement all automatic violations and their exact rollback-of-action/turn consequences.
- [x] Implement round, dealing, and between-round claim scopes with server-ordered deadlines.
- [x] Queue accepted claims sequentially; drain them before ordinary play resumes.
- [x] Link technical incidents to action IDs and chat incidents to message IDs; do not attempt to infer identical spoken incidents from arbitrary text. Resolve referenced evidence and authenticate authors in Stage 8.
- [x] Implement voting by all participants except the accused, including the claimant.
- [x] Apply 10-second timeout abstention, majority among yes/no votes, and no-punishment ties.
- [x] Implement unanimous withdrawal with a separate 10-second procedure that suspends/resumes the original vote.
- [x] Implement penalty contribution or refusal with a 10-second timer; never transfer a contributor's last hand card or a stump.
- [x] Treat zero-card penalties as completed, not pending forever.
- [x] Restore the interrupted turn after penalties using the updated hands, not stale pre-penalty assumptions.
- [x] Ensure one incident is punished once, while distinct repeated illegal attempts remain punishable.

**Exit criteria:** scenarios 9–12 and 14 pass; voting outcomes, claim scope transitions, and empty penalties have explicit tests.

## Stage 6 — Server clock, pauses, and connection lifecycle

**Depends on:** Stage 5.

- [x] Introduce runtime scheduling with fake-clock tests for all deadlines.
- [x] Suspend gameplay timers with their remaining duration on participant disconnection; ignore finished-player/spectator departures.
- [x] Support multiple simultaneous disconnections and preserve the underlying procedure.
- [x] Track the real 30-second absence independently from frozen gameplay timers.
- [x] Allow the separate 10-second bot-replacement vote to run during suspension.
- [x] Cancel replacement when the human returns before replacement; preserve suspension if other causes remain.
- [x] Pause when no human participants remain instead of running a bot-only match.
- [x] Define recovery behavior for runtime restart and export sufficient checkpoint metadata to preserve remaining time. Durable PostgreSQL persistence follows in Stage 7.

**Exit criteria:** scenario 13 passes; nested withdrawal/voting/disconnect pauses resume with the correct remaining time; no timer mutates state outside the serialized processor.

## Stage 7 — Durable history, branches, and owner rollback

**Depends on:** Stage 6; event recording starts in Stage 2.

- [x] Implement PostgreSQL migrations and atomic persistence of command results, events, branch-head versions and runtime metadata. Entire queue jobs commit before acknowledgment/publication.
- [x] Implement versioned snapshot-assisted recovery with integrity/prefix binding, validated branch/index restoration and tail replay. Compare it with independent full replay, including nested timers, empty states, rollback metadata and PostgreSQL revisions.
- [x] Persist branch ancestry and completed-action/pre-action mappings through the versioned operation archive.
- [x] Implement trusted owner-only runtime rollback with target/version validation and a notification record; authenticated all-player delivery remains Stage 8.
- [x] Restore game state, procedures, pending penalties, remaining timers, outcomes, and repetition counts through the in-memory interface.
- [x] Keep live connections/controllers external to restored game state and recompute suspension after rollback.
- [x] Retain abandoned futures as separately identified in-memory branches; exclude abandoned occurrences from the restored repetition ledger.
- [x] Persist retained branches, rollback audit and command receipts durably; verify fresh-process recovery and duplicate delivery.
- [x] Persist lobby-scoped retained chat with immutable authors, exact text, server-derived scope/head, idempotent IDs and pagination; retain it across rollback and matches.
- [x] Invalidate old-branch gameplay deliveries and timer callbacks; cancel obsolete replacement votes.
- [x] Integrate actual next-match creation through `PostgresLobby.startMatch()` and queued runtime handoff. Old rollback closure, successor frame, lobby pointer and start receipt commit together; preparation/transaction failures preserve the last durable old state.
- [x] Persist the administrative rollback audit and require acknowledgment that human knowledge cannot be undone; owner UI remains Stage 9.
- [x] Complete generated rollback coverage: every pre-action point of dealing/procedure fixtures for 2/4/8 seats, plus deterministic sampled checkpoints of complete 2–8-seat matches. Compare full state, exits, rights, repetition, timers, retained branches and snapshot/full replay. Recorded random dealing and reinsertion rollback are covered separately.

**Exit criteria:** scenarios 17–18 pass; restart and rollback recover equivalent authoritative states without deleting history, duplicating cards, or restoring obsolete sockets.

## Stage 8 — Private projections and multiplayer transport

**Depends on:** Stage 7; projection contract work may begin in Stage 1.

### Increment 8.1 — Minimal current-state privacy projections (complete)

- [x] Add `src/projections/game.ts` with an explicit trusted viewer selector and fresh allowlisted output, without changing engine/runtime/persistence contracts.
- [x] Expose only the bound seat's hand faces and opaque own-stump handles; other seats expose status and card counts. Public viewers receive no private cards; finishing or ownership grants no additional visibility.
- [x] Preserve public table order, deck/discard counts and explicit safe phase/result fields. Omit trump, dealing recipient/turn hints, catalog, deck order, closed stump faces, private knowledge, procedure payloads, repetition keys, events and history.
- [x] Verify every seat at 2/4/8 seats, hidden-face substitution, public/finished/owner boundaries, null and mismatched snapshots, safe errors, output isolation and unknown-property exclusion with 11 tests.

This baseline projector's contract remains unchanged. The caller must authenticate the viewer and supply face-independent opaque card IDs. It is not a bot memory or authenticated network endpoint; the broader checklist below remains incomplete.

### Increment 8.2 — Scoped disclosures and redacted procedures/control (complete)

- [x] Record approved D002 policies in the rules and decision workflow: reissue the private initial notice before the first successful draw; hide reveal while suspended and resume remaining time; show illegal peeks only in fresh action responses, never duplicate/reconnect views.
- [x] Add `projectLiveGame` with trusted injected time, explicit claim/withdrawal/penalty and presence/replacement views. Only own ballots/approval/reserved card selection are returned; no raw incident keys, other seats' reserved cards, private peek ledger, control audit or timestamps.
- [x] Add `projectAction` for an exact committed pre/post action pair, with adjacent same-game/branch heads, deterministic replay validation and fixed errors. Observe public draws/play/automatic pickups atomically, even immediate discard; keep open/peek/transfer faces seat-private and omit public historical reveal faces.
- [x] Suppress observations for duplicate deliveries. Keep freshness/durability classification a trusted caller obligation; no delivery ledger, transport, persistence or runtime contract changes are introduced.
- [x] Add 14 action tests and 9 live/runtime integration tests, including 2/4/8-seat notice/draw boundaries, nested timers, private reservations/transfers/timeouts, repeated versus duplicate peeks, invalid action contexts and output isolation.
- [x] Address independent review's prototype-like seat-ID finding with a failing regression and computed own-property response accumulation; `__proto__`, `constructor` and `toString` donors retain final-response transfer observations.

The pure projectors do not establish exactly-once network delivery. Future publication must capture exact per-action pairs after successful commit, not use raw private history or assume a whole runtime job contains one action. Owner history, bot memory and authenticated resync remain separate work.

### Increment 8.3 — Metadata-only owner history (complete)

- [x] Record approved D003: active/abandoned branch history has action/actor/violation/claim/decision metadata only, no card faces or handles even for previously public cards; current seat visibility remains separate.
- [x] Add `projectOwnerHistory` over a narrow trusted committed capture compatible with existing history snapshots, checking immutable original owner even after rollback before game creation. Keep runtime/persistence/live contracts unchanged.
- [x] Project one row per completed action, inherited origin, branch labels and administrative audit. Use branch/action/claim/audit ordinals instead of raw correlated identifiers; omit state previews, private observations, ballots, selections, raw events and extra properties.
- [x] Expose only active/open completed-action rollback selectors pinned to the displayed head. Retained futures are read-only; closure disables every target without deleting history or assuming a head-version change. Future transport must resolve selectors and enforce existing runtime authorization/warning/head/closure checks.
- [x] Add 16 tests for 2/4/8-seat privacy, original-owner boundaries, retained/nested prefixes and rebases, pre-creation rollback, closure/post-result availability, claims/decisions without ballot leakage, private/public card redaction, fixed errors, isolation and recovery equivalence.

These are pure projection APIs, not authenticated endpoints. Committed capture, selector resolution and delivery remain future integration responsibilities; neither raw snapshots nor live observations are owner-history payloads.

### Increment 8.4 — External protocol contracts and runtime validation (complete)

- [x] Define an explicit version-1 browser intent union and fixed server message/error envelopes in `src/protocol`, separate from trusted game/runtime commands and private storage records. No dependencies or existing internal contracts change.
- [x] Decode only exact own data properties, including nested evidence/heads/selectors; reject unknown/system/identity/scope/configuration fields, unsafe numbers, malformed Unicode and bounded-field violations without coercion, value echo or gameplay punishment.
- [x] Preserve exact request/reference IDs, procedure timers, chat text and unresolved evidence. Use ordinal rollback selectors; omit ordinary-play expected-version/turn/legality gates so admitted current out-of-turn attempts remain punishable.
- [x] Build state/action/history envelopes through authorized projectors, select safe command/start acknowledgments and redact chat author sessions. Server-supplied delivery epoch/sequence are separate from action heads; actual ordering/allocation/delivery remains later work.
- [x] Add 9 decoder tests, 5 envelope tests and 4 engine/runtime binding tests. `npm run check` passes with 248 tests and two PostgreSQL suite skips; no network/database/browser verification is claimed.
- [x] Fix independent review's action-reference bound mismatch test-first: existing action command references accept 129–256 code units while new request IDs remain capped at 128; 257-unit references are rejected.

See `docs/protocol.md` for exact shapes, technical limits and caller obligations. A decoded intent is not authorization or a trusted engine command. Session binding, wrong-game routing, evidence/selector resolution, canonical start/chat retry handling, raw transport byte/rate limits and committed publication remain their planned server increments.

### Increment 8.5 — Guest authentication and durable membership (complete)

- [x] Record approved D004 credential/cookie/lifecycle and admission policies. Store only random-token hashes with stable identities, 30-day sliding expiry and revocation; credential loss never releases seats or transfers ownership and has no name/code recovery.
- [x] Add strict host-only Secure/HttpOnly/SameSite=Lax cookie and exact HTTPS-origin helpers. Grants/private bindings are server-only; no HTTP/Socket.IO handlers or insecure cookie mode are introduced.
- [x] Add migration 003 and `PostgresGuestAccess` for atomic owner-first lobby creation, durable immutable guest-to-seat ownership, per-call membership/owner checks, serialized clockwise joins and eight-seat capacity. Existing memberships reconnect during play/full capacity.
- [x] Gate new admission on a locked, validated current durable game revision; unfinished, suspended, pre-creation-rollback and corrupt/unknown games do not admit new seats. Do not insert new lobby seats into old match rosters after rollback.
- [x] Recheck authenticated-lobby roster equality inside the existing atomic start transaction, rejecting stale prepared rosters if a join won first. Preserve legacy trusted lobby APIs and private game frame formats; no legacy credential adoption/backfill.
- [x] Add four unit tests and 13 real PostgreSQL scenarios (plus parent), register the suite in `test:postgres`, and pass normal and database-enabled repository gates against a confirmed disposable target.

`docs/guest-access.md` describes APIs, expiry/cookie refresh, lock order and safe failure behavior. These are not running network endpoints or permanent authorization capabilities. Future handlers must reauthenticate, enforce current-game participation and owner privileges, and integrate revocation/expiry with sockets. Readiness, house rules, spectators, kicks, seat reassignment and host transfer remain deferred.

### Increment 8.6 — Server-private post-commit notifications (complete)

- [x] Add queued live-runtime `subscribe(receive, report?)` with an initial detached baseline and immediate idempotent unsubscribe. Avoid construction callbacks so private successor preparation cannot notify before its actual atomic start commits.
- [x] Notify only after successful publication and deadline arming, with a private final snapshot, instance-local sequence and exact ordered fresh action pairs. Include same-head controls, branch rollback, legacy closure and successful actual handoff; do not replay inherited/recovered/abandoned actions or cached receipts.
- [x] Preserve existing duplicate/rejection/checkpoint persistence behavior while suppressing unchanged notices. Capture new rollback rebases on the child branch; never create independent client publication points inside atomic consequences.
- [x] Isolate synchronous/asynchronous listener and reporter failures; do not await delivery promises, fault committed runtime state, reapply commands or block follow-up queue work. Clone per listener and report only sequence metadata. Disposed/retired runtimes reject new subscriptions and obsolete deadlines do not notify.
- [x] Add 15 fake-clock/engine/history tests, including multiple actions per job, private peek projection/retry/recovery boundaries, rollback/closure/handoff and nonblocking reentrancy. Extend real PostgreSQL commit/failure/recovery tests; pass normal and database-enabled repository gates plus the integration suite on a confirmed disposable target.
- [x] A final verification run exposed asynchronous server-side advisory-lock release after destroying a faulted connection. Bound that integration test's recovery retry to the specific writer-lock refusal; retain all durable/no-draft assertions and fail immediately for any other recovery error. Production persistence behavior is unchanged.

The subscription payload is raw private server data, never a network/bot payload. A host must apply authorized projections, bound/order async delivery, allocate transport epochs and capture any extra history synchronously before awaiting. No reliable outbox, socket server, host registry or new persistence format is introduced. See `docs/runtime.md`.

### Verified handoff — increments 8.5–8.6

**Changes included:** `src/server/guest-session.ts` and `guest-access.ts` with their unit/real-PostgreSQL tests; additive migration `003_guest_access.sql`; migration registration, locked roster validation and integration assertions in `src/persistence/postgres.ts` / `postgres.test.ts`; the PostgreSQL suite runner; `src/runtime/runtime.ts` committed subscriptions and `notifications.test.ts`. Documentation updates cover guest access, runtime, architecture, history/lobby persistence, protocol, PostgreSQL operations, D004, README and rule-to-test coverage. No dependency, engine-rule, existing runtime-options, checkpoint or game-frame format changes were introduced.

| Executed verification | Final verified result |
| --- | --- |
| Guest credential/cookie/origin tests | 4 passing |
| Committed-publication tests | 15 passing |
| `npm run check` without a database | 267 passing, 3 PostgreSQL suites explicitly skipped; format/lint/types/build pass |
| `npm run test:postgres` on confirmed disposable tmpfs PostgreSQL | 40 passing, no skips |
| `npm run check` with that database | 307 passing, no skips; format/lint/types/build pass |
| Independent reviews | Both increments approved; targeted follow-up approved the bounded test-only lease-release retry |
| `git diff --check` | Passing |

One intermediate final-gate attempt failed because immediate recovery raced server-side advisory-lock release after faulted socket destruction. The test now retries only that specific refusal with a deadline, without weakening notification/durability assertions or changing production behavior. Focused PostgreSQL tests and all final gates subsequently passed. The disposable container was removed. Browser cookie/TLS, HTTP/Socket.IO, isolated online clients and manual multiplayer play were **not tested**; dependency audits were not rerun.

**Unresolved integration work / risks (not completed by these increments):**

- Stage 8.7 now owns one live runtime/writer per game, recovers faulted drafts from durable state, respects temporary writer refusal, routes the current lobby match and consolidates multiple live connections per seat. Actual socket adapters must use this ownership path, never force a second writer or reuse a failed prepared handoff runtime.
- Stages 8.8–8.9 now enforce TLS/origin/cookie membership/current-participation checks for session/resync and the bounded gameplay subset, including queued credential/socket/controller admission. Deferred claim/admin/chat/start operations still need their own binding and owner/evidence/selector checks; decoding alone is not authorization.
- Publication remains best-effort, not a reliable outbox. Stage 8.10 now provides bounded/ordered authorized action/state delivery, fresh stream epochs, stale-branch/writer invalidation and state-only resync/recovery. Never serialize raw notices or replay one-time observations after uncertain delivery; future owner-history capture still must be committed and synchronous before awaiting.
- Canonical creation/chat/start retry orchestration, original-scope evidence validation and fresh ordinal rollback-selector resolution remain later queued integrations. Decoder validity or a cached binding alone is not authorization.
- Legacy trusted lobbies deliberately have no automatic credential adoption/backfill; credential loss deliberately retains seats and has no recovery/owner transfer under approved D004. Any future migration/recovery feature requires separate approval, not an implicit fallback.
- Revision 1.4 outcome/minigame work and remaining §16.5 decisions stay in Stage 11a; bot observation memory/rollback treatment stays in Stage 10. D001–D004 are resolved, not outstanding decisions. Current dependency audit results are documented in `docs/postgres.md`.

**Stage 8 remains incomplete:** isolated 2/4/8 TLS clients now drive bounded card interactions with private live/action delivery, resync and duplicate protection. Full claim/admin/chat/start/history flows and rule-complete external matches/browser verification remain unmet.

### Increment 8.7 — Single-runtime durable game host/registry (complete)

- [x] Add `PostgresGameHost` with serialized existing-game-only acquisition/restoration and fixed writer-unavailable failures. Reuse existing leases/checkpoints; never fabricate missing games, steal locks or retry integrity faults automatically.
- [x] Resolve durable current-lobby routing, reject old-game intents/stale attachment bindings, and assign a fresh epoch per writer lifetime. Expose only private callback/snapshot seams, not network payloads.
- [x] Aggregate trusted authenticated connections per seat with idempotent detach handles. Only aggregate transitions reach the runtime; lobby-only members do not enter old match rosters. Reconcile surviving live connections after recovery/successor adoption.
- [x] Dispose failed drafts and release leased sessions after dispatch/deadline faults. Wrap settled clock tasks because runtime expiry failures are consumed internally. Preserve receipts/nested timers and do not replay commands or private action observations. Evict stale connected views after failed detach lookup; epoch-check late cleanup.
- [x] Adopt only a successfully committed `PostgresLobby.startMatch` successor without reopening its writer. Failed handoff/preparation is discarded and later restored from unchanged durable state. Canonical browser retry orchestration remains deferred.
- [x] Drain queued work on shutdown, checkpoint healthy entries, and dispose/close all entries even when one checkpoint fails. No heartbeat, idle eviction, distributed execution or new runtime/storage contracts are added.
- [x] Add 14 real PostgreSQL scenarios plus parent and register them in `test:postgres`. Verify acquisition/lease contention, connection aggregation, stale routing, receipts/baselines, faults/corruption, post-restore presence failure, nested timers, failed/successful successor adoption and multi-game shutdown failure. Both repository gates and all 55 PostgreSQL checks pass on a confirmed disposable tmpfs container.
- [x] Independent review identified two confirmed fault-path defects; failing regressions reproduced both, minimal fixes passed, and a bounded follow-up approved the result. See `docs/game-host.md` and `docs/rule-test-matrix.md`.

The host is a private local library, not a running server or authorization boundary. Lifecycle callbacks are serialized across lobbies and must remain bounded/non-reentrant; no asynchronous network delivery is awaited here. At the 8.7 boundary, credential expiry/revocation integration, origin/byte/rate limits and authenticated transport were still incomplete; Stage 8.8 below adds only the approved session/presence/resync slice. Projected live delivery and authenticated evidence/selector resolution remain incomplete. Stage 8's full isolated-client exit criteria are still unmet.

### Increment 8.8 — Authenticated TLS session/presence/private-resync boundary (complete)

**Approved bounded scope:** the operator explicitly approved HTTPS guest session lifecycle, authenticated Socket.IO attachment/presence/private current-state resync, initial expiry/revocation/byte/rate limits and additions of runtime `socket.io` plus test-only `socket.io-client`. Gameplay/live publication/chat/start/history/lobby admission endpoints and UI were excluded.

- [x] Add instantiable `PenkyTransport` with real TLS, exact HTTPS-origin checks on HTTP/polling/upgrades, cookie-only credentials and empty-body issue/refresh/revoke endpoints. Commit before Set-Cookie; return no token/session/seat JSON. No insecure mode, proxy trust, account/recovery workflow or application CLI.
- [x] Accept only existing version-1 `resync` intent on `client-message`; send only authorized state/fixed-error envelopes to that socket. Reauthenticate membership and actual current roster; no implicit spectator/owner escalation, ordinary gameplay dispatch or lobby-room broadcast. Use writer/socket baseline epochs and per-socket sequences without claiming reliable delivery.
- [x] Aggregate seat presence through the host. Add optional trusted AbortSignal checks inside queued host attachment before connection insertion/presence; disconnect/revoke/shutdown invalidate pending emissions and drain late cleanup without replaying commands or observations.
- [x] Add server-private non-refreshing `PostgresGuestAccess.inspect` for expiry/revocation scans and final resync validation. Do not extend idle credentials; observe another-tab refresh durably. Local revoke invalidates active/pending peers after commit; external changes are detected by scans/operations, not immediate distributed notification.
- [x] Bound packets/headers, reject binary streams, cap peers/queued work and use bounded fixed-window IP/socket/credential buckets. Apply limits before invalid event/argument responses; no technical failure becomes gameplay punishment.
- [x] Project only after final authentication, inside a fresh runtime observation with no await before synchronous emission. A failing delayed-SQL regression reproduced an expired-reveal disclosure in the earlier ordering; the corrected path sends no expired reveal or one-time private peek replay.
- [x] Add 18 real TLS/Socket.IO/PostgreSQL scenarios plus parent, two limiter unit tests and one queued host cancellation test. Cover 2/4/8 private seats, cookie/origin/forgery, aggregate presence, cancelled-reconnect publication, expiry/revoke, handoff/restart, delayed reveal, nonparticipants/pre-creation rollback, storage cleanup, shutdown, binary/oversize/rate limits. Register the transport suite in `test:postgres`.
- [x] Independent review found two confirmed P1 defects (invalid-event rate bypass and late cancelled reconnect); failing tests reproduced both, minimal fixes passed and follow-up reviews approved the bounded result. `npm run check` passes 269 non-database tests / five explicit suite skips; database-enabled gate passes 344 checks without skips; all 75 PostgreSQL checks pass on a confirmed disposable tmpfs container. Both dependency audits report zero vulnerabilities.

See `docs/transport.md` for exact supported contracts, technical limits, shutdown and external-revocation scan latency. Existing engine/runtime/checkpoint/protocol/storage formats remain unchanged. No browser cookie/UI, complete external gameplay or reliable committed network delivery is claimed. Public deployment, heartbeat/proxy/DoS operations hardening and the functional game remain later work.

### Increment 8.9 — Guarded authenticated gameplay routing and durable acknowledgments (complete)

**Approved bounded scope:** the operator approved the gameplay slice and the additive server-only runtime admission guard before receipt lookup. Supported intent types are draw/play/take/open, penalty response, cast-vote, request-withdrawal, withdrawal-response and the two replacement controls. All claim submission (including spoken), rollback/admin/history, chat/start, live/action publication and UI remain excluded.

- [x] Add optional `DispatchOptions.admit` evaluated in the runtime queue before receipts/rules, over a detached private snapshot. False yields headless `unauthorized`; throw/rejection yields sanitized headless `unavailable`. Neither persists, publishes, changes timers/receipts/state nor faults the runtime. Existing unguarded callers and checkpoint/frame/receipt/result formats are preserved; admitted atomic commits still drain.
- [x] Require an established authenticated resync attachment and fresh membership for every gameplay operation. Route through the durable host; revalidate credentials, socket liveness/expiry, actual roster and human controller inside runtime admission, including before duplicate receipt lookup. Do not trust a cached binding, another tab's presence or client identity/controller fields.
- [x] Construct ten commands explicitly with original request IDs and server-owned actor/controller. Preserve exact game/branch/card/procedure/claim IDs, refusal nulls, votes and approvals; absentSeatId remains only a target. Do not add ordinary-play version/turn/beat/entitlement gates; current punishable attempts still reach the engine.
- [x] Emit only existing allowlisted command acknowledgments after durable dispatch and final authentication, never raw receipts/state/actions/card observations. Suppress delivery to invalid peers without undoing commits. Keep per-runtime ID semantics: concurrent actor-bound retries execute once, changed/cross-seat collisions reject, duplicate heads remain historical and old-branch/abandoned receipts cannot replay.
- [x] Add four runtime admission tests and 15 real TLS/PostgreSQL scenarios. Cover 2/4/8-seat draws/penalties/rounds/peeks, exact procedure and replacement controls, malformed identity/routing, concurrent duplicates/recovery, branch invalidation, queued disconnect/revoke/expiry with retained presence, controller checks before cached receipts, nonparticipant head redaction, admission SQL failure and failed durable gameplay without accepted acknowledgments.
- [x] Independent review identified one confirmed error-taxonomy defect: guard SQL failure became unauthorized. Failing unit/network regressions reproduced it; fixed sanitized error codes preserve unavailable infrastructure failures and runtime health. Follow-up approved. Repository checks pass with 273 non-database tests/five explicit skips and 363 database-enabled checks/no skips; all 90 PostgreSQL checks pass on the confirmed disposable tmpfs container.

`docs/runtime.md`, `docs/transport.md` and the rule/test matrix record admission timing, bounded non-reentrant authorization and supported/excluded operations. Existing 8.8 uncommitted changes are preserved, with no new dependencies. At the 8.9 boundary acknowledgments were not a live publisher; 8.10 below now supplies fresh authorized observations and automatic state updates. Full external rule flows/matches remain unclaimed and Stage 8 remains incomplete.

### Increment 8.10 — Authorized bounded live/action publication (complete)

**Approved bounded scope:** the operator approved server-private host lifecycle subscriptions, automatic rebinding to committed replacements, state-only baselines, ordered fresh action/state delivery, and bounded buffering with disconnect/resync after overflow or uncertain delivery. Existing verified 8.8–8.9 work was committed/pushed as `c933dd5` before implementation, as requested. No deferred incoming endpoint or UI is added.

- [x] Add `PostgresGameHost.subscribe` forwarding private exact runtime publications under writer epochs. Invalidate synchronously before disposal/release, and rebind only live restored/atomically adopted runtimes after presence reconciliation. Initial registration can pin the expected game. Unsubscribe is immediate/idempotent; sync/async listener/reporter failures cannot block commits or fault the host.
- [x] Add non-refreshing `inspectSeat` to reauthorize durable credential/membership/current-game binding for each server-initiated action/state. Automatic publication does not extend idle credential expiry. Check current roster, writer epoch, branch, liveness and expiry again before projection/emission.
- [x] Project exact ordered fresh action pairs followed by each committed final state, including multi-action jobs and same-head control changes. Initial/resync/recovery/successor baselines remain state-only; their authorized emission point discards older queued observations rather than replaying them. Project at emission-time runtime time and hide reveals expired or suspended by a newer same-branch procedure/pause.
- [x] Invalidate private pending work synchronously on resync receipt, branch rollback, handoff, writer release, cancellation/revoke and shutdown. A new stream epoch prevents old work returning after asynchronous authorization. Never synthesize observations from receipts/history or retry uncertain private emissions; duplicate acknowledgments remain historical, not state cursors.
- [x] Add `AcknowledgedOutbound`: one in-flight packet with an unpredictable receipt echoed by the Socket.IO client, plus count/byte/frame/timeout caps. Raw capture and wire queues include active work in their budgets. All outgoing messages use the bounded wire slot; network promises never enter authoritative queues. Overflow/timeout/invalid receipt disconnects only that reader; a fresh connection/resync receives state, not missed observations.
- [x] Add four outbound unit tests, two host PostgreSQL cases and eleven real TLS/PostgreSQL stream cases. Verify exact multi-action heads, 2/4/8 private draw streams, peek/transfer privacy, no duplicate/recovery replay, rollback/resync invalidation during auth, successful lifecycle baselines, slow/forged-receipt readers, capture overflow, non-refreshing delivery and rate limits across repeated resync. Trusted full-match test driving now yields between host jobs rather than monopolizing the publication queue.
- [x] Independent review identified a confirmed rate-reset bypass: stream IDs rotated on resync were also rate keys. The new fixed-time repeated-resync test failed before the lifetime-stable socket key fix and passes afterward; bounded follow-up approved. Normal repository gate passes 277 tests/five explicit skips; database-enabled gate passes 380 checks/no skips; all 103 PostgreSQL checks pass on the confirmed disposable tmpfs container.

See `docs/transport.md` for the new `server-message(message, receipt, acknowledge)` signature, receipt timeout, initial queue limits, emission-time privacy and best-effort failure semantics. Host notices remain raw private server data, never browser/bot payloads. No game rules, dependencies, engine/runtime/checkpoint/frame/protocol DTO schemas or reliable outbox are changed. This does not claim browser behavior, complete external matches or finished Stage 8.

### Verified handoff — increment 18 / Stage 8.10

**Historical handoff:** the inventory/verification below records the 8.10 boundary. It was subsequently committed and pushed as `ea7e185` before approved 8.11 implementation.

**Repository state at that handoff:** the verified 8.8–8.9 baseline was committed and pushed to `origin/main` as `c933dd5` before 8.10 began. The 8.10 changes below remain **uncommitted and unpushed**. This handoff is documentation only; it does not start another increment or mark Stage 8 complete.

#### Complete changed-file inventory

The working tree contains 18 changed/new files relative to that baseline. New files are explicitly included here even though ordinary `git diff --stat` omits untracked files.

| Area | Files | Implemented change |
| --- | --- | --- |
| Host lifecycle | `src/server/game-host.ts` | Private subscription, synchronous old-epoch invalidation, committed replacement rebinding and isolated listener/reporter failures |
| Publication authorization | `src/server/guest-access.ts` | Non-refreshing durable seat/membership/current-game inspection |
| Network publisher | `src/server/transport.ts` | Ordered viewer-specific action/state streams, emission-time privacy, generation invalidation, queue/byte bounds, nonce receipts and stable socket rate keys |
| Outbound queue — **new** | `src/server/outbound.ts` | Single in-flight acknowledged emission, prepared emission, bounded buffering, invalidation and fail-closed cleanup |
| Unit tests — **new** | `src/server/outbound.test.ts` | Four tests for bounds, uncertain delivery, prepared-work invalidation and oversized-frame refusal |
| Host integration tests | `src/server/game-host.postgres.test.ts` | Two additional lifecycle/reporter-isolation scenarios |
| TLS/network integration tests | `src/server/transport.postgres.test.ts` | Eleven additional stream/privacy/lifecycle/backpressure scenarios; clients echo receipt nonces and distinguish stream messages from command acknowledgments |
| Trusted test driver | `src/runtime/testing/match.ts` | Accept the public read/dispatch subset so host-mediated fixtures can yield between atomic actions rather than starve delivery |
| Status and coverage | `IMPLEMENTATION_PLAN.md`, `README.md`, `docs/rule-test-matrix.md` | Verified scope, coverage, results and remaining work |
| Contracts and operations | `docs/architecture.md`, `docs/game-host.md`, `docs/guest-access.md`, `docs/postgres.md`, `docs/protocol.md`, `docs/runtime.md`, `docs/transport.md` | Lifecycle, authorization, delivery/receipt contract, limits and recovery/failure semantics |

No package/dependency, migration, engine rule, runtime implementation, checkpoint/frame or version-1 message DTO change is included. The **Socket.IO event contract does change** to `server-message(message, receipt, acknowledge)`; consumers must echo the opaque receipt promptly. This is a transport-consumption receipt, not a gameplay acknowledgment or replay capability.

#### Executed verification

These are the final implementation runs, not estimates or results inferred from a build. The documentation-only handoff update does not claim to rerun them.

| Executed check | Verified result |
| --- | --- |
| `npm run check` without database configuration | **277 passing, 5 explicitly skipped PostgreSQL parent suites**; formatting, lint, strict types and build pass |
| `npm run check` with the disposable database | **380 passing, zero skips**; formatting, lint, strict types and build pass |
| `npm run test:postgres` | **103 passing, zero skips**, including real TLS/Socket.IO clients and PostgreSQL persistence/fault scenarios |
| Independent read-only review | Resync rate-budget bypass confirmed; regression reproduced the failure, lifetime-stable socket key fixed it, and follow-up approved |
| `git diff --check` | Passing after implementation and during this handoff inspection |

The test database was a newly created disposable tmpfs PostgreSQL 18 container; it was removed after final verification. Temporary test logs were also removed. **Browser cookie/UI behavior, manual multiplayer play, complete rule flows through external clients and reliable/exactly-once delivery were not verified.** Dependency audits were not rerun in 8.10; no dependencies changed, and the prior audit result is recorded under 8.8. No additional unresolved blocker was reported by the bounded follow-up review; that is not a production-release certification.

#### Unresolved issues and safe boundaries

- **Stage 8 is incomplete:** all claim submission variants remain disabled until evidence author/scope/active-branch provenance is resolved from server history. Owner-history/rollback selectors, canonical lobby/chat/start retries and their incoming endpoints also remain incomplete. Current tests seed these operations through trusted fixtures where needed.
- **Delivery is deliberately best-effort:** overflow, missing/forged receipt, timeout or uncertain emission disconnects the recipient. Reconnect/resync supplies a state-only baseline; missed peeks and other one-time observations are never replayed. Already observed human knowledge cannot be undone. Client implementations must honor epochs/branches and cannot treat historical command-ack heads as state cursors.
- **Operational bounds require deployment configuration:** authentication/storage operations need bounded PostgreSQL connection/statement timeouts. External revocation includes scan/query latency; writer refusal is respected, not bypassed. Proxy/TLS deployment, global DoS controls, heartbeat/retention/storage profiling and production logging/operations remain hardening work.
- **No functional browser game is claimed:** the receipt-aware browser client, readiness/house-rule UI, complete external matches and browser/manual acceptance remain pending. Bots and polished Three.js stay behind their existing dependencies.
- **Revision 1.4 remains deferred:** the current result implementation follows 1.3; repetition-loser/minigame changes belong to Stage 11a and its unresolved §16.5 decisions. D001–D004 are resolved and are not reopened by this increment.
- **Repository handoff is pending:** 8.10 is verified but not committed/pushed. No next increment has been implemented.

**Next dependency-ready increment:** bounded authoritative evidence resolution and claim submission/admission, using server-owned scope/author/active-branch provenance. Canonical lobby/chat/start retries, owner-history/rollback selector routing and the functional client remain separate incomplete work. Do not start UI, bots or minigame before their approved prerequisites.

### Increment 8.11 — Authoritative evidence resolution and claim submission (complete)

**Approved bounded scope:** the operator approved the additive server-private runtime/host queued resolution seam after Scout investigation identified the race/deadlock and retry-scope constraints. The verified 8.10 baseline was committed/pushed as `ea7e185` first. No chat/admin/start/history endpoint, UI, gameplay rule, dependency, schema, checkpoint/frame/receipt format or protocol DTO change is included.

- [x] Add `GameRuntime.dispatchClaim(request, resolver, options?)`, sharing dispatch queue/admission. Authenticate and validate branches before cached receipt lookup; compare exact original claim identity while retaining persisted canonical scope. Exact accepted retries survive scope advancement/recovery without resolving again; changed/cross-seat collisions reject.
- [x] Supply detached committed active history/ancestry/state to a bounded non-reentrant resolver. Resolve and execute in one queue job; timers/play/rollback cannot overtake SQL evidence lookup. Resolver exceptions yield sanitized headless unavailable with no mutation/receipt/commit/publication/timer change and no runtime fault.
- [x] Add host `submitClaim` and `server/claim-evidence.ts`. Bind spoken current scope, immutable chat authors/original contexts and active/inherited action actors/original scopes. Validate every nested chat ancestry cutoff; reject abandoned/wrong-author/game/lobby/system/unknown evidence without disclosure. Successful lead belongs to its new round; final action retains the old round. Engine scope-open/dedup/procedures remain authoritative.
- [x] Bind existing `submit-claim` explicitly in authenticated TLS transport using membership actor, exact accused/reason/evidence/branch/request IDs and existing admission/final-auth/durable acknowledgment/live projection paths. Invalid provenance is fixed invalid-claim, closed scopes scope-closed and handled incidents incident-already-handled; no technical failure becomes punishment.
- [x] Add four runtime and four evidence unit tests, plus eight TLS/PostgreSQL scenarios. Cover 2/4/8-seat external claim/vote/retry, exact external withdrawal replies, author/action provenance, inherited/abandoned chat/actions, nested fork cutoffs, first/final-action scopes, automatic incidents, closed chat scopes, changed/cross-seat collisions, recovery and queued disconnect/revoke/expiry. The missing runtime API/routing and incorrect first-lead scope were reproduced red before implementation/fix.
- [x] Independent read-only Reviewer approved the bounded production implementation with no confirmed findings. `npm run test:postgres` passes **111 checks/no skips** and database-enabled `npm run check` passes **396 checks/no skips** on a freshly created disposable tmpfs PostgreSQL 18 container. Format/lint/types/tests/build pass. No browser UI/manual multiplayer or complete external match is claimed.

Final normal `npm run check` passes **285 tests with five explicit PostgreSQL suite skips**; `git diff --check` passes. The disposable test container was removed. Stage 8.11 is included in this commit/push handoff at the operator's request; the preceding 8.10 baseline was committed/pushed separately as `ea7e185`. Current interfaces and coverage are recorded in README, runtime/host/transport/protocol/history/lobby/architecture/PostgreSQL docs and the rule/test matrix. Stage 8 remains incomplete. **Next dependency-ready increment:** authenticated metadata-only owner-history delivery and fresh queued ordinal rollback-selector resolution, preserving owner/warning/head/closure checks. Canonical lobby/chat/start retries/endpoints remain separate work; no next increment is started here.

### Remaining Stage 8 work

- [x] Implement separate participant, finished-player/spectator, and owner-history projections (pure APIs; authenticated delivery remains below).
- [ ] Keep hidden card identifiers opaque; never encode suit/rank in public stump/deck handles.
- [ ] Give each seat only its hand and legitimately disclosed observations; remove transient reveal data after its permitted display window.
- [ ] Redact raw events, snapshots, branch previews, error messages, and reconnect payloads, not just the main game view.
- [ ] Implement Socket.IO rooms, acknowledgments, command IDs, runtime validation, and session-to-seat authorization.
- [ ] Make retries idempotent and serialize play, claims, timeouts, rollback, and disconnect events per game.
- [ ] Define stale-command handling: reject wrong-game or obsolete-branch commands, but do not accidentally block a deliberate current out-of-turn attempt that must be punishable (verified for 8.9's ten gameplay intents; deferred claim/admin/chat/start routes still pending).
- [ ] Send versioned state and support full authorized resynchronization after missed messages or refresh.
- [x] Keep local game development single-runtime; prevent simultaneous writers instead of introducing premature distributed execution (durable host in 8.7; authenticated presence/resync integration in 8.8).
- [ ] Add rate limits and payload limits without changing agreed game punishments (8.8's bounds also cover 8.9 gameplay commands; deferred handlers and deployment-wide tuning remain pending).

**Exit criteria:** 2, 4, and 8 isolated clients can drive the same game; duplicate delivery executes once; no unauthorized viewer receives hidden faces or raw authoritative history.

## Stage 9 — Functional browser client

**Depends on:** Stage 8.

- [ ] Build lobby creation/joining, seat identity, owner controls, editable house-rule text, and readiness reset.
- [ ] Build a simple functional table before polished 3D rendering.
- [ ] Implement draw click/drag, hand play, take-bottom, and own-stump click.
- [ ] Permit specified rule-breaking attempts; do not add legality hints that remove the game's observation/memory challenge.
- [ ] Show the private initial-recipient notice and one-time 10-second final-card reveal; omit permanent trump and dealing-turn indicators.
- [ ] Add chat, read-only in-match house rules, accusations, votes, withdrawal, and penalty-card selection/refusal.
- [ ] Add suspension/reconnect and bot-replacement controls.
- [ ] Add a redacted owner timeline, branch labels, rollback target selection, warning, and confirmation.
- [ ] Clear pending local gestures/animations on authoritative rollback or resync.
- [ ] Keep transient visual interaction state separate from server state; do not optimistically expose secrets.

**Exit criteria:** humans can complete full matches, punish violations, replace a disconnected player, and roll back without developer-only tools.

## Stage 10 — Bot with constrained observations

**Depends on:** Stages 8–9; replacement orchestration is implemented in Stage 6.

- [ ] Define a bot observation interface with the same permitted information as its human seat.
- [ ] Transfer only the seat's allowed observation memory, including the initial trump observation when available.
- [ ] Implement simple legal choices for dealing, opening stumps, playing, taking, and penalty contribution/refusal.
- [ ] Make the bot abstain from spoken-rule votes and never initiate spoken-rule accusations.
- [ ] Route bot commands through the same processor, validation, and pause handling as human commands.
- [ ] Return control to a reconnecting human after the current atomic action; cancel obsolete bot work.
- [ ] Verify rollback does not give the bot secret knowledge from abandoned future observations; document the chosen memory treatment consistently with permitted seat knowledge.

**Exit criteria:** bots complete legal turns and replacement/reconnect flows without privileged state access or changing N.

## Stage 11 — Three.js table and interaction polish

**Depends on:** Stage 10 and a complete functional client.

- [ ] Agree on the visual direction and interaction details before building final assets.
- [ ] Render a circular table for 2–8 seats with local-player orientation, private hands, stumps, deck, table stack, and discard pile.
- [ ] Implement raycast selection and drag gestures that reuse the existing command interface.
- [ ] Animate dealing, legal play, rejected card return, bottom pickup, penalty transfer, and discard.
- [ ] Make dealing actors observable without revealing hidden faces or adding forbidden turn hints.
- [ ] Ensure illegal own-stump peeking uses the same deliberate click semantics as the specification, not an unagreed confirmation mechanic.
- [ ] Handle rollback/resync by canceling stale animations and rebuilding from the latest authorized view.
- [ ] Reuse card assets/materials, manage GPU resources, resize correctly, and avoid unnecessary rendering while idle.
- [ ] Preserve accessible HTML controls for chat and procedures; support keyboard alternatives, touch, and reduced motion where practical.

**Exit criteria:** all previously working browser flows still pass; 2-, 4-, and 8-seat layouts are usable without secret leakage, duplicated commands, or animation-driven rules.

## Stage 11a — Post-game deck-strike minigame

**Status:** documented idea only; no implementation authorized by this update.

**Depends on:** the functional online game and Stage 11 for final 3D presentation. Resolve `docs/game-rules.md` §16.5 before implementing unresolved mechanics.

- [x] Confirm card counting: final hand cards plus closed stumps; table/discard cards do not count. This is documentation approval, not implementation.
- [x] Confirm participation and accounting: only winners strike losers; bots do not participate; a miss consumes a strike, while a dodge repeats the attempt without consuming it.
- [x] Confirm player-controlled force, aim, and finger position; accidental dodges come from player movement rather than automatic random displacement.
- [x] Confirm finger holding until struck and skipping the minigame when there are no winners or every winner is a bot.
- [x] Approve initial parameters in rules §16.6: force 1–100, visible force-dependent aim oscillation (amplitude 4–36, frequency 0.8–2.5 Hz, linear interpolation), a normalized 120 × 120 holding square, 500 ms windup, and a final 200 ms holding check.
- [x] Confirm connection/lifecycle rules: wait for a disconnected loser to return; skip the entire remaining current strike series when its striker disconnects; finish the minigame before starting the next match.
- [ ] Confirm striker/target ordering, the no-human-loser case, and any dodge consequences beyond the agreed retry.
- [ ] Agree on hitboxes, boundary handling, input methods, and network timing.
- [x] Confirm that striker disconnection skips the entire remaining current series, not just one attempt.
- [ ] Clarify how disconnect interacts with an already-started strike. Confirm returning from bot control and post-result rollback.
- [ ] Add failing tests before changing outcomes: a repetition draw makes every remaining participant a loser while preserving earlier winners; simultaneous all-player victory creates no loser.
- [ ] Preserve the exact final card layout and distinguish the repetition termination reason from the newly agreed loser outcome; update result contracts, projections, history/replay, and existing draw regressions consistently.
- [ ] Derive each human winner's strike count against each eligible human loser from that loser's final hand-plus-stump count. Include earlier winners; exclude bots.
- [ ] Implement an authoritative post-game procedure with serialized commands and reproducible input/timing outcomes, separate from ordinary card-play turns. Do not introduce random misses or dodges without approval.
- [ ] Implement adjustable strike force with increased miss risk at higher force, using the agreed model.
- [ ] Implement finger holding within the allowed square and accidental dodging. Leaving the square during the strike must be classified as the target's dodge, not the striker's miss.
- [ ] Implement loser-disconnect waiting, disconnected-striker whole-series skipping, no-human-winner minigame skipping, and the next-match gate according to the confirmed rules.
- [ ] Test hit, miss, dodge, force/accuracy behavior, strike accounting, multiple losers, retries, no-human-winner skipping, loser reconnection, striker whole-series skipping, next-match gating, and the agreed rollback behavior.
- [ ] Build a functional minigame UI before final Three.js animation; clearly distinguish hit, miss, and dodge without exposing hidden card identities.
- [ ] Update scenarios, rule-to-test coverage, and shipped-behavior documentation after implementation.

**Exit criteria:** the agreed post-game sequence works after normal losses and repetition losses, uses the confirmed strike counts, and distinguishes misses from dodges authoritatively. No unspecified retry, extra-punishment, or control mechanic is introduced implicitly.

## Stage 12 — End-to-end hardening and release

**Depends on:** Stages 11 and 11a.

- [ ] Automate all documented scenarios through the engine and critical flows through the browser.
- [ ] Add generated command sequences checking conservation of all 36 cards, correct turn ownership, fixed N, and replay determinism.
- [ ] Add adversarial tests for guessed card handles, non-owner rollback, duplicate messages, stale branches, and hidden information in logs/history.
- [ ] Test concurrency: final play vs claim, timeout vs vote, replacement vs reconnect, rollback vs pending commands.
- [ ] Test dropped messages, refresh, process restart, multiple disconnections, timer restoration, and post-result rollback.
- [ ] Run visual checks at 2, 4, and 8 seats on desktop and small screens; profile an 8-seat match.
- [ ] Configure deployment, TLS, database migrations/backups, health checks, and graceful shutdown/recovery.
- [ ] Keep production logs redacted; restrict access to stored private game state and randomness records.
- [ ] Document local setup, test commands, game operations, recovery, and deployment.
- [ ] Complete a manual multiplayer playtest including house rules, deliberate violations, withdrawal, bots, and rollback.

**Exit criteria:** CI is green; the full agreed ruleset is playable online; no known critical privacy, state-integrity, or recovery issue remains.

## 3. Milestones

| Milestone | Completed stages | Demonstrable result |
| --- | --- | --- |
| A — Rules engine | 1–5 | Deterministic game with all core rules and punishments |
| B — Recoverable runtime | 6–7 | Correct timers, durable branches, restart, owner rollback |
| C — Functional online game | 8–10 | Full multiplayer table, chat, history, reconnection, bots |
| D — Three.js game and post-game minigame | 11, 11a | 3D multiplayer presentation and the agreed deck-strike minigame |
| E — Release candidate | 12 | Tested, deployable, observable complete game |

## 4. Completion checklist

- [ ] Every agreed rule has an executable test or a documented manual social-rule check.
- [ ] Every documented scenario is represented in the test matrix.
- [ ] Hidden information remains private in live play, reconnects, logs, and every history branch.
- [ ] Intended illegal actions are possible and receive the agreed consequences.
- [ ] Replay, rollback, random outcomes, timers, and repetition counts behave consistently.
- [ ] Full matches work at every supported seat count, not only 2 and 4.
- [ ] The post-game minigame follows the confirmed strike, dodge, card-count, and multiple-loser rules; revision 1.4 outcomes are covered by tests.
- [ ] Documentation matches shipped behavior; no unapproved gameplay changes were introduced.
