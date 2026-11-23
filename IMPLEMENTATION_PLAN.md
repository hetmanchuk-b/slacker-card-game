# Penky — Implementation Plan

## 1. Purpose and source of truth

Implement a multiplayer card game for 2–8 players using TypeScript and Three.js. Players must be able to attempt specified rule-breaking actions and receive in-game consequences; the client must not silently prevent every illegal move.

Authoritative product documents:

- [Game rules, revision 1.4](docs/game-rules.md) — the approved result/minigame additions remain deferred as documented below; current executable results still follow revision 1.3.
- [Step-by-step scenarios](docs/game-scenarios.md)

This plan describes implementation, not changes to agreed rules. If implementation reveals an unresolved gameplay decision, record it and obtain agreement before inventing behavior.

### Initial baseline

- Node.js 24+, npm, strict TypeScript, and a minimal test command are configured.
- `src/game/cards.ts` implements deck construction, trump selection, and card comparison.
- `src/game/cards.test.ts` covers deck uniqueness and rank/suit combinations.
- The complete game engine, server, client, durable persistence, and bots are not implemented.

### Progress — increment 35

**Documentation audit:** current implementation baseline is `866661d` (9.9). The consolidated 9.5–9.9 handoff, file inventory, outstanding decisions and freshly executed versus recorded checks are under **Current handoff audit — after 9.9** below. This documentation-only audit starts no new increment.

**New approved direction, documentation only:** rules revision 1.4 adds a post-game little-finger/deck minigame and treats all participants remaining at a repetition draw as losers, preserving earlier winners. The current implementation still follows revision 1.3 for this outcome. No minigame or result changes have been implemented. Resolve §16.5 before implementing the affected behavior; planned work is tracked in Stage 11a below.

- **Stage 1: complete.** Tooling/CI, domain contracts, rule-to-test matrix, and architecture decisions are in place. `.gitattributes` enforces LF on Windows/Linux checkouts.
- **Stage 2: complete for the executable engine.** Creation, replay, invariants, atomic in-memory history, version checks, and duplicate protection are tested.
- **Stage 3: complete for the engine scope.** Dealing-time claims vote immediately, defer punishments correctly, and drain before the first lead. The reveal timer pauses and resumes across queued claims.
- **Stage 4: complete for the agreed engine scope.** Rounds, automatic pickups, stumps, exits, and settled-action repetition work. D001 was approved and resolved: both in-round and boundary cycles draw at the third occurrence.
- **Stage 5: complete for the trusted engine interface.** Scoped claims, FIFO voting, false-claim punishments, timeout abstentions, unanimous withdrawal, deferred-punishment cancellation, and episode-key deduplication are implemented. Authenticated chat/action evidence binding is now implemented in Stage 8.11; browser interaction remains later work.
- **Stage 6: complete for the runtime interface.** Serialized dispatch, automatic deadlines, nested timer suspension, multiple absences, replacement voting, controller handover, idempotent receipts, and checkpoint recovery are implemented. Bot decisions remain Stage 10; durable checkpoint storage is implemented in Stage 7.
- **Stage 7: complete for the trusted server/storage interface.** PostgreSQL persists action archives, snapshots, receipts, branch/audit metadata, controllers and timers before publication. Materialized snapshot recovery agrees with full replay. Lobby chat retains immutable author/context metadata across rollback and matches. Actual match handoff validates the observed result head and commits the old rollback closure, new initial frame, lobby pointer and start receipt atomically. Fault/race tests and generated rollback checkpoints cover nested procedures and all supported seat counts. Durable guest/session authentication is now integrated in Stage 8.5/8.8; readiness UI and future minigame gating remain their planned later stages.
- **Stage 8: complete for the approved server/transport scope.** Increments 8.1–8.16 implement the authenticated transport and complete external 2/4/8-seat matches. Audit 8.17 identified routing/agreements prerequisites; approved D005 now accepts private per-socket delivery and 8.18 implements durable agreement acceptance and atomic new-start gating/reset. `ready` is consent only; epochs do not change per-member, so concurrent confirmations do not conflict. No full browser/product/production completeness is claimed. D001–D005 are resolved for these implemented scopes.
- **Stage 9: complete for the operator-approved automated Chromium matrix (9.1–9.16).** Lobby/agreements, start, dealing and penalty responses now compose with click-based hand play, exactly-bottom pickup and one own-stump control for server-decided opening/peeking. Ordered public table, server round/leader fields and bounded current-action feedback preserve atomic automatic consequences. The approved fresh-peek notice is actor-only, dismissible and penalty-bound, with no timer/reopen/persistence/replay. Deck/hand drag equivalence is implemented in 9.8; retained chat is implemented in 9.9; claims/voting are verified in 9.10; withdrawal is verified in 9.11; presence/replacement controls are verified in 9.12; owner timeline browsing/selection is verified in 9.13; rollback confirmation/notices are verified in 9.14; current-result/successor UI is verified in 9.15; UI-only 2/4/8-seat acceptance is verified in 9.16. Manual usability, native devices, Firefox/Safari and production certification remain unverified.
- Verification for increment 35 / Stage 9.9: normal `npm run check` **357 pass/seven explicit database skips**; database-enabled gate **539 pass/no skips**; separate Chromium suite **59 pass**. Five new Node tests and four browser cases (three real HTTPS/PG chat flows, one explicit game-denial reply fixture with real chat). Shared-controller attachment change explicitly approved; independent read-only Reviewer found no issues and executed no checks. No authoritative implementation, wire/schema, dependency or game-rule change. Next: 9.10 after agreeing spoken-episode naming/reuse UX.
- Verification for increment 34 / Stage 9.8: normal `npm run check` **352 pass/seven explicit database skips**; database-enabled gate **534 pass/no skips**; separate browser gate **55 pass**. Five new Node gesture tests and six browser cases (two real HTTPS/PG draw/play, four explicitly synthetic game-message fixture cases including Chromium touch and mixed-primary ordering). Reviewer P1 competing-primary cancellation finding reproduced test-first and fixed with blocked contact cohorts/per-pointer click tokens; bounded follow-up approved. No authoritative implementation, wire/schema, dependency or game-rule change. Next: 9.9 only.
- Verification for increment 33 / Stage 9.7: normal `npm run check` **347 pass/seven explicit database skips**; database-enabled check **529 pass/no skips** (347 + 182 database); browser suite **49 pass**. Six new Node tests and seven browser cases: two real HTTPS/PG gameplay integrations plus five explicitly synthetic engine/projector game-message fixture cases covering late scenarios 2–10. Independent read-only Reviewer found no issues and ran no checks. No authoritative implementation, wire/schema, dependency or game-rule change. Next: 9.8 only.
- Verification for increment 32 / Stage 9.6: normal `npm run check` **341 pass/seven explicit database skips**; database-enabled check **523 pass/no skips** (341 + 182 database); separate Chromium/HTTPS/PostgreSQL suite **42 pass**. Nine new Node tests and three real four-seat penalty browser cases. Independent read-only Reviewer found no issues and executed no checks. No dependency, authoritative implementation, wire/schema or game-rule change. Next: 9.7 after agreeing its fresh-peek presentation lifetime/dismissal.
- Verification for increment 31 / Stage 9.5: normal `npm run check` **332 pass/seven explicit database skips**; database-enabled check **514 pass/no skips** (332 + 182 database); separate Chromium/HTTPS/PostgreSQL suite **39 pass**. Six net additional Node tests and four browser cases, including complete 2/4/8-seat dealing, out-of-turn attempts and committed lost draw acknowledgment. Independent read-only Reviewer found no issues; did not execute checks. No dependency, authoritative server, wire/schema or game-rule change. Next: 9.6 only.
- Verification for increment 30 / Stage 9.4: normal `npm run check` **326 pass/seven explicit database skips**; database-enabled check **508 pass/no skips** (326 + 182 database); separate browser gate **35 pass**. Eleven Node tests and six browser cases added, including real WSS first start/retry/reload, missing receipt/lost ack, live pause, actual assigned-null rollback, not-ready/expiry and exact Origin checks. Reviewer enum-coercion P2 fixed test-first; bounded follow-up approved the fix and game/branch-driven stale-agreements invalidation. Existing Socket.IO client promoted dev→runtime at the same version; no new dependency/framework, authoritative implementation, wire/schema/game-rule change. Production dependency audit: zero vulnerabilities.
- Verification for increment 29 / Stage 9.3: normal `npm run check` **315 pass/seven explicit database skips**; database-enabled `npm run check` **497 pass/no skips** (including all 182 existing PostgreSQL cases); separate Chromium/HTTPS/PostgreSQL suite **29 pass**. Seven new Node tests and eleven browser cases. Reviewer found malformed replies hid a recoverable local draft; failing browser regression reproduced it, preserving the old verified snapshot/draft as stale/read-only fixed it. No dependency, existing server business code, wire contract, game rule, migration or authoritative persistence format changed. Dedicated database runner not separately rerun; its cases ran in the database-enabled gate.
- Verification for increment 28 / Stage 9.2: normal `npm run check` **308 pass/seven explicit database skips**; database-enabled `npm run check` **490 pass/no skips** (includes all 182 existing PostgreSQL cases); separate Chromium/HTTPS/PostgreSQL browser gate **18 pass**. Seven new client tests and nine new browser cases. Independent Reviewer found stale native custom validity after creation; browser regression reproduced it, minimal locator-update clearing fixed it, regression and final gates pass. No new dependency, server business code, wire contract, game rule, migration or authoritative persistence format. Dedicated database runner was not separately rerun; its cases ran in the database-enabled gate.
- Verification for increment 27 / Stage 9.1: normal `npm run check` **301 pass/seven explicit database skips**; dedicated `npm run test:postgres` **182 pass/no skips**; database-enabled `npm run check` **483 pass/no skips**; separate real Chromium/HTTPS/PostgreSQL browser gate **nine pass**. Six new Node client tests; existing authoritative server/game/storage source unchanged. Independent read-only Reviewer found no issues (did not independently execute checks). Production dependency audit: **zero vulnerabilities**. Browser matrix/manual assistive-technology/gameplay/production acceptance not claimed.
- Verification for increment 26 / Stage 8.18: normal `npm run check` **295 pass/seven explicit PostgreSQL suite skips**; dedicated `npm run test:postgres` **182 pass/no skips**; database-enabled `npm run check` **477 pass/no skips** on newly created disposable tmpfs PostgreSQL 18. Two protocol tests, one runtime test, four guest database scenarios, three TLS workflow scenarios plus parent and one late-withdrawal TLS scenario added; all existing external matches now explicitly accept through HTTP. Independent read-only Reviewer found no issues. One additive migration and bounded HTTP/start-ack/private handoff extensions; no dependency, engine-state/frame/checkpoint/canonical-receipt format changes.
- Verification for increment 25 / Stage 8.17 (documentation only): freshly rerun normal `npm run check` passes **292 tests/six explicit PostgreSQL suite skips**; database-enabled gate passes **465 tests/no skips**; dedicated `npm run test:postgres` passes **173 checks/no skips** on a newly created disposable tmpfs PostgreSQL 18 container. Independent read-only Scout/Reviewer validated the evidence mapping; Reviewer found no issues and did not execute checks. No code/test behavior, requirement waiver, API, dependency, rule or schema change.
- Verification for increment 24 / Stage 8.16: normal `npm run check` passes **292 tests/six explicit PostgreSQL suite skips**; database-enabled gate passes **465 tests/no skips**; dedicated `npm run test:postgres` passes **173 checks/no skips** on a newly created disposable tmpfs PostgreSQL 18 container. New suite contains three complete 2/4/8-seat scenarios plus parent. Independent review identified three test weaknesses; public-order donor selection, positive actor-only peek assertions and exact rollback prefix/future checks address them, and bounded follow-up approved. Test-only changes; no production API, dependency, rule, schema or persistence format changes.
- Verification for increment 23 / Stage 8.15: normal `npm run check` passes **292 tests/five explicit PostgreSQL suite skips**; database-enabled gate passes **461 tests/no skips**; dedicated `npm run test:postgres` passes **169 checks/no skips** on a newly created disposable tmpfs PostgreSQL 18 container. Two contract tests, two storage and nine TLS/PostgreSQL scenarios added. Independent read-only Reviewer found no issues. Approved additive HTTP contracts and creation mapping migration; no dependency, game-rule, runtime/checkpoint/frame or existing socket DTO changes.
- Verification for increment 22 / Stage 8.14: normal `npm run check` passes **290 tests/five explicit PostgreSQL suite skips**; database-enabled gate passes **448 tests/no skips**; dedicated `npm run test:postgres` passes **158 checks/no skips** on newly created disposable tmpfs PostgreSQL 18. New coverage is one runtime test, two storage/two host PostgreSQL cases and thirteen TLS/PostgreSQL start cases. Independent review reproduced late authorization denial being misclassified unavailable; the downstream adapter now returns false for known denial, preserves infrastructure exceptions, and follow-up approved. Optional private start/handoff admission hooks and bounded existing-result-contract scope were explicitly approved; no dependency, schema, stored-frame/receipt or wire DTO changes.
- Verification for increment 21 / Stage 8.13: normal `npm run check` passes **289 tests/five explicit PostgreSQL suite skips**; database-enabled gate passes **430 checks/no skips**; `npm run test:postgres` passes **141 checks/no skips** on newly created disposable tmpfs PostgreSQL 18. New coverage: two byte-page unit tests, one queued storage-admission scenario, fifteen TLS/PostgreSQL chat scenarios. Independent review found stale history cancellation disconnecting a healthy peer; the regression failed before the cancellation-only suppression fix and passes afterward. Bounded follow-up approved. No dependency, migration, runtime API, persisted format or protocol DTO changes.
- Verification for increment 20 / Stage 8.12: normal `npm run check` passes **287 tests / five explicit PostgreSQL suite skips**; database-enabled gate passes **412 checks / no skips**; `npm run test:postgres` passes **125 checks / no skips** on a newly created disposable tmpfs PostgreSQL 18 container. Independent review found queued history adopting a later resync generation; a real TLS regression reproduced it, receipt-time fencing fixed it, and bounded follow-up approved. No rules, dependencies, runtime API or persistence formats changed; the metadata-only rollback-notice envelope and host integration were explicitly approved.
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

**Status: complete for the approved executable server/transport scope through 8.18.** All current checklist items and the controlled 2/4/8-client exit criteria are satisfied. D005 explicitly resolves the room-routing wording and server agreement-acceptance prerequisite. Browser/UI acceptance belongs to Stage 9; bots and deferred revision-1.4 result/minigame work retain their later dependencies. Historical handoffs below preserve their status at the time.

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

### Increment 8.12 — Authenticated owner-history and rollback routing (complete)

**Approved bounded scope:** the operator approved an additive metadata-only all-participant `rollback-notice` envelope after Scout confirmed existing DTOs could not meet rules §15.2, especially rollback before creation. Current-match metadata history and selector routing use existing runtime observe/dispatch APIs. No historical-game routing, pagination, UI, chat/start endpoint, rule/dependency or persistence-format changes.

- [x] Add host `observeHistory` with detached narrow capture inside a healthy committed runtime observation. Never treat staging `snapshot()`/matching heads as standalone commit proof; preserve same-head closure and failed-draft boundaries. Owner history remains D003 metadata only, without faces/handles/previews/private ballots/events.
- [x] Add host `rollback`: map persisted ordinal branches/completed-action versions to exact canonical heads/action references, preserve original owner/warning/control checks, exit observe before dispatch, and reject intervening changes optimistically. Retained source branches reconstruct accepted retries across nested forks/recovery; new archived/stale selectors never retarget onto active rows. Reuse existing receipts; no new runtime/History/persistence seam or ledger.
- [x] Bind existing `owner-history`/`rollback` intents to one-lobby attachment, fresh durable owner membership/current-game routing and non-refreshing final checks. Mutation admission rechecks socket/expiry/human controller before cached receipts. Finished/pre-creation owners retain metadata access without gaining live card visibility. Prepared history shares frame/queue bounds and receipt-time watch/generation invalidation.
- [x] Add allowlisted ordinal rollback notice projector/builder and committed host sidecar. Fresh authorized participant streams receive actor/target/result before action/state after epoch rotation, including null-state rollback with no action pair. Duplicate/resync/recovery/failure paths never replay notices or observations; raw owner history/audit is never broadcast.
- [x] Add two projection/envelope unit tests, three host PostgreSQL cases and eleven TLS/PostgreSQL scenarios. Cover 2/4/8 privacy/pre-creation notices, owner/nonowner routing, warning/ordinal/head/closure checks, fork/recovery canonical retries, failed durable rollback without staged archive/notice, same-head closure and queued admin disconnect/revoke/expiry. Existing live rollback/resync/private-peek regressions remain green.
- [x] Independent read-only review identified a P2: queued history sampled the generation only when processing began, letting pre-resync requests emit before the new baseline. The new blocked-operation → history → resync regression failed before the receipt-time generation/watch fix and passes afterward. Bounded follow-up approved with no remaining findings.
- [x] Normal `npm run check`: **287 pass/five database parent-suite skips**. Database-enabled `npm run check`: **412 pass/no skips**. `npm run test:postgres`: **125 pass/no skips** on newly created disposable tmpfs PostgreSQL 18. Format/lint/types/build and `git diff --check` pass. No browser/manual full-match or reliable/offline notification guarantee is claimed.

Changed implementation: history projector/tests, protocol contracts/builders/tests, host integration/tests, TLS transport/tests. Documentation: README, plan, architecture, history/runtime/host/protocol/transport/PostgreSQL contracts and rule/test coverage. The disposable container and temporary logs were removed. Stage 8.12 is included in this commit/push handoff at the operator's request. Stage 8 remains incomplete. **Next dependency-ready increment:** bounded authenticated retained-chat submission/history routing with canonical immutable retry binding and original context; lobby admission and canonical start orchestration remain separate work. Stop here; no next increment is implemented.

### Increment 8.13 — Authenticated retained-chat submission and history (complete)

**Approved bounded scope:** the operator approved an optional server-private storage admission hook, durable messageId identity/requestId correlation only, and lobby-membership-only chat without game-state visibility. Existing post/history DTOs and retained records suffice; no new ledger, migration, runtime API, live chat push, UI, lobby/start endpoint or gameplay rule change.

- [x] Add `ChatAdmissionOptions`/sanitized errors to `PostgresLobby.postChat`. Run the bounded non-reentrant guard inside the existing runtime observation (or standalone host queue) before duplicate lookup/insertion. Rejected/failed admission creates no row and leaves gameplay healthy; admitted transactions drain atomically.
- [x] Add host `postChat`/`chatHistory`: select current runtime/context under host serialization, no-game storage only with the existing pointer guard, and queued membership admission for reads/writes. Never nest postChat inside a second runtime observation. Independent chat SQL failure does not fault a healthy game.
- [x] Bind exact author session/seat from durable membership, preserving verbatim text and original scope/head/time. `(lobbyId, messageId)` is canonical immutable identity; changed author/text reuse is fixed unavailable. RequestId only correlates chat-page replies, and can be reused for another new messageId. Exact message retries survive rollback/abandoned provenance, recovery and successor adoption.
- [x] Permit durable members with no match, outside the current roster or without human control to post/page chat after one-lobby attachment. Chat grants no state/action/history subscription or private card/procedure visibility. Recheck actual socket/expiry/membership before queued lookup/insertion and final emission; another live tab cannot authorize departed work.
- [x] Add actual serialized ordered-prefix page bounds using existing redaction/envelopes and acknowledged wire slots. Honor decoded count/cursor bounds, never truncate text/skip rows; an individually oversized trusted row returns fixed unavailable. Final authentication and projection/emission have no intervening await; no network receipt waits inside authoritative queues.
- [x] Add two page unit tests, one storage admission scenario, and fifteen TLS/PostgreSQL scenarios for 2/4/8 exact posting/paging/collisions, no-game/non-roster access, retained branch/recovery/handoff context, byte prefixes/oversized rows, failed INSERT/retry, queued chat disconnect/revoke/expiry and resync cancellation. Existing test-only match drivers now supply current branches when continuing a forked fixture.
- [x] Independent review confirmed a P2: prepared history's obsolete-generation admission denial escaped into wire failure and disconnected a healthy participant. The new held-host → history → resync TLS regression failed before the fix; cancelled work is now discarded only when no longer current, genuine failures remain fail-closed. Follow-up approved with no remaining findings.
- [x] `npm run check`: **289 pass/five explicit database skips**. Database-enabled gate: **430 pass/no skips**. `npm run test:postgres`: **141 pass/no skips** on a freshly created disposable tmpfs PostgreSQL 18 database. Format/lint/types/build and `git diff --check` pass. Browser rendering/cookies, live chat push, manual/full external matches and reliable delivery were not verified or claimed.

Changed implementation: lobby admission/tests, host/transport integration/tests and new bounded chat-page helper/tests. Status/contracts/coverage docs updated. The disposable database/container and temporary test logs were removed. Stage 8.13 is included in this commit/push handoff at the operator's request; Stage 8 remains incomplete. **Next dependency-ready increment:** bounded authenticated canonical match-start orchestration using existing start receipts and atomic handoff, with owner/observed-head/roster validation before generating new server identities. Preserve existing start/readiness boundaries rather than inventing policy; lobby creation/join endpoints remain separate. Stop here; no next increment is implemented.

### Increment 8.14 — Canonical authenticated match-start orchestration (complete)

**Approved bounded scope:** the operator approved additive private start/handoff admission before mutation, existing protocol start intents/acks and durable canonical receipts, while readiness/house-rule/minigame gating, UI and lobby admission endpoints remain explicitly deferred. No policy is invented or marked ready/completed. No new ledger, migration, persisted format, protocol DTO or dependency.

- [x] Add optional `runtime.handoff(..., options.admit)` outside mutation/fault/publication, checking a detached committed snapshot before closure. Denial/failed authorization changes no state/history/closure/receipt/commit/timer or publication and leaves a healthy writer usable.
- [x] Add optional storage start admission before receipt lookup and again at first-match commit admission or queued successor handoff. Dispose denied private preparation without closing the original session. Preserve old transaction-failure eviction/recovery and atomic closure/successor/lobby-pointer/receipt commit.
- [x] Add host `startFromIntent`: fresh durable owner/socket admission before canonical receipt lookup, stable original actor/expected-head comparison and historical retry result before any new configuration. Only genuine new intents validate current pointer/exact finished head or true no-game, owner-first 2–8 membership and then generate opaque game/branch/36-card IDs. Reuse the existing non-enqueuing adoption helper and locked SQL roster equality; never retarget or silently regenerate accepted configuration.
- [x] Bind existing TLS `start-match` with server-owned identity and no client configuration. Reauthorize at host/storage/queued handoff and final bounded acknowledgment emission. Another tab's presence cannot authorize cancelled work. Existing subscribers receive committed state-only successor baselines; no-game clients explicitly resync after their initial start ack. Historical duplicate acknowledgments are not state cursors.
- [x] Add one runtime admission test, two storage cases, two host cases and thirteen TLS/PostgreSQL scenarios. Cover 2/4/8 starts/concurrent same-ID retries, authorization before cached receipt, changed intent, recovery/later successors, exact result/null/stale-branch heads, one-seat/forged roster, rollback-to-null, join/preparation conflict, failed successor transaction/retry and disconnect/revoke/expiry held at lookup/handoff. Existing rollback/handoff races and adoption/fault tests remain green.
- [x] Independent Reviewer found known late denial crossing exception-sanitizing gates as unavailable. Host regression reproduced it at storage/handoff admission; adapter now returns false only for known unauthorized and rethrows infrastructure failure. No receipt/closure/state damage or loss of writer usability. Follow-up approved with no remaining findings.
- [x] Normal `npm run check`: **290 pass/five explicit PostgreSQL suite skips**. Database-enabled gate: **448 pass/no skips**. Dedicated `npm run test:postgres`: **158 pass/no skips**, on newly created disposable tmpfs PostgreSQL 18. Format/lint/types/build and `git diff --check` pass. No browser/manual game, complete external-match/readiness UX, revision-1.4 minigame gating or reliable delivery claim.

Changed code: runtime handoff/tests, lobby start admission/tests, host canonical/adoption integration/tests, transport/tests, and start-ack builder's server-only input type (wire shape unchanged). Relevant status/contracts/test coverage docs updated. The disposable database/container and temporary logs were removed. Stage 8.14 is included in this commit/push handoff at the operator's request; Stage 8 remains incomplete. **Next recommended dependency-ready increment:** bounded authenticated lobby creation/join API and canonical creation retry orchestration, after explicit approval of those currently undeclared external contracts. Readiness/agreements, client UI and complete external-flow verification remain separate work. Stop here; no next increment is implemented.

### Verified handoff — increment 22 / Stage 8.14 (`7446429`)

**Scope of this update:** documentation/reporting only. No new increment, gameplay, API or persistence change is started here. At inspection, the working tree was clean and both HEAD and the locally tracked `origin/main` pointed to `744642971cadb69ccdfec7b511126657b464034f` (`7446429`). Its commit/push succeeded in the preceding task. This additional handoff edit to `IMPLEMENTATION_PLAN.md` is not yet committed/pushed.

#### Complete committed change inventory

`git show --stat 7446429` reports **20 files, 998 insertions and 89 deletions**. The following inventory includes every file in that implementation commit, not just production source:

| Area | Files | Verified change |
| --- | --- | --- |
| Runtime | `src/runtime/runtime.ts`, `src/runtime/handoff.test.ts` | Optional queued handoff admission before closure/mutation; detached committed input; nonmutating denial/sanitized failure and successful reuse |
| Storage | `src/persistence/lobby.ts`, `src/persistence/lobby.postgres.test.ts` | Start admission before receipt lookup and first commit/queued successor; denied preparation cleanup preserves original writer; server-only `MatchStartOutcome` type without wire/storage format change |
| Host | `src/server/game-host.ts`, `src/server/game-host.postgres.test.ts` | Canonical original-intent lookup before configuration, exact actor/expected-head retry binding, current routing/roster checks, shared existing adoption path and denial/error-taxonomy regression |
| Transport | `src/server/transport.ts`, `src/server/transport.postgres.test.ts` | Explicit authenticated start routing, fresh owner/socket admission at lookup and handoff, bounded allowlisted final acknowledgment, 2/4/8 starts/retries, races, cancellations and durable-failure scenarios |
| Protocol builder | `src/protocol/messages.ts` | Start acknowledgment accepts the minimal server-only outcome; serialized version-1 DTO and allowlist remain unchanged |
| Status/coverage | `IMPLEMENTATION_PLAN.md`, `README.md`, `docs/rule-test-matrix.md` | Approved scope, completion criteria, actual test counts, review fix, exclusions and next boundary |
| Contracts/operations | `docs/architecture.md`, `docs/game-host.md`, `docs/guest-access.md`, `docs/lobby-persistence.md`, `docs/postgres.md`, `docs/protocol.md`, `docs/runtime.md`, `docs/transport.md` | Canonical identity/admission ordering, denied-start cleanup, locked-roster race handling, safe acknowledgments/baselines and explicit readiness/minigame deferral |

No dependency/package, migration, engine-rule, persisted frame/checkpoint/receipt or protocol DTO schema change is included. Optional private start/handoff admission and the bounded existing-result start scope were explicitly approved. New test scenarios are **one runtime + two storage + two host + thirteen TLS/PostgreSQL**; existing race/recovery/privacy suites remain part of the gate.

#### Executed verification and review

Database results below are the **recorded implementation runs**, not fresh database runs during this documentation update. The test database was a newly created disposable tmpfs PostgreSQL 18 container, and was removed afterward with temporary test logs. No database/container was running at this handoff inspection.

| Check | Verified result | Provenance |
| --- | --- | --- |
| `npm run check` without database | **290 passed; five PostgreSQL parent suites explicitly skipped**; format/lint/types/build pass | Executed during implementation and **rerun successfully for this documentation handoff** |
| `npm run check` with disposable database | **448 passed, zero skips**; format/lint/types/build pass | Executed for Stage 8.14 implementation, including the final rollback-to-null assertions; not rerun here |
| `npm run test:postgres` | **158 passed, zero skips** | Dedicated real PostgreSQL/TLS implementation run; not rerun here |
| Focused runtime/storage/host/TLS checks | Admission, retry, race and failure regressions passed after implementation/fixes | Executed implementation runs; detailed coverage above and in `docs/rule-test-matrix.md` |
| Independent read-only review | Late denial misclassification confirmed and reproduced; adapter returns false only for known unauthorized, preserves infrastructure exceptions; bounded follow-up approved | Reviewer inspected code/tests; did not independently execute tests |
| `git diff --check` | Passing | Executed during implementation, commit handoff and this documentation update |

The **448** database-enabled tests already include the **290 non-database + 158 database** tests; these are not additive independent coverage counts. Database checks include parent tests and real TLS clients, not browser tests. An initial expected-red storage run timed out after missing admission allowed unexpected starts to leave test resources open; test cleanup was strengthened to close unexpectedly produced runtimes/sessions, and subsequent focused/final gates passed. The independent review's separate `unavailable` versus `unauthorized` regression also failed before its minimal fix and passed afterward. No failed intermediate run is represented as a passing gate.

#### Unresolved issues, deferred work and safe boundaries

- **Stage 8 is still incomplete.** Existing version-1 game/procedure/claim/admin/chat/start routes are bound, but externally authenticated lobby creation/join contracts and canonical creation retries are not defined/implemented. Approve their payloads, identity/retry semantics and public contracts before coding; do not infer a new ledger, recovery mechanism or client-authorized seat/owner binding.
- **Start is intentionally bounded, not the final product workflow.** Readiness/house-rule state, editing/reset rules and final readiness enforcement remain their documented later work. Do not silently mark participants ready. Current starts use approved owner/observed-head/finished-result/roster conditions; first-match clients without subscriptions explicitly resync after the acknowledgment.
- **Revision 1.4 remains unimplemented.** Remaining repetition participants still follow the revision-1.3 draw result, not the approved future loser outcome. Stage 11a must resolve the outstanding §16.5 ordering/target/input/timing/disconnect/rollback questions and implement the minigame/result/next-match gate consistently. D001–D004 are approved/resolved, not newly reopened issues.
- **Browser/full-game acceptance is unmet.** No browser application, functional table, browser-cookie/manual multiplayer verification, complete externally driven rule-flow match, application CLI or finished Stage 8 claim. Tests still use trusted match-finishing/setup fixtures where documented. Bots/observation memory, readiness/UI and Three.js retain their existing dependencies.
- **Delivery is bounded best-effort.** No reliable outbox, offline notification guarantee or exactly-once observation replay. Slow/uncertain recipients disconnect/resync; missed peeks/transfers are never reconstructed. Historical acknowledgments must not regress current client state. Chat is request/response only, not automatic live push.
- **Administrative/history limits remain deliberate.** Owner-history routing is current-match-only, not arbitrary historical-game access. Large owner histories fail closed under prepared-frame caps. Chat returns byte-bounded prefixes, never truncates/skips rows; an individually oversized trusted row yields unavailable and needs explicit operational handling. Pagination/limit changes need their own bounded scope.
- **Operations are not production-certified.** Configure bounded PostgreSQL connection/statement timeouts; external credential revocation includes scan/query latency. Writer refusal is never bypassed. Proxy/TLS deployment, global DoS controls, heartbeat/checkpoint policy, storage retention/volume profiling, redacted production diagnostics and deployment recovery remain hardening work. Dependency audits were not rerun for 8.14 or this documentation-only update; no dependencies changed.
- **Review status is bounded.** No additional confirmed implementation defect remained after the follow-up review; that is not a security/production-release certification. This reporting edit does not claim another independent implementation review or new integration/browser evidence.

**Next increment (not started):** bounded authenticated lobby creation/join API and canonical creation retry orchestration, after explicit external-contract approval. Preserve D004, admission lock/roster invariants and existing privacy; keep readiness/agreements, UI, bots and minigame work separate. The unchecked cross-cutting Stage 8 checklist below tracks incomplete full-stage acceptance; it does not imply that the explicitly completed bounded slices above are absent.

### Increment 8.15 — Authenticated lobby creation/join and canonical creation retries (complete)

**Approved bounded scope:** the operator approved POST `/api/lobbies` with `{ requestId }`, POST `/api/lobbies/join` with `{ lobbyId }`, existing guest-cookie/exact HTTPS-origin authentication, allowlisted own lobby/seat/index/owner results, an additive durable guest-scoped creation mapping, and explicit later resync without socket attachment. Readiness/agreements, UI, discovery codes, account recovery, bots and minigame work remain excluded.

- [x] Add separate strict HTTP contract decoding and own-membership response allowlisting. Preserve exact bounded request/reference strings; reject extra/authority fields, malformed Unicode and NUL. No private session/roster/current-game/state serialization or socket DTO changes.
- [x] Add migration 004 and `PostgresGuestAccess.createLobbyFromIntent`. Authenticate/lock the credential before canonical lookup; generate opaque lobby/seat IDs only for a new key. Mapping, lobby and owner membership commit atomically, retained with membership across expiry/revocation. Cross-process retries resolve the original identity; another guest's same key grants no access. Existing trusted `createLobby` remains compatible.
- [x] Bind HTTP creation/join with strict media/UTF-8/raw-byte limits (including chunked input), existing origin/IP limits and a shared credential request bucket. Recheck credentials after commit before cookie refresh/allowlisted response. Fixed empty errors; no acknowledgment of partial identity or private diagnostics. New joins preserve credential → lobby → game-head locking, eight-seat capacity, current-game verification and stale-roster start checks without holding SQL locks across host/runtime queues.
- [x] Add two contract tests, two real PostgreSQL cases and nine real TLS/PostgreSQL scenarios: cross-service/fresh-process/restart retries, different guests/keys, atomic receipt failure, 2/4/8 membership/capacity/running-match admission, revocation/expiry, exact allowlists, origin/identity/media/UTF-8/chunked body/rate rejection. Initial red runs reproduced missing canonical API and HTTP 404; green runs pass.
- [x] Independent read-only Reviewer found no issues; no fixes were requested. Reviewer inspected implementation/tests but did not execute tests.
- [x] Normal `npm run check`: **292 pass/five explicit PostgreSQL suite skips**. Database-enabled `npm run check`: **461 pass/no skips**. Dedicated `npm run test:postgres`: **169 pass/no skips** on newly created disposable tmpfs PostgreSQL 18. Format/lint/types/build pass; `git diff --check` passes. No browser cookies/manual match, complete external-flow or production deployment claim.

Changed code: `src/protocol/lobby.ts`/tests, guest access/tests, TLS transport/tests, migration registration and `migrations/004_lobby_creation_requests.sql`. Status/contracts/coverage docs updated. The disposable container and temporary test logs were removed after verification. Pre-existing plan handoff edits were preserved. Stage 8 remains incomplete. **Next recommended dependency-ready increment:** bounded rule-complete external multiplayer-flow verification at 2/4/8 seats, bootstrapping through the new APIs rather than trusted lobby setup; assess the remaining Stage 8 exit criteria before Stage 9. Readiness/house-rule workflows remain separately scoped future work. Stop here; no next increment is implemented.

### Increment 8.16 — External complete multiplayer-flow verification (complete)

**Bounded scope:** implement the dependency-ready verification increment recommended by 8.15. Use actual HTTP guest/lobby APIs and Socket.IO for complete 2/4/8-seat matches and selected integrated claim/chat/admin/reconnect flows. Existing injected clock/randomness is infrastructure setup only; no authoritative state/history access, direct trusted gameplay calls or full-information match fixtures may choose actions. No UI, readiness/house-rule policy, bot decisions, minigame, dependency or production-contract changes.

- [x] Add `src/server/external-match.postgres.test.ts`, registered in the dedicated PostgreSQL runner. Independently cookie-authenticated Node clients create/join/retry through HTTPS, attach/resync and start/retry through Socket.IO; all 36 draws are manual network commands starting from the private initial-recipient notice and clockwise seat order.
- [x] Finish complete matches at 2/4/8 seats within a 1000-command budget, using only the acting seat's own wire hand/stumps, public table/turn and remembered reveal. Compare final projections and executable revision-1.3 result membership. Start/retry an actual successor from each observed finished head and verify automatic state-only baselines.
- [x] Assert shared-view agreement, public conservation/counts, disjoint opaque card handles, no foreign closed-stump handles, transient expiry, strict envelope/state/procedure/control/action allowlists and recipient-only faces. Repeated draw/play/open/claim/rollback requests retain canonical acknowledgments, do not regress current cursors and do not duplicate fresh action/peek/notice/audit observations, including across reconnect sockets.
- [x] Integrate a four-seat out-of-turn dealing punishment, exact retained chat retries, chat-backed claim/withdrawal and episode deduplication, private donor contribution/refusals, punishable own peek, metadata-only owner history/nonowner denial, selected-boundary rollback and stale-branch rejection. Verify original chat context, restored pre-action projections, exact inherited prefix/parent and intact abandoned future.
- [x] Disconnect a participant during another claim ballot after four seconds. Verify a frozen six-second remainder over 31 seconds of absence, reconnect with permitted human memory and a state-only baseline, resume that same remainder, then settle votes/penalties and finish normally.
- [x] Independent read-only review confirmed three verification weaknesses: donor selection depended on previous private choices, peek delivery was not positively required, and rollback assertions lacked exact boundary/prefix restoration. Fixes use public eligible-seat donor order, require one actor-only matching peek with no movement, and verify restored/retained history plus one audit despite retry. Bounded follow-up approved; reviewer did not execute tests. No production defect/change was asserted or needed.
- [x] Final focused TLS/PostgreSQL suite: **4 checks/no skips**. Normal `npm run check`: **292 pass/six explicit database parent-suite skips**. Dedicated `npm run test:postgres`: **173 pass/no skips**. Database-enabled `npm run check`: **465 pass/no skips**. Format/lint/types/build and `git diff --check` pass on a newly created disposable tmpfs PostgreSQL 18 target. The 465 count includes 292 non-database plus 173 database checks, not independent additive runs.

Changed files: the new external-match suite, PostgreSQL runner registration, README, this plan, transport/PostgreSQL verification docs and rule/test coverage. Initial harness execution exposed unsupported TypeScript parameter properties; the helper now uses explicit fields compatible with Node strip-only execution. An intermediate typecheck exposed a callback narrowing issue, fixed by capturing the accepted successor ID. All final gates ran after the review fixes. No skipped/build-only/browser evidence is represented as external-match verification. The disposable container and temporary test logs were removed after verification.

**Stage 8 remains open:** these controlled-clock deterministic Node network scenarios satisfy the previously missing complete-match evidence, not browser cookies/manual UI, all rule/seed/load combinations, readiness/house-rule workflow, bot decisions or revision-1.4/minigame behavior. Remaining full-stage workflow/exit-criteria audit must explicitly separate verified transport from deferred product flows; no Stage 9–12 work was started. **Next recommended increment:** bounded Stage 8 acceptance/remaining-contract audit, then explicit scope/contract approval for the lobby agreements/readiness vertical slice needed by Stage 9. Stop here; do not automatically implement it.

### Increment 8.17 — Stage 8 acceptance and remaining-contract audit (complete; documentation only)

**Scope/acceptance:** inspect every remaining Stage 8 checklist item and exit criterion against existing code and tests; reconcile stale progress wording without changing requirements; record missing server prerequisites and explicit approval boundaries before agreements/readiness or Stage 9 implementation. No code, tests, contracts, migrations, dependencies or game rules change. Test-first behavior development is not applicable to this documentation-only audit; existing checks verify the audited baseline.

| Checklist / exit item | Concrete implementation and test evidence | Audit disposition |
| --- | --- | --- |
| Separate participant/finished/public/owner projections | `projectGame`, `projectLiveGame`, `projectAction`, `projectOwnerHistory`; `src/projections/{game,live,actions,history}.test.ts` | Implemented for supported viewers; pure public projection does not authorize transport spectators. |
| Opaque hidden handles | `PostgresGameHost.startFromIntent` generates independent UUID card IDs before preparation; hidden-face substitution tests in `src/projections/game.test.ts`; wire handle/disjointness checks in `src/server/external-match.postgres.test.ts` | Verified canonical transport path. Trusted internal creation APIs still require caller-supplied face-independent IDs. |
| Seat-private observations and reveal removal | `PenkyTransport.#publish` projects at emission with newer-pause suppression; `src/projections/live.test.ts` deadline/nested-pause tests; `actions.test.ts` peek/open/transfer tests; real TLS disclosure tests | Verified server contract; browser rendering/removal remains Stage 9. |
| Redacted secondary surfaces | Metadata-only owner-history/rollback projectors and fixed error builders; `src/projections/history.test.ts` and TLS owner/nonowner/reconnect tests; external strict wire allowlists | Verified supported error/history/reconnect surfaces, not a raw history entitlement. |
| Socket.IO rooms / authenticated delivery | `decodeClientMessage`, queued admission, `AcknowledgedOutbound`, `PostgresGameHost.subscribe`, `PenkyTransport.#publication/#publish`; real origin/identity/receipt/privacy tests | Acks/IDs/validation/authorization and private subscriptions implemented. Application room joins/fanout are absent; literal room clause remains pending acceptance decision D005. No architecture change or waiver is inferred. |
| Idempotence and ordering | Runtime dispatch/claim/admin/deadline queues, locked guest creation/join, canonical chat/start receipts and atomic handoff; runtime/storage/host/TLS retry and race tests | Verified existing routes; readiness mutations do not exist and inherit no coverage. |
| Stale and punishable commands | Explicit game/branch binding and runtime queue guards; out-of-turn/peek, stale branch/procedure, queued cancellation and old-game tests in `src/server/transport.postgres.test.ts` and external matches | Verified current routes; ordinary play has no client-side legality/turn gate. |
| Authorized versioned resync | `makeStateMessage`, stream epoch/sequence invalidation and state-only baselines; TLS private resync/recovery/successor and external reconnect tests | Verified server boundary, not missed private-observation replay or browser refresh/cookie behavior. |
| Single local writer | `PostgresGameHost` acquisition/recovery/adoption plus existing PostgreSQL leases; host/PostgreSQL writer exclusion and fault tests | Verified; no distributed execution introduced. |
| Initial rate/size bounds | HTTP origin/media/UTF-8/byte gates, transport limiter, Engine.IO limits and bounded outbound receipt queue; `transport-limits.test.ts`, `outbound.test.ts` and real TLS malformed/rate/backpressure cases | Verified existing routes. Deployment tuning, global DoS/proxy operations and future endpoints remain outside this evidence. |
| 2/4/8 isolated clients, duplicate-once and privacy exit evidence | Three complete external match scenarios plus projection noninterference, nonowner/nonparticipant, canonical retry/recovery and metadata-only history tests | Demonstrated in controlled Node TLS/PostgreSQL scenarios for current executable revision-1.3 contracts; not universal security, all-seed/load, browser/readiness or revision-1.4 certification. |

**Actual remaining prerequisite:** rules §2's agreements/readiness workflow is absent from `src/protocol/contracts.ts`, `src/protocol/lobby.ts`, `src/persistence/lobby-contracts.ts` and migrations 001–004. No-game resync returns `unavailable`, not lobby state. `PostgresGameHost.startFromIntent` and `PostgresLobby.startMatch` correctly preserve the approved bounded owner/result/roster policy; they do not enforce readiness. Pending D005 inventories required routing/stage acceptance, workflow, public/durable contract and concurrent edit/ready/join/start decisions. Approved owner-only pregame editing, in-match read-only text and text-change readiness reset are not reopened or implemented by this audit.

The checklist below now records verified existing capabilities rather than leaving completed transport slices unchecked. Its original room-routing clause remains visibly open. Readiness/browser work is not used to deny the demonstrated transport exit evidence, and that evidence is not used to approve new contracts or declare the whole stage complete. **Next increment is approval-blocked:** resolve D005's acceptance and bounded server-only agreements/readiness contract before writing implementation/tests for new behavior. No room redesign, readiness values, new start condition, schema, UI or later-stage work is introduced here.

**Executed verification:** normal `npm run check` **292 pass/six explicit PostgreSQL parent-suite skips**; dedicated `npm run test:postgres` **173 pass/no skips**; database-enabled `npm run check` **465 pass/no skips**. Format/lint/types/build and `git diff --check` pass. These are fresh audit-run results, not counts copied from 8.16; the 465 gate includes 292 non-database plus 173 database checks. The database was a newly created disposable tmpfs PostgreSQL 18 container, removed with temporary logs after verification. No browser/manual/production/load or dependency audit was run. Independent read-only Reviewer approved the documentation with no findings; Scout and Reviewer did not independently execute checks. Changed only README, plan, decision inventory, rule/test coverage and transport status documentation; historical handoffs are retained.

### Increment 8.18 — Durable lobby agreements and acceptance (complete)

**Approved scope and clarified semantics:** retain existing private per-socket routing; every durable lobby member (owner/disconnected included) must accept current agreements before a new match. `ready` represents that acceptance ONLY, not general match readiness. The operator approved the server-only API/schema proposal in principle and authorized proceeding after semantics were established. `revision` is the acceptance epoch: actual stored text changes, genuinely new members and successful new starts increment it/clear everyone; individual true/false acceptance updates do not increment it, allowing concurrent confirmations. Identical text at the current editable epoch is a no-op; reconnects, membership retries, rollback, failed starts and accepted start retries do not reset. UI/dependencies, live lobby push, bot decisions, accounts/recovery and minigame work remain excluded.

- [x] Add migration 005 for lobby text/epoch, false-by-default durable member acceptance and immutable per-match text/accepted epoch. Existing members are not auto-accepted; historical bindings are not fabricated. Game frame/checkpoint and canonical start request/receipt JSON formats stay unchanged.
- [x] Add authenticated POST lobby state/agreements/ready contracts, strict data-only decoding, allowlisted nested workflow views and existing cookie/origin/rate/final-auth protections. Owner alone edits, members read/confirm their own seat; both mutation routes lock during active/suspended/pre-creation-rollback games. Text is verbatim well-formed Unicode (empty allowed, max 4096 UTF-8 bytes); raw workflow bodies max 32 KiB. CAS precedes no-op equality; stale requests conflict without mutation. Epochs are not whole-view ordering/caching tokens.
- [x] Preserve credential → lobby → durable game-head lock order and no access-lock waits on runtime queues. New joins reset/advance atomically only on actual insertion; existing-member reconnects retain consent. Per-member updates serialize without invalidating others at the same epoch.
- [x] Gate **every new member-backed start**, including trusted entry points, at the final lobby-locked roster check. Store immutable agreement binding and clear flags/advance epoch with old closure/new frame/pointer/start receipt in one transaction. Exact accepted canonical retries resolve first and never gate/reset again; zero-member legacy trusted lobbies remain compatible. Start wire request stays unchanged; safe `not-ready` rejection is additive.
- [x] Add optional deferred handoff closure: storage commits a closed old-history copy only on success; a fully rolled-back pre-write policy refusal returns false without altering the live history/writer/rollback window. Release the tentative successor lease only on expected readiness/roster refusal. SQL/rollback/lease-cleanup failure remains fatal. Existing default handoff callers retain behavior.
- [x] Add two protocol tests, one runtime test, four guest PostgreSQL cases, a new 2/4/8 TLS workflow suite (three scenarios plus parent), and one late-withdrawal TLS regression. Cover concurrent confirmations, own withdrawal, actual-change/no-op/CAS/roster resets, failure atomicity, immutable binding and rollback locking, all-member/disconnected gating, replay without reset, strict auth/shape/Unicode/privacy and disconnect/reconnect preservation. Existing fixture starts now explicitly accept; external complete matches use actual workflow HTTP routes before initial/successor starts, not SQL or production auto-consent.
- [x] Test-first red runs reproduced missing workflow service/HTTP routes, missing new-start readiness gate and premature closure on deferred handoff refusal. Focused green runs and the integrated PostgreSQL suite pass. One intermediate integrated run exposed an old roster-race test expecting unavailable: expected policy denial is now a safe invalid-configuration result, and retry explicitly obtains all members' fresh consent.
- [x] Independent read-only Reviewer approved the implementation with no issues; reviewer did not execute checks. No production redesign or speculative review changes were introduced.

Changed-file inventory (including preserved/materially updated 8.17 documentation):

| Area | Paths |
| --- | --- |
| Durable schema/start | `migrations/005_lobby_acceptance.sql`; `src/persistence/{lobby-contracts,lobby,postgres}.ts` |
| Protocol/runtime/server | `src/protocol/{lobby-workflow,contracts,messages}.ts`; `src/runtime/runtime.ts`; `src/server/{guest-access,transport}.ts` |
| Tests/runner | `src/protocol/lobby-workflow.test.ts`; `src/runtime/handoff.test.ts`; `src/server/{guest-access,game-host,transport,external-match,lobby-workflow}.postgres.test.ts`; `src/persistence/testing/run-postgres.ts` |
| Status/spec/contracts | `README.md`; `IMPLEMENTATION_PLAN.md`; `docs/{architecture,game-host,game-rules,guest-access,lobby-persistence,open-decisions,postgres,protocol,rule-test-matrix,runtime,transport}.md` |

Original match agreement text/epoch remains immutable after later lobby edits and rollback. Rollback does not revert current lobby consent; restoring a running match locks mutations and returns original match agreements separately. The approved reset-only causes, canonical receipt identity, strict spectator/private-card boundaries, single-writer ownership and revision-1.4 deferrals are preserved.

**Executed final verification:** normal `npm run check` **295 passed/seven explicit database parent-suite skips**; dedicated `npm run test:postgres` **182 passed/no skips**; database-enabled `npm run check` **477 passed/no skips** (295 non-database + 182 database, not additive independent coverage). Format/lint/types/build and `git diff --check` pass. Database runs used a newly created disposable tmpfs PostgreSQL 18 container, removed with temporary logs after verification. Reviewer inspected production/tests read-only and did not independently run checks; no findings required changes. An initial full integration run failed only the stale-roster test's now-obsolete infrastructure-error expectation; after its documented policy-result/consent adaptation, all final gates pass. Existing 8.17 working-tree documentation edits were preserved and superseded where D005 is now resolved. No browser/manual UI, dependency audit, production/load, bot decisions or minigame verification is claimed.

**Next dependency-ready increment:** a bounded Stage 9 functional lobby/agreements browser slice, after explicit UI/dependency scope approval. Do not add polished Three.js, bot decisions or minigame work. Stop after this server-only increment; no browser application is implemented here.

### Audited Stage 8 checklist (current supported transport scope)

- [x] Implement separate participant, finished-player/spectator, and owner-history projections (authorized pure APIs; transport still denies implicit spectators).
- [x] Keep hidden card identifiers opaque on canonical authenticated starts; trusted internal callers must also supply face-independent IDs.
- [x] Give each seat only its hand and legitimately disclosed observations; suppress server transient reveals after their permitted window. Browser removal remains Stage 9.
- [x] Redact raw events, snapshots, branch previews, errors, owner history and reconnect payloads on supported routes.
- [x] Implement authenticated isolated Socket.IO delivery, acknowledgments, command IDs and strict validation. D005 explicitly accepts the tested private per-socket lifecycle subscriptions in place of literal application rooms; no redundant joins/broadcast routing is added.
- [x] Make existing-route retries idempotent and serialize play, claims, timeouts, rollback and connection effects per game; lobby creation/join/chat/start retain their approved queue/SQL boundaries.
- [x] Reject wrong-game/obsolete-branch commands without blocking admitted current punishable attempts; lobby creation/join routing is also implemented. New readiness contracts remain separate.
- [x] Send versioned state and support full authorized server resync with state-only baselines after missed messages; no private-observation replay or browser-cookie verification is implied.
- [x] Keep local game development single-runtime; prevent simultaneous writers instead of introducing premature distributed execution (durable host in 8.7; authenticated presence/resync integration in 8.8).
- [x] Apply initial rate/payload/backpressure bounds across supported session/lobby/gameplay/claim/admin/chat/start routes without gameplay punishment. Stage 8.18 workflow endpoints reuse these bounds; deployment-wide tuning remains separate.

- [x] Implement D005's server agreements/acceptance prerequisite with same-epoch concurrent confirmations, final all-member start gating, exact reset-only causes and immutable match agreements. General willingness-to-play and browser UI are not added.

**Exit criteria:** 2, 4, and 8 isolated clients can drive the same game; duplicate delivery executes once; no unauthorized viewer receives hidden faces or raw authoritative history. **Satisfied for the approved server/transport scope after 8.18**, with 477 passing database-enabled checks and independent review. Browser/product/production acceptance belongs to the later stages.

## Stage 9 — Functional browser client

**Depends on:** Stage 8. **Status: complete for the operator-approved automated Chromium desktop/narrow/emulated-touch matrix through 9.16.** The operator approved the following small-increment breakdown and first implementation after read-only planning/Scout investigation. React/React DOM, Vite, required type packages and test-only Playwright are approved for this functional stage; no state-management/design framework, Three.js or new gameplay/server contract is added. Runtime sockets/first start are implemented in 9.4; manual dealing/D002 disclosures in 9.5; penalty responses in 9.6; ordinary click-based play/pickup/stump interaction in 9.7. Deck/hand drag equivalence is implemented in 9.8; retained chat is implemented in 9.9; claims/voting are complete in 9.10; withdrawal is complete in 9.11; presence/replacement controls are complete in 9.12; owner metadata timeline is complete in 9.13; rollback is complete in 9.14; results/successor are complete in 9.15; approved automated acceptance is complete in 9.16; manual/native-device/other-engine certification remains unverified.

### Approved execution and test seams

Execute one cohesive increment per run, test-first through client interfaces and browser affordances, then independent review and existing repository gates. Use Node tests for browser-independent client logic, real browser/HTTPS/disposable PostgreSQL for integration, and separately recorded manual accessibility/usability evidence. Screenshots/mocks/Node TLS clients alone are not browser or multiplayer acceptance. All proposed paths below live under `src/client/` unless explicitly qualified. Import wire DTO **types**, never authoritative engine/runtime/projector implementations. Keep acknowledgments, authoritative baseline, transient observations and local interactions separate. On disconnect/resync/branch/successor, discard stale interactions and never replay missed private observations. Preserve every existing architectural invariant and D002–D005; each new deliberate attempt gets a new ID while retries preserve the original exact operation.

### Increment 9.1 — HTTPS shell, guest session and lobby creation (complete)

- **Goal/scope:** real browser page → cookie-only guest session → canonical lobby creation → own-seat/owner display. Minimum build/dev/test startup only; no join/agreements/socket/game controls.
- **Dependencies/files:** Stage 8 and approved tooling/topology; `main.tsx`, `App.tsx`, HTTP creation/session module and CSS/HTML; `src/dev/` HTTPS composition/CLI; Vite/client TS/Playwright config; package/build/lint/format/CI and `tests/browser/`.
- **Acceptance:** Secure/HttpOnly cookie, no JS credential storage; original creation key survives uncertain replies/reload; invalid/lost session is not silently replaced; show only server-returned own identity.
- **Tests:** unit request/retry/error/storage/single-flight behavior; real browser cookie/isolation/reload/error/keyboard/narrow-viewport cases; preserve existing server build/checks.
- **Risks:** navigation has no Origin while API POST requires it; preserve exact Origin/cookie/TLS checks through a certificate-verified loopback HTTPS development front door. Public fixture certificates are test-only, never production or OS trust.

**Implemented/verified handoff:** six public client-seam tests cover durable request equality after uncertainty/reload, refresh/issuance conflicts/failures, no original-session replacement, single-flight, invalid/unavailable storage and strict response allowlisting. The missing-module test failed before implementation. A browser expiry regression also failed before wiring the existing trusted transport clock seam into the test composition, then passed; no client-controlled time endpoint was added. Nine real Chromium/HTTPS/disposable-PG cases pass, including committed response loss/reload, cookie security/guest isolation, real server expiry/rate limits, retained invalid cookie/storage denial, Origin/private-source rejection and keyboard/narrow layout. Two screenshots were inspected at 1280×720 and 360×800 viewports; this is basic visual inspection, not manual multiplayer/assistive-technology or wider-browser certification.

Normal `npm run check`: **301 passed/seven explicit PG suite skips**. Dedicated `npm run test:postgres`: **182 passed/no skips**. Database-enabled repository gate: **483 passed/no skips** (301 + 182, not additive independent coverage); separate browser gate: **nine passed**. Format/lint/server+client types/server+browser builds and `git diff --check` pass. `npm audit --omit=dev`: **zero vulnerabilities**. Checks ran locally on Windows/Node 26 with newly created disposable tmpfs PostgreSQL 18, removed after verification; CI is configured to run Chromium in its Linux/Node 24+26 disposable-PG jobs but those remote jobs were not executed here. Reviewer found no issues through read-only inspection and did not independently run tests. No existing server business code, wire DTO, migration, engine rule or persistence format changed. Development startup remains a source-only loopback tool, not production hosting. See `docs/browser-client.md` for explicit TLS/DB setup and operational boundaries. Commit/push handoff is explicitly authorized by the operator after verification. **Next dependency-ready increment: 9.2 only; stop here.**

### Increment 9.2 — Join and restore own membership (complete)

- **Goal/scope:** join by known opaque lobby ID and restore membership after reload/another tab.
- **Dependencies/files:** 9.1; lobby join form, membership controller and nonsecret locator/navigation.
- **Acceptance:** derive seat/index/role from authenticated join response; existing membership survives full/running lobby; cached identity is not authority.
- **Tests:** join/rejoin/reload/tabs, wrong/full/running lobby, lost credential.
- **Risks:** no lobby discovery, names/code recovery, seat reassignment or guest-self endpoint; never imply recovery or silently issue/rejoin with a replacement guest.

**Implemented/verified handoff:** `LobbyMembershipClient` validates exact opaque targets and own-member DTOs; default refresh/join never issues credentials. One-attempt fresh-guest consent is explicit, reset after submission and blocked by any saved canonical creation key. Encoded `#lobby=...` retains only the target before dispatch; reload and a real new-tab link require explicit server confirmation, never cached identity or mount mutations. Create/join are serialized, previous displayed identity clears before confirmation, and original creation key/label/operation survive joining another lobby. Fixed generic errors do not distinguish unknown/storage or full/running, expose diagnostics or infer game visibility. No new wire contract, dependency, schema or game rule was needed.

Seven public Node seam tests pass, with missing-module and missing-locator-export red runs before implementation. Nine new real Chromium/HTTPS/PG cases plus all nine original browser cases pass. These cover owner/member reload/new-tab identity, committed reply loss, copied locator/lost cookie, member expiry without creation state, original-creation preservation, unknown/full/running admission, keyboard/narrow layout and native validation recovery. Full capacity uses UI-created independent guests; the trusted server clock only advances issuance windows. The running-match precondition uses explicitly labeled trusted consent/start after UI admission; it is **not** browser agreements/start/gameplay acceptance. A valid different guest cannot be recognized as the original identity from a locator alone under the existing dual-purpose join API; UI/docs require the original cookie and promise no recovery.

Independent read-only Reviewer found one P2: whitespace validation survived a later successful creation's programmatic input replacement and blocked restore. The added browser regression failed before clearing `setCustomValidity`/`aria-invalid` in locator updates and passed after. Reviewer ran no checks independently. Basic 360px screenshot inspection also led to a small input/focus spacing correction, not a redesign or manual accessibility certification.

**Executed checks:** normal `npm run check` **308 passed/seven explicit PG suite skips**; database-enabled `npm run check` **490 passed/no skips** (308 non-database + 182 database); separate browser suite **18 passed**. Format/lint/server+client types/server+browser builds and `git diff --check` pass. The dedicated `test:postgres` command was not separately rerun; all its existing cases ran in the database-enabled check. Local verification uses Windows/Node 26 and a newly created disposable tmpfs PostgreSQL 18 container, removed after verification. No remote CI, wider browser/native touch, human assistive-technology or game-completion acceptance claimed. Implementation files: `src/client/lobby-membership.ts`/tests, `App.tsx`, CSS, shared browser fixture and membership/creation browser suites; relevant README/plan/architecture/guest-access/browser/coverage docs updated. Commit/push handoff is explicitly authorized by the operator after verification. **Next dependency-ready increment: 9.3 only; stop here.**

### Increment 9.3 — Agreements and acceptance (complete)

- **Goal/scope:** owner exact-text editing, member own acceptance/withdrawal and read-only immutable match agreements.
- **Dependencies/files:** 9.2; lobby agreements/acceptance views and workflow controller.
- **Acceptance:** same-epoch concurrent confirmations, actual-change reset, identical-text no-op, stale CAS refresh without automatic retarget, active-match lock.
- **Tests:** edit/join/start reset causes, failed mutation, concurrent tabs/confirmations and exact safe rendering.
- **Risks:** acceptance epoch is not a whole-view version; begin with explicit refresh, not polling/autosave that consumes the shared 12/minute lobby credential budget.

**Implemented/verified handoff:** `LobbyAgreementsClient` uses the existing three workflow routes, type-only wire imports and strict nested response decoding, with no issuance, storage, mount request, polling or automatic retry. The membership-keyed component separates last verified view, exact local draft and error/refresh authority; all workflow/create/join operations share the App in-flight guard. Same-epoch explicit reads install current flags. Only owner editing is offered; each member confirms/withdraws its own saved-text acceptance, not general willingness to play. Immutable original match text/epoch render separately and active-match mutations remain locked. Empty exact text, UTF-8 byte limits, literal HTML-looking text and unedited CRLF preservation are verified. Explicit refresh warns that it replaces unsaved drafts; stale/uncertain mutations cannot silently retarget a newly observed epoch.

Seven public Node tests and eleven browser cases were added. Missing-module and missing-UI red runs preceded implementation. Browser cases cover actual/no-op edits, concurrent same-epoch confirmations, own withdrawal, genuine-new-member reset, stale edit/consent, lost committed edit/consent replies, byte validation/global locking, failed/successful/duplicate start reset boundaries, original terms, membership switching and malformed-response draft preservation. Admission, edits and consent use real HTTPS/PostgreSQL/browser UI; **start attempts alone are trusted fixture setup**, not a premature 9.4 start/socket UI. Distinct current/original text and malformed/private/auth responses use explicit wire presentation/error fixtures; CRLF existing data is seeded via authenticated HTTP, not fabricated game state. No browser game completion or new gameplay behavior is implied.

Independent read-only Reviewer identified one P2: an invalid mutation response cleared the view that contained the local editor, hiding a draft before refresh replaced it. The new browser regression failed before retaining only the previous verified view/draft as explicitly stale/read-only; it passes after, while all mutation controls remain disabled and rejected payload fields stay undisplayed. Auth failures still clear the workflow view. Reviewer did not execute checks independently. No other confirmed finding required changes. A 360px full-page screenshot was inspected separately for basic layout/readability; this is not human assistive-technology/usability acceptance.

**Executed checks:** normal `npm run check` **315 passed/seven explicit database suite skips**; database-enabled `npm run check` **497 passed/no skips** (315 non-database + 182 existing PostgreSQL cases); separate browser suite **29 passed** (18 previous + 11 new). Formatting/lint/server+client types/server+browser builds and `git diff --check` pass. The dedicated `test:postgres` runner was not separately rerun. Local Windows/Node 26 verification uses a newly created disposable tmpfs PostgreSQL 18 container removed after checks. No remote CI, broader browser/native mobile, human assistive-technology, browser gameplay or production certification claimed. Implementation files: new `src/client/lobby-agreements.ts`/tests, `LobbyAgreements.tsx`, App/CSS integration and `tests/browser/lobby-agreements.spec.ts`; README/plan/architecture/browser/guest/coverage docs updated. No existing authoritative implementation, DTO, schema, dependency or rule changed. The operator subsequently authorized the combined 9.3–9.4 commit/push handoff. **Next dependency-ready increment at this boundary: 9.4 only; stop here.**

### Increment 9.4 — Receipt-aware connection, first start and read-only game view (complete)

- **Goal/scope:** owner first start plus safe authoritative observation before gameplay gestures.
- **Dependencies/files:** 9.3; connection adapter, bounded pending-request handling, stream reducer, start control and read-only game view.
- **Acceptance:** install nonce acknowledger before connect; attach via resync, start with stable request/intent, resync after first acknowledgment; show only projections and handle null-state rollback without fabricating an unassigned lobby.
- **Tests:** old acknowledgments cannot regress state; same-head controls, stale epochs, action/state ordering, disconnect/resync reset and state-only recovery.
- **Risks:** errors/state/history lack requestId; serialize uncorrelated requests and retain uncertainty. Never buffer/replay obsolete offline gameplay or interpret unavailable as proof no game exists.

**Implemented/verified handoff:** new `game-connection.ts`/tests, `game-stream.ts`/tests and `GameConnectionView.tsx` provide explicit same-origin WSS connect/disconnect, first owner start and read-only validated projection summaries. Receipt echo is installed before connect and precedes message processing, including ignored/stale packets. One connect/resync/start is pending with a deadline; volatile sends and disabled auto-reconnect prevent offline command replay. Local resync uses a fresh physical connection to fence uncorrelated old in-flight packets. Opaque epochs/strict delivery order—not historical ack heads or monotonically increasing action versions—drive state installation. Same-head controls apply; new-epoch action/rollback metadata waits for state; retired epochs/gaps/malformed used fields are bounded/fail-closed. Only public used summary data is retained; faces, handles, transient/procedure/action observations are discarded, not stored as memory.

First-start `expected:null` remains an explicit server-admitted proposal, never inferred from unavailable attachment. The original request ID/null intent is persisted before dispatch in a separate nonsecret tab reference and reused after uncertainty/reload; corruption blocks replacement. Matching successful/duplicate start ack obtains a fresh state-only baseline, never sets current identity/head. Verified assigned-null rollback remains assigned; a new-tab owner cannot treat it as unassigned. Confirmed game/branch changes clear the old agreements widget/draft (with visible warning), not server consent; same-route control/resync does not repeatedly discard it. `src/dev/server.ts` now binds middleware upgrades to the actual front HTTPS server and proxies `/socket.io/` HTTPS/WSS with unchanged Origin/cookies and verified upstream CA, then drains/destroys upgraded connections during teardown. The already installed Socket.IO client moves from dev to runtime at the same version.

Eleven public client-seam tests and six browser cases were added. Missing modules failed before implementation; malformed saved-reference and coercive enum regressions also failed before bounded fixes. Actual browser UI guest/admission/consent/first start, reconnect/reload/duplicate retry, live suspension, failed-not-ready retry and expiry are verified over real HTTPS/WSS/PostgreSQL. Explicit WebSocket routing drops a committed start ack or nonce receipts, exercising uncertainty and server disconnect rather than fabricating state. An authenticated Node TLS/Socket.IO fixture uses existing owner metadata/rollback APIs to produce the actual null-state browser baseline; this is not a browser history/rollback control or trusted raw-state driver. Paired positive/negative WSS plus polling checks verify exact Origin through the proxy. Source inspection/strict regressions verify no face/observation retention. A 390px layout/screenshot check is basic evidence, not human accessibility/native-device acceptance.

Independent read-only Reviewer found enum coercion accepted arrays and could throw for malformed objects; explicit string guards and expanded failing-then-passing regressions resolve it. Basic screenshot review also revealed a stale agreements snapshot after start; a browser regression failed before game/branch-driven widget invalidation, then passed. Bounded independent follow-up found no issues in the enum fix or route/key integration; reviewers did not independently execute checks. No other confirmed finding required changes.

**Executed checks:** normal `npm run check` **326 passed/seven explicit PG suite skips**; database-enabled `npm run check` **508 passed/no skips** (326 non-database + all 182 existing PG cases); separate browser suite **35 passed** (29 prior + six new). Format/lint/server+client types/server+browser builds, `git diff --check` and production dependency audit (zero vulnerabilities) pass. Dedicated `test:postgres` runner not separately rerun; its cases ran in the database-enabled gate. Local Windows/Node 26 verification uses a newly created disposable tmpfs PostgreSQL 18 container, removed after checks. No remote CI, wider browser/native mobile, human assistive-technology, browser game completion or production certification claimed. Preexisting uncommitted 9.3 implementation/docs were preserved; this run implements only 9.4. Existing server business code, protocol/projection contracts, schema and game rules are unchanged. The operator subsequently authorized the combined 9.3–9.4 commit/push handoff. **Next dependency-ready increment: 9.5 only; stop here.**

#### Current combined working-tree handoff — verified 9.3 and 9.4

**Baseline:** `ddcbc5a` (9.2). The operator explicitly authorized a combined commit/push of both completed increments after the documentation audit. The audited working tree contained **22 changed/new files**, including the preserved 9.3 work; tracked-only `git diff --stat` did not include the ten new files. This report consolidates the two implementation runs, not a new increment or authorization to start 9.5.

| Changed/new files | Implemented change |
| --- | --- |
| `src/client/LobbyAgreements.tsx`, `src/client/lobby-agreements.ts`, `src/client/lobby-agreements.test.ts` (new) | 9.3 explicit workflow snapshots, strict nested decoding, exact drafts, own consent and uncertain-result handling; seven Node tests. |
| `src/client/GameConnectionView.tsx`, `src/client/game-connection.ts`, `src/client/game-connection.test.ts`, `src/client/game-stream.ts`, `src/client/game-stream.test.ts` (new) | 9.4 WSS adapter/controller, persisted immutable first-start proposal, bounded stream ordering and read-only summary; eleven Node tests. |
| `src/client/App.tsx`, `src/client/style.css` | Membership-keyed integration, shared in-flight guard, game/branch-driven stale-agreements invalidation and functional responsive controls. |
| `tests/browser/lobby-agreements.spec.ts`, `tests/browser/game-connection.spec.ts` (new) | Eleven agreement cases and six connection/start cases, with explicit fixture/loss-instrumentation boundaries described above. |
| `src/dev/server.ts` | Certificate-verified HTTPS/WSS proxy, actual front-server upgrade wiring and drained TCP/upgrade cleanup. |
| `package.json`, `package-lock.json` | Existing Socket.IO client promoted from dev to runtime at the same version; no new package/framework. |
| `README.md`, `IMPLEMENTATION_PLAN.md`, `docs/architecture.md`, `docs/browser-client.md`, `docs/guest-access.md`, `docs/rule-test-matrix.md`, `docs/transport.md` | Status, operational/module boundaries, coverage, verified counts and remaining work. |

**Recorded executed results (not newly rerun for this documentation-only update):**

| Check | 9.3 verified boundary | Latest combined 9.4 boundary |
| --- | --- | --- |
| Focused new Node tests | Seven agreements tests passed | Eleven connection/stream tests passed; earlier seven agreements tests remain in the full gate |
| Normal `npm run check` | 315 passed; seven explicit PG suite skips | **326 passed; seven explicit PG suite skips** |
| Disposable-PG-enabled `npm run check` | 497 passed; no skips | **508 passed; no skips** |
| `npm run test:browser` with disposable PG | 29 passed | **35 passed** |
| Formatting, lint, server/client types and server/browser builds | Passed through repository gate | Passed through repository gate |
| `npm audit --omit=dev` | Not separately rerun for 9.3 | **Zero vulnerabilities** after SDK classification change |
| Dedicated `npm run test:postgres` command | Not separately rerun | Not separately rerun; all **182 existing PG cases** ran in the database-enabled gate |
| `git diff --check` | Passed | Passed; rerun for this documentation update |

The latest 508 Node checks are **326 non-database + 182 PostgreSQL**, not additional independent coverage on top of either normal gate. The 35 browser cases are separate: **18 prior + 11 from 9.3 + six from 9.4**. Across these combined changes, 18 Node tests and 17 browser cases were added. Both increments used locally created disposable tmpfs PostgreSQL 18; containers and temporary test logs were removed. The 9.4 container's absence was rechecked for this handoff. Screenshots remain ignored local test artifacts, not golden-image or manual-usability certification.

**Review findings and resolutions:** 9.3 malformed replies hiding a recoverable draft and 9.4 coercive enum validation were reproduced with failing regressions and fixed; final suites pass. The screenshot-discovered stale agreements snapshot after first start was also reproduced and fixed by validated game/branch-driven widget invalidation, without changing server consent. Independent read-only follow-up approved the 9.4 enum and route/key fixes. Reviewers did not execute checks themselves. No confirmed review finding remains open; this is not a claim of exhaustive defect/security absence.

#### Unresolved decisions, limitations and deferred acceptance — historical 9.3–9.4 handoff

This table preserves the earlier handoff, not the current next increment. Increments 9.5–9.9 and the peek presentation decision have since been completed/resolved. See **Current handoff audit — after 9.9** for current blockers and verification boundaries.

| Item | Current safe boundary / required follow-up |
| --- | --- |
| Next increment 9.5 | Still unimplemented: manual deck interaction, observable draw actors, own-card/dealing presentation and D002 notices/reveal lifecycle. Verify 2/4/8-seat browser dealing, deliberate out-of-turn attempts, pause/expiry/duplicates and state-only reconnect without new reveal windows. D002 is already resolved; do not reopen it or invent turn/trump hints. |
| Fresh peek display lifetime/dismissal (9.7, resolved) | Operator approved an actor-only dismissible notice until dismissal or the associated penalty ends/changes, whichever first; also clear on pause/disconnect/resync/rollback/game change. No new timer, reopening, persistence, face journal or replay. Implemented and verified in 9.7; see D002. |
| Spoken episode naming/reuse UX (9.10) | Presentation/interaction choice remains unresolved. Preserve server-owned scope and exact references; no machine inference of equivalent spoken incidents. |
| Replacement absence timing (9.12) | No authoritative absence timestamp is projected. Use existing proposal feedback; an authoritative client countdown would need a separately approved contract, not an invented timestamp. |
| Practical owner-history size (9.13) | Resolved by measured >97KB fork and explicit operator approval for 9.13p pagination; 9.13 now uses that paged reader. Large 2/8-seat fixture DOM measurements are recorded below; no silent truncation. |
| Protocol ambiguity (managed, not an open 9.4 defect) | Technical errors/state lack request correlation; unavailable resync never proves unassignment. Preserve one pending operation, fenced resync, exact immutable retries and server admission. No definitive-empty endpoint or reliable/exactly-once delivery is claimed. |
| Guest identity loss (D004, resolved policy) | Lost/expired cookies remain unrecoverable; a locator cannot authenticate or detect substitution by a different valid guest. No implicit replacement, owner transfer or recovery system is authorized. |
| Browser/manual acceptance (9.16) | Local execution was Windows/Node 26 with Chromium and basic narrow-layout checks. Remote CI, Firefox/Safari/native mobile, human assistive-technology/usability and complete UI-driven 2/4/8 matches remain unverified. Agree the broader browser matrix and record manual evidence separately. |
| Deferred revision 1.4 / Stage 11a | Current executable results still follow revision 1.3. Repetition-result/minigame implementation and unresolved rules §16.5 decisions remain outside Stage 9. No decision is silently filled in by UI work. |
| Production and later features | No production hosting/security/load certification, polished Three.js, bot decisions, chat/procedure/history/rollback UI, successor-start UI or complete browser gameplay is claimed by 9.4. |

Existing decisions D001–D005 remain resolved as recorded in `docs/open-decisions.md`; the scoped pending presentation choices above must follow that decision workflow when reached. **At that historical handoff, Stage 9 remained incomplete and next dependency-ready work was 9.5 only**, subject to its existing acceptance criteria. The documentation-only audit reran no implementation suites and began no new increment. The subsequent operator request authorizes committing/pushing the verified combined changes, not beginning 9.5.

### Increment 9.5 — Manual dealing and transient disclosures (complete)

- **Goal/scope:** deck click, visible actual draw actors, own drawn cards and D002 initial/reveal notices.
- **Dependencies/files:** 9.4; `DealingView.tsx`, stream decoder/disclosure deadlines and connection controller, client tests/CSS and `tests/browser/dealing.spec.ts`.
- **Acceptance verified:** all 36 browser draw clicks at 2/4/8 seats, two separate stump passes and private hand distribution; out-of-turn attempts remain enabled and report a violation without keeping a card or consuming the initial notice. No inferred next-recipient indicator or permanent trump. Reveal hides on expiry/pause/disconnect/reset; same running timer deadlines only shorten, never restart on rerender/duplicates. Recipient's authorized own hand remains visible.
- **Tests:** six net new Node tests (17 total stream/connection cases) cover strict card/transient/observation decoding, actors/duplicate ordering, relative deadline expiry/resume, technical rejection versus accepted violation, uncertainty/no replay, historical ack immunity and pending-draw rollback invalidation. Four real browser cases cover 2/4/8 dealing, initial notice resync/consumption, all-seat draw feedback, out-of-turn rejection, client removal independent of server callback, real disconnect/resume with remaining time, expired state-only reload and committed lost draw ack with no replay. Existing 9.4 browser expectation now permits the new draw control.
- **Risks/boundaries:** relative monotonic deadline is display/removal only, not clock sync or an authoritative timeout. One pending draw; each deliberate click has a fresh request ID. No persisted draw/face/observation cache or automatic/manual draw retry is offered. After uncertainty, explicitly reconnect and inspect before making a new attempt. Penalty controls, ordinary play, claims UI and bot/3D work remain deferred.

**Verification/handoff:** test-first red runs reproduced missing stream disclosures/draw commands, missing initial browser notice and stale pending draw after rollback. Normal `npm run check`: **332 pass/seven explicit PG suite skips**; database-enabled `npm run check`: **514 pass/no skips**, including all 182 existing PG cases; separate browser gate: **39 pass**. Format/lint/types/server+browser builds and `git diff --check` pass. Dedicated `test:postgres` runner not separately rerun; its cases ran in the database-enabled gate. Database target was a newly created disposable tmpfs PostgreSQL 18 container. Browser clock advancement verifies client removal only; host gameplay deadlines use real time, separately awaited before expired reload. Lost-ack routing is explicit transport-loss instrumentation, registered before navigation; no trusted gameplay setup or private state driver is used for dealing. Scout found no dependency/rule blocker; independent read-only Reviewer found no issues and ran no checks. No authoritative implementation, protocol/schema, dependency or gameplay rule changed. Broader browser/native mobile/manual assistive-technology/full-match/production acceptance is not claimed. **Next dependency-ready increment: 9.6 only; stop here.**

### Increment 9.6 — Penalty contribution/refusal (complete)

- **Goal/scope:** complete dealing and later penalties through own-card selection or explicit refusal, using the existing `penalty-response` contract.
- **Dependencies/files:** 9.5; new `PenaltyView.tsx` and reusable `RemainingTime.tsx`; stream penalty/transfer validation and monotonic timer anchoring; connection-owned selection/command lifecycle; client tests/CSS and real browser penalty tests with shared dealing helpers.
- **Acceptance verified:** own-hand-only donation with at least two hand cards; closed stumps and last hand card cannot be selected/sent by this UI. Authoritative own reservation remains in the hand until completion and is never inferred from an ack. Only donor/recipient receive/render fresh completed-transfer faces. One pending response, no offline buffering/automatic retry or persisted selection. Procedure/route/epoch/rollback/resync/disconnect, removed cards, confirmed responses and local expiry clear obsolete drafts; late acks cannot authorize another procedure.
- **Tests:** nine new Node cases cover exact commands, own-only reservations, zero/one-card refusal, stale procedures/late acks, malformed/private fields, shortening/frozen/resumed timers, valid zero, local expiry without server commands, uncertainty/no replay and bounded fresh transfer clearing. Three real four-seat Chromium/HTTPS/PG cases cover queued pregame donation/refusal and atomic counts/privacy, all-refuse completion, a later illegal-peek-triggered penalty preserving an active round's exact server-projected phase/turn, real stale-ID rejection, pause/resume plus reserved-card timeout, and lost accepted response acknowledgment followed by state-only own-reservation restoration. Zero/one-card guards are client Node tests plus existing engine/projection tests, not synthetic browser transitions.
- **Risks/boundaries:** relative countdown is approximate display only. Local zero disables response/clears draft but never manufactures refusal, transfer, completion or a new turn. Fresh transfers are current-action feedback, cleared by the next action/reset rather than retained as a face journal. No claim, play/take/open, replacement, history or minigame controls were added.

**Verification/handoff:** test-first red runs reproduced missing penalty stream/command support and stale accepted feedback/transfer data across procedure/branch changes. Normal `npm run check`: **341 pass/seven explicit PG suite skips**; database-enabled `npm run check`: **523 pass/no skips**, including all 182 existing PG cases; separate browser suite: **42 pass**. Format/lint/types/server+browser builds and `git diff --check` pass. Dedicated `test:postgres` runner not separately rerun; its cases ran in the database-enabled gate against a newly created disposable tmpfs PostgreSQL 18 container. Initial concurrent gates were not clean: an existing game-host recovery cleanup assertion observed a lingering tagged connection, one old dealing case exceeded 30 seconds under load, and a new helper read the initial notice during an action/state gap. No authoritative code was changed; helper assertions now wait for the actual private notice, and final complete browser/database gates ran separately and passed. A targeted browser test initially advanced the whole browser clock far enough to affect socket heartbeat timers; its frozen-display check now advances only one second, while the real host timeout remains independently verified. Scout found no rule/dependency blocker; independent read-only Reviewer found no issues and ran no checks. Later penalty setup uses explicitly labeled authenticated Node Socket.IO intents from seat-local projections to lead a round and make an illegal own-stump attempt; it is not ordinary-play/peek browser UI evidence or trusted state mutation. Broader browser/manual assistive-technology/full-match/production certification is not claimed. **Next: 9.7 only, after agreeing its fresh-peek lifetime/dismissal; stop here.**

### Increment 9.7 — Click-based play, bottom pickup and own stump (complete)

- **Goal/scope:** ordinary play now has hand-card buttons, exactly-bottom pickup and one own-stump button for server-decided legal opening or punishable peeking. Controls are scoped to running between-round/round play; no turn, beat or opening-right solver/confirmation disables deliberate violations. The authoritative server's broader command contract is unchanged.
- **Dependencies/files:** 9.6; `DealingView.tsx` own-card/stump controls, new `PlayView.tsx`, stream public table/round/leader validation and action feedback, connection single-flight move/ack/uncertainty handling; client tests and browser scenarios with a labeled fixture helper. App footer and materially affected docs updated.
- **Acceptance verified:** ordered table is bottom→top, command payload never supplies a chosen table card, and only committed state moves cards. Wrong-turn/wrong-beat attempts remain enabled. Current-action played/taken/opened/violation feedback survives final empty-table/discard states and includes automatic pickups. Own-stump face is private; ordinary hand visibility is independent of a fresh-peek notice. The approved notice binds only fresh actor data to its resulting peek penalty, stays dismissed, clears on penalty end/change/pause/reset and never returns from a baseline or duplicate.
- **Tests:** six new Node cases cover strict table/phase/action decoding, exact play/take/open envelopes, ownership guards without legality hints, no optimistic movement, historical-ack immunity, uncertainty/no replay, current-action feedback and exhaustive peek dismissal/penalty/pause/epoch/rollback/null/branch clearing. Seven browser cases: two real HTTPS/PG flows bootstrap/deal through UI then verify keyboard lead, pickup, technical empty-table rejection versus wrong-turn violation, and all-seat peek privacy/dismissal/completion/pause/resume/resync. Five explicit engine/projector **wire-fixture** cases exercise scenarios 2–10: discard and empty-table exits, multi-card bottom order, six-over-ace, automatic pickup/temporary empty hand, fixed eight-seat target/simultaneous exits, legal off-turn opening, mandatory-opening violation plus donated hand, and invalid spade beat with restored turn.
- **Risks/boundaries:** late-scenario fixtures replace only the Socket.IO game-message lane after real lobby bootstrap; they run real engine transitions and seat-specific projectors with randomized opaque IDs. They do **not** prove persisted/authenticated backend transitions or end-to-end reachability of those late states. Only two new cases are real gameplay integration evidence. No full UI-driven match matrix, drag, chat/claim/replacement/history/result redesign, minigame or polished 3D is claimed. No new peek timer, face journal, persistent observations or inferred legality hints.

**Verification/handoff:** test-first red runs reproduced missing table/round/action/peek data and move methods. Normal `npm run check`: **347 pass/seven explicit PG suite skips**; database-enabled `npm run check`: **529 pass/no skips**, including all 182 existing PG cases; separate browser suite: **49 pass**. Gates ran serially on a newly created disposable tmpfs PostgreSQL 18 container. Format/lint/types/server+browser builds and `git diff --check` pass. Dedicated `test:postgres` runner not separately rerun; its cases ran in the database-enabled gate. A targeted real two-seat test initially hit the existing 20-events/second socket policy after dealing; it now advances the trusted fixture limiter/guest wall to the next window before gameplay, without weakening limits or advancing the real host game clock. Scout found no additional rule blocker after operator approval of peek lifetime; independent read-only Reviewer found no issues and executed no checks. No authoritative engine/runtime/projector/transport implementation, protocol/schema, dependency or gameplay rule changed. Broader browser/native mobile/manual assistive-technology/full-match/production certification remains deferred. **Next dependency-ready increment: 9.8 only; stop here.**

### Increment 9.8 — Click/drag equivalence (complete)

- **Goal/scope:** deck→own-hand/seat and hand→public-table drag invoke the exact existing draw/play methods. No new command, legality solver, face preview or optimistic movement.
- **Dependencies/files:** 9.7; `card-drag.ts` intent-only adapter and `use-card-drag.ts` Pointer Events integration owned by `GameConnectionView`; source buttons/target refs in dealing/play views, scoped CSS and tests.
- **Acceptance verified:** eight-pixel threshold, primary-button capture, release-coordinate hit testing, one command on a valid drop, no following-click duplication. Outside drops, Escape, pointercancel/lost capture, competing contacts, blur/visibility/unmount, busy changes and every client publication cancel locally. The publication fence includes same-head epochs, resync/rollback and source removal. Cancelled contacts cannot take over or click through; fresh presses and native keyboard clicks remain usable. Empty targets have hit areas and a temporary fixed seat/table drop strip supports long/narrow layouts without moving cards. Touch-action/user-selection suppression applies only to source buttons; scrolling outside remains available.
- **Tests:** five Node cases cover threshold/tap, valid/invalid drops, reset and click suppression, competing primary/third-contact ordering and new pointer/keyboard use. Six Chromium cases include two real HTTPS/PG deck/hand drags with exact outgoing intent counts and committed movement, including stump destination and out-of-turn draw. Four explicitly synthetic engine/projector game-message cases verify public-table drop/Space, capture loss/resync/new epoch/source removal, mixed-primary adapter ordering and Chromium CDP touch drag/cancel/scrolling at 390px. Touch emulation is not native-device/browser-matrix certification.
- **Review/fixes:** independent Reviewer found P1 document-capture/source-bubble ordering could let a second primary pointer erase cancellation suppression. A failing browser regression reproduced an unintended play; contact-cohort blocking and per-pointer click tokens fixed it. Bounded read-only follow-up found no remaining issue; reviewers executed no tests. The queued-penalty test also exposed insufficient response synchronization; its helper now waits for committed head progress before proceeding (three focused repetitions pass), without automatic mutation retry or authoritative changes. A capture-loss test now processes the next native event before expecting deferred `lostpointercapture`.

**Verification/handoff:** normal `npm run check` **352 pass/seven explicit PG skips**; database-enabled gate **534 pass/no skips** (all 182 existing PG cases); separate Chromium suite **55 pass**. Format/lint/types/server+browser builds and `git diff --check` pass. Gates ran serially against a newly created disposable tmpfs PostgreSQL 18 container; dedicated `test:postgres` was not separately rerun because its cases ran in the database-enabled gate. Initial browser gate/targeted repetitions were not clean until the documented fixes; final full gates pass. No server/game/runtime/projection implementation, protocol/schema, dependency or game-rule change. No reliable command replay, general drag framework, full match/native mobile/manual AT certification or later workflow is claimed. **Next dependency-ready increment: 9.9 only; stop here.**

### Increment 9.9 — Retained chat (complete)

- **Goal/scope:** explicit posting/paging through the existing shared socket; agreements remain accessible. Operator approved separating lobby attachment from denied game visibility instead of adding a presence-bearing second socket. Each chat request still receives fresh server membership authorization; an attached client status is not a capability.
- **Dependencies/files:** 9.4/9.3/9.8; new `lobby-chat.ts` decoder/request/cursor seam and `LobbyChat.tsx`; shared connection/UI wiring, tests and status/docs.
- **Acceptance verified:** exact plain text and immutable messageId/text on explicit uncertain retries, with new correlation request IDs. Server original author/time/head/scope are retained and never installed as current game state/evidence. History uses BigInt-safe last-returned sequence, accepts gaps/short byte-prefix pages and advances only from history replies. Posts do not skip unread history. One bounded page (at most 100 rows) plus last confirmed post, with duplicate display suppression; pages explicitly replace the prior page.
- **Tests:** five new Node cases cover strict nested privacy/schema validation, exact retry/correlation, wrong/late replies, altered posts, high/gapped/unordered sequences, independent cursors, denied game visibility and rollback during a pending post. Four Chromium cases: real no-game hostile/plain-text posting with short byte-prefix pages/empty follow-up and accessible agreements; committed reply loss/reconnect/exact-ID retry without duplicate row; original context retained across owner rollback to null and reconnect/other member read; and an explicitly injected denied-game reply with real membership-authorized chat. The last case is frontend denied-visibility evidence, not a new real nonparticipant setup; existing PG transport cases retain that server coverage.
- **Boundaries:** no live push, automatic retry/outbox, extra production socket, claim UI, local-storage format or server/API/schema change. Draft and uncertain original ID/text live only in the mounted lobby; reload/unmount loses the retry reference, as explicitly warned. Empty/short pages are read results, not permanent completion. Old retained messages are not relabeled valid current evidence.

**Verification/handoff:** test-first red reproduced the missing chat module. Normal `npm run check`: **357 pass/seven explicit PG skips**; database-enabled gate: **539 pass/no skips**, including all 182 existing PG cases; separate Chromium suite: **59 pass**. Format/lint/types/server+browser builds and `git diff --check` pass. Gates ran serially against a new disposable tmpfs PostgreSQL 18 container; dedicated `test:postgres` was not separately rerun because its cases ran in the database-enabled gate. Scout identified the attachment/visibility seam; operator explicitly approved the shared-controller approach before edits. Independent read-only Reviewer found no issues and ran no checks. No authoritative engine/runtime/transport/projector/persistence implementation, protocol/schema, dependency or game-rule change. Full browser match/native-mobile/manual assistive-technology/production certification remains deferred. **Next: 9.10 only after agreeing spoken-episode naming/reuse UX; stop here.**

### Current handoff audit — after 9.9 (documentation only)

**Scope:** reconcile the verified implementation through `866661d`, not add gameplay or authorize another increment. Stage 9 is incomplete overall; increments 9.1–9.9 are complete within their documented boundaries. Stage 9.10 is next, but its spoken-episode naming/reuse UX must be agreed before implementation. No confirmed independent-review finding remains open; this is not exhaustive defect/security certification.

#### Committed increments and recorded verification

| Increment | Commit | Implemented slice | Normal check: pass / PG skips | Database-enabled check: pass / skips | Separate Chromium gate |
| --- | --- | --- | --- | --- | --- |
| 9.5 | `4d46ddb` | Manual dealing, own cards/stumps, draw actors, D002 notices/reveal removal | 332 / 7 | 514 / 0 | 39 pass |
| 9.6 | `97b1282` | Penalty reservation/refusal, private completion, remaining-time display/reset | 341 / 7 | 523 / 0 | 42 pass |
| 9.7 | `571d185` | Click play/bottom pickup/stump interaction and approved fresh-peek notice | 347 / 7 | 529 / 0 | 49 pass |
| 9.8 | `44a051c` | Equivalent deck/hand drag, cancellation and click suppression | 352 / 7 | 534 / 0 | 55 pass |
| 9.9 | `866661d` | Retained chat on approved shared connection, exact retries and independent paging | 357 / 7 | 539 / 0 | 59 pass |

These are successive whole-repository totals, **not additive runs or independent coverage counts**. Each database-enabled total contains the same 182 existing PG cases plus that increment's non-database tests. Across 9.5–9.9 there are **31 net new Node tests and 24 new browser cases** relative to 9.4's 326/35 baseline. The latest browser total includes explicitly synthetic wire fixtures; it is not 59 full real multiplayer matches.

**Executed for this documentation audit:** `npm run check` freshly passes **357 tests/seven explicit database skips**, including formatting, lint, server/client types and both builds. `git diff --check` passes for the documentation edit. **Not rerun here:** database-enabled check, dedicated `test:postgres`, Chromium, production dependency audit, remote CI, other browser engines, native devices and manual assistive-technology/usability checks. Their historical results above remain recorded implementation evidence, not fresh audit execution. Implementation database gates used disposable tmpfs PostgreSQL 18 containers, removed after those runs; no database command is required by this audit. Dedicated `test:postgres` was not separately rerun in these increments because its cases ran inside the database-enabled gates.

#### Changed-file inventory and review/fix accounting

`git diff --name-only 38dd814..866661d` confirms **33 changed/new paths** across these five increments:

- Client composition/presentation: `src/client/App.tsx`, `DealingView.tsx`, `GameConnectionView.tsx`, `LobbyChat.tsx`, `PenaltyView.tsx`, `PlayView.tsx`, `RemainingTime.tsx`, `style.css`.
- Client interfaces/interaction logic: `src/client/card-drag.ts`, `game-connection.ts`, `game-stream.ts`, `lobby-chat.ts`, `use-card-drag.ts`.
- Node client tests: `src/client/card-drag.test.ts`, `game-connection.test.ts`, `game-stream.test.ts`, `lobby-chat.test.ts`, `penalty.test.ts`, `play.test.ts`.
- Browser cases/helpers: `tests/browser/chat.spec.ts`, `dealing-helpers.ts`, `dealing.spec.ts`, `drag.spec.ts`, `game-connection.spec.ts`, `penalty.spec.ts`, `play-fixture.ts`, `play.spec.ts`.
- Documentation: `IMPLEMENTATION_PLAN.md`, `README.md`, `docs/architecture.md`, `docs/browser-client.md`, `docs/open-decisions.md`, `docs/rule-test-matrix.md`.

All listed commits were pushed to `origin/main`. The 9.9 commit alone changed 13 paths; its precise file list and semantics are reflected by the chat/connection modules, tests and docs above. No authoritative engine/runtime/server/projection/persistence implementation, protocol/schema, dependency or game-rule change is included. The current audit changes **only `IMPLEMENTATION_PLAN.md`**.

Independent read-only reviews ran for each implementation; reviewers did not independently execute checks. **Confirmed review fix:** 9.8 P1 competing-primary cancellation could erase the original click-suppression token and cause an unintended play. A failing browser regression reproduced it; blocked contact cohorts/per-pointer tokens fixed it, and a bounded follow-up approved the fix. 9.5–9.7 and 9.9 reviewers reported no issues. Additional test-first/self-check fixes cover obsolete pending draws after rollback, stale penalty acceptance/branch transfer feedback and capture-change event ordering. Earlier gates were not all clean: 9.6 recorded concurrent-load cleanup/timing failures, and 9.8 recorded queued-penalty response synchronization failures. The refusal helper now waits for committed progress, with three focused repetitions passing; final serial complete gates passed. These failures are preserved in the increment handoffs, not hidden by final totals.

#### Current unresolved issues and acceptance limits

| Item | Verified boundary / required next action |
| --- | --- |
| **9.10 spoken-episode naming/reuse � subsequently approved** | Manual exact spoken episode field only: no generation, inference, suggestions or automatic reuse; submission clears the key. Scope/author remain server-derived. The audit below predates this approval; implementation evidence follows in 9.10. |
| Chat retry lifetime and paging | An uncertain message ID/exact text survives reconnect only while its lobby widget remains mounted; reload/unmount loses the locator. No automatic retry, storage format, reliable outbox or live push is promised. One bounded page replaces the prior page; post replies do not advance its cursor, short pages are not completion and retained old context is not current evidence. |
| Browser evidence boundaries | Late scenarios 2–10 include five synthetic engine/projector game-message cases. Drag includes four fixture-based cases, with Chromium CDP touch rather than native-device verification. Chat has one injected game-denial reply case with real chat authorization, not a new real nonparticipant lifecycle. Real backend coverage remains separately identified in each handoff. |
| Full Stage 9 acceptance | Complete UI-driven 2/4/8-seat match matrix, claim/vote/withdrawal/replacement/history/rollback/successor controls, broader browser matrix and manual accessibility/usability remain pending. A successful build or fixture scenario does not satisfy these exit criteria. |
| Replacement countdown (9.12) | No authoritative absence timestamp is projected. Use existing proposal feedback or seek approval for a contract change; do not invent a synchronized countdown. |
| Owner-history size (9.13) | Resolved after this historical audit: approved 9.13p byte-bounded pagination and verified 9.13 browser traversal. See their measurements and limitations below. |
| Managed protocol/identity limits | Errors/state lack request correlation; maintain singleflight/fenced resync and fresh authorization. Unavailable/denied game projection does not prove unassignment. Lost/expired original guest credentials remain unrecoverable under D004. |
| Resolved decisions | D001–D005 remain resolved. The 9.7 peek lifetime/dismissal policy and 9.9 shared-connection attachment approach were explicitly approved; neither is an outstanding blocker. |
| Later rules/production | Revision-1.4 repetition-result/minigame work remains Stage 11a with §16.5 decisions pending. Bots, polished Three.js, production deployment/security/load certification and release operations remain deferred. |

**Audit review:** an independent read-only Reviewer checked the consolidated report against the supplied actual commit-range/file-inventory output, fresh normal-check log and existing handoffs. No factual inconsistencies were found; the reviewer made no edits and executed no tests. No earlier implementation check was silently reclassified as freshly run.

**Historical audit stop boundary (superseded by approved 9.10 below):** no new implementation increment, architectural contract, game rule or test suite is introduced by this audit. Next is a scoped decision on 9.10's spoken-episode UX, then 9.10 implementation only when approved.

### Increment 9.10 — Claims and voting

- **Goal/scope:** spoken/chat/action evidence submission and visible sequential ballots.
- **Dependencies/files:** 9.7 and 9.9; claim form, evidence metadata selection and vote view.
- **Acceptance:** no inferred server scope/author; exact visible IDs; own ballot only; technical failure distinct from social verdict/accepted violation.
- **Tests:** three evidence variants, 2/4/8 votes, ties/abstention/false claims/dedup/closed scopes/boundary races.
- **Approved UX:** exact manually entered spoken episode key, with no generation/inference/suggestion/automatic reuse. A deliberate subsequent manual entry remains possible; the server owns deduplication. Submitted identity clears.
- **Implemented:** shared singleflight controller intents; strict allowlisted own-ballot decoding (including frozen suspended ballots without withdrawal controls); receipt-anchored monotonic countdown; native labelled claim/evidence controls, exact retained chat IDs/authors and latest 50 fresh action command IDs. Drafts clear on authoritative version/pause/route/procedure changes; pending/obsolete votes never retarget or automatically retry. Technical acceptance is explicitly not a social verdict; current projected procedures show penalties.
- **Verification:** nine new Node tests; six real Chromium/HTTPS/PostgreSQL cases cover all evidence variants, 2/4/8-seat FIFO/own ballots, 0:0/nonzero ties, timeout, exact key clearing, backend dedup, accused/claimant penalty recipients, no-penalty tie and retained dealing-action rejection after actual first-round play. Existing engine/runtime/transport tests retain serialized boundary-race and remaining scope coverage; no fixture is called real transport integration.
- **Gates:** `npm run check` passes (366 Node tests pass, seven DB suites explicitly skipped); separate `npm run test:postgres` passes 182 tests; final full browser gate passes 65 tests. Database was a freshly initialized disposable PostgreSQL 14.5 cluster on loopback port 55439, database `penky_claims_test`, not a shared DB. Initial full browser run exposed narrow form overflow (fixed with scoped sizing); later regression runs had Windows Chromium target/worker crashes, with isolated rechecks and the final complete browser run passing. Nonfatal Vite closed-socket proxy warnings occurred during final cleanup.
- **Historical acceptance boundary — superseded by completion below:** the worker timed out after 30 minutes. The 65-pass browser run predates the final correction that captures a human draw ID and asserts `scope-closed`; the subsequent claims rerun failed with a database connection error and a Windows worker crash (two passed, two failed, two not run). Thus the gate results above are historical, not verification of the final test revision. Independent review approved social-outcome assertions but the latest closed-scope correction still requires successful execution and bounded follow-up review. Concurrent browser boundary-race coverage has not been demonstrated. Do not mark 9.10 complete or start 9.11 yet. No human assistive-technology/mobile-device acceptance, full UI match completion, withdrawal controls, schema/rule/server changes or full Stage 9 completion is claimed.

#### 9.10 acceptance completion

**Complete within approved scope.** Fresh corrected claims tests pass, including exact human-draw provenance and explicit `scope-closed`. Two additional real HTTPS/PG browser cases hold original outgoing frames and release claim-first/play-first, asserting accepted claim plus `procedure-active`, or accepted play plus `scope-closed`. A delayed ballot A must receive `stale-timer` after ballot B starts, without retargeting or answering B. These are controlled network delivery orders, not simultaneous resolver-overlap tests; existing runtime queue-gate tests cover that separate concern.

**Verified gates:** normal `npm run check`: 366 pass/seven explicit PG skips; dedicated `npm run test:postgres`: 182 pass; final complete Chromium suite: 67 pass, no retries. Tests used a newly initialized disposable PostgreSQL 14.5 cluster on loopback 55440, database `penky_claims_acceptance_test`. No schema, authoritative implementation, dependency or gameplay change. Independent read-only review approved corrected evidence, boundary assertions and early per-page interception; final synchronization follow-up also found no issues. Reviewers executed no checks independently.

**Failure history/fixes:** initial boundary tests failed because interception was installed after navigation; opt-in `prepareEach` installs before every page navigates, preserving defaults. Full gates first had dealing timeout/context disposal and drag readiness failures (65/67), then drag alone (66/67), then eight-seat FIFO timing (66/67). Isolated rechecks passed; drag now explicitly waits for the original draw acknowledgment, and claims await a distinct next claim identity rather than matching the old ballot's identical reason. Independent voters submit concurrently within the real ten-second deadline. Final full run passed all 67. No earlier failure is reclassified as passing. Nonfatal Vite closed-socket cleanup warnings remain.

**Next: 9.11 only.** No withdrawal controls, full browser-match/manual accessibility/native-device/production certification or Stage 9 completion claimed. Stop here.

### Increment 9.11 — Withdrawal

- **Goal/scope:** request/answer withdrawal and restore suspended ballot.
- **Dependencies/files:** 9.10; withdrawal controls and procedure/timer presentation.
- **Acceptance:** eligible approvals, unanimity, original remaining time on denial/timeout; stale responses never retargeted.
- **Tests:** approval/denial/silence/nested pause/queued withdrawal/punishment cutoff.
- **Risks:** separate withdrawal and suspended-ballot timers/answer maps must not be flattened.
- **Implementation/verification handoff (now verified; see completion below):** current own-ballot withdrawal requests and eligible approval/refusal controls use existing contracts; own approval and suspended own vote retain separate clocks. No authoritative queued-claim listing is invented. Seven new Node cases cover decoder privacy, exact nested remainders, false responses, disconnect uncertainty, stale procedure/epoch/rollback and delayed acknowledgments, plus an explicitly labeled queued-procedure presentation fixture. Actual queue/deferred-withdrawal ordering remains covered by existing engine tests, not a browser queue-list workflow.
- **Executed checks:** `npm run check` passes: 382 reported tests pass/seven explicit PG suite skips (withdrawal tests import the claims test helpers, so reported totals include those registered cases). Full Chromium/HTTPS/PG suite: 72 pass, including five real withdrawal cases for approval/denial/silence, nested suspension, exact original timer restoration/local zero and punishment cutoff. Independent read-only review initially found disconnect uncertainty and insufficient timer/boundary assertions; regression fixes and bounded follow-up addressed all findings. Reviewer executed no checks.
- **Historical verification blocker (resolved below):** standalone PostgreSQL gate is not green on this Windows Node 26 environment. Initial run: 180 pass/two reported failures (connection-loss child test plus parent suite), because expected connection-error wording did not accept `write ECONNRESET`. Two subsequent full runners stalled in transport and were stopped after command limits; a bounded serial run also exceeded its command limit. No assertion or authoritative implementation was changed to conceal this. Tests used only a freshly initialized disposable PostgreSQL 14.5 cluster on loopback 55441 (`penky_withdrawal_test`). Stage 9.11 remains incomplete pending a successful integration gate or an explicit decision on the unrelated environment/test blocker; do not start 9.12. No commit/push completion claimed.

#### 9.11 acceptance completion

**Complete within approved current-procedure UI scope.** Fresh database-enabled `npm run check` against an isolated tmpfs PostgreSQL 18 container on loopback 55442 (`penky_withdrawal_test`) passed **564 tests/no skips**, including all 182 real PostgreSQL integration cases, plus format/lint/types/server+client builds. Dedicated PostgreSQL runner was not separately repeated in this completion pass because its cases ran in that gate. Final full Chromium suite passed **72 tests/no retries**. Earlier PG14.5/Windows failures and stalls above are retained, not relabeled. No server/schema/rule/dependency change was needed.

Independent read-only review found no outstanding withdrawal source/privacy/timer issue. Browser reruns exposed old claims-test action/state-gap races: editing version-keyed forms before the draw baseline, and assuming transient vote-feedback text survives procedure change. Tests now wait for exact accepted vote request receipts and the corresponding rendered head, or the draw acknowledgment and claimant deck baseline. Two full browser runs first reported 70/72, with an intermediate focused recheck failing; these are not claimed as passing. Final complete run passed all 72. Existing FIFO/duplicate/evidence assertions remain intact; no synthetic outcomes or automatic gameplay retry were added.

Queued-procedure presentation remains explicitly fixture-based, complemented by real engine queue/deferred-cutoff tests; no new authoritative queue listing is claimed. Native-device/manual assistive-technology/full-match certification remains deferred. **Next: 9.12 only; stop here.**

### Increment 9.12 — Presence, reconnect and replacement controls

- **Goal/scope:** user-facing suspension, multiple absences, replacement voting and human handback; no bot decisions.
- **Dependencies/files:** 9.4, 9.6 and 9.11; presence/replacement views and existing reset handling.
- **Acceptance:** frozen nested timers, state-only reconnect, server-checked proposal eligibility, replacement cancellation/handback.
- **Tests:** multiple tabs/absences, strictly >30s boundary, replacement timer during pause, return cancellation and no-human pause.
- **Risks:** no server absence timestamp is projected; use proposal feedback, not an invented authoritative countdown. Autonomous continuation remains Stage 10.
- **Status: complete within approved UI scope.** Allowlisted presence/controller state and own-only replacement votes render in `PresenceView`; proposals and ballots use existing captured game/branch/procedure contracts, human/active guards and shared singleflight. Server checks absence eligibility; no absence clock is fabricated. Replacement time advances independently during gameplay suspension, local zero never completes the vote, and return/reconnect cancels replacement or restores human control through existing queue semantics without replay.
- **Coverage:** six new Node cases cover strict privacy/timer parsing, independent countdowns, invalid actors/answered ballots, too-early feedback, lost/mismatched/delayed acknowledgments, epoch/branch/procedure invalidation and no replay. Two real HTTPS/PG/Chromium cases verify last-tab departure, multiple absences, nested timer freezing, running replacement countdown/local zero, return cancellation, timeout/tie, assignment, no-human suspension and human handback/state-only reconnect. Exact 30000ms rejection/30001ms acceptance remain runtime tests; browsers use real elapsed >30 seconds. No injected runtime-clock fixture was ultimately added. A private test-harness SQL assertion reads only the committed clock discriminator while all humans are absent; no private frame is sent to a browser.
- **Verification:** final database-enabled `npm run check`: **579 pass/no skips**, including all 182 PostgreSQL integration cases; final complete browser suite: **74 pass/no retries**. Dedicated PG runner was not separately rerun because its cases ran in the gate. A new disposable tmpfs PostgreSQL 18 container on loopback55443 (`penky_presence_test`) was used. Independent read-only source/acceptance reviews found no issues and ran no checks. Final normal `npm run check`: **397 pass/seven explicit PG skips**; no rule/server/persistence/schema/dependency change or bot decision code added.
- **Regression history:** first full browser run73/74 failed an old synthetic drag using offscreen physical table coordinates after the new panel expanded layout; reproduced2/2. Test uses the existing fixed table drop strip, retains all movement/one-command assertions, and passes2/2. Second full run73/74 failed the old cutoff case; reproduced in isolation. Independent voters now click concurrently within the real ten-second deadline, retaining exact held-request/`punishment-started`/persistent-penalty assertions. Focused recheck and final full74/74 pass. Both bounded test fixes were independently approved; no failure is reclassified as passing.
- **Next: 9.13 only; stop here.** Manual assistive-technology/native-device/full UI match/production certification and autonomous bots remain deferred.

### Approved prerequisite 9.13p — Bounded metadata history pagination

**Authorization/scope:** after early 9.13 measurement, the operator explicitly approved a separately scoped pagination contract extension. This prerequisite is one increment; the 9.13 browser timeline and 9.14 rollback controls are not implemented here. Existing full-history/rollback contracts, storage and engine/runtime rules stay unchanged.

**Measured blocker:** trusted legal 2/4/8-seat completed-match history envelopes plus outbound allowance measured 24,062/28,608/58,625 bytes; one retained fork measured 39,956/47,425/97,174 bytes. Eight-seat abandoned history exceeds the legacy 65,536-byte delivery ceiling. No UI code was added before seeking approval.

**Implemented contract:** additive `owner-history-page` with strict null/64-hex-snapshot+offset cursor and 1–100 entry limit; request-correlated page/stale/unavailable result. Whole allowlisted history is projected before flattening ordered branch descriptors, complete rows and rollback audits; inherited origins and exact active/open selectors are unchanged. SHA-256 over the complete public projection binds continuation to actions/forks/audit and same-head closure. Every page reauthorizes current-game owner access inside the existing committed wire slot. No split/truncation/skipping or stored pagination state; full projection remains O(total history) per page, not a CPU/memory-bound streaming reader.

**Status: complete.** Six new protocol/pager cases cover strict cursors/limits, lossless reconstruction of synthetic and real legal eight-seat retained histories, exact byte/Unicode/atomic-item bounds, empty-action branches, freshness including same-head closure, recovery and private-extra exclusion. Six real TLS/PostgreSQL cases cover correlated multi-page owner traversal and byte bounds, null/finished/abandoned/closed metadata, stale continuation on action/fork/closure/recovery, fresh authorization/revocation/current-game checks and tiny-budget terminal fallback. Existing rollback/history APIs remain covered by the full suite.

**Verified gates:** database-enabled `npm run check`: **591 pass/no skips**, including all188 PostgreSQL cases. Dedicated PG runner was not separately repeated because its cases ran in that gate. A new disposable tmpfs PostgreSQL18 container on loopback55445 (`penky_history_page_test`) was used. Final normal `npm run check`: **403 pass/seven explicit PG skips**. Browser tests were not rerun: this prerequisite changes no browser code and its network behavior is verified by actual TLS/PG scenarios. Independent read-only review found one P1: tiny configured budgets silently suppressed oversized correlated failure replies. A failing transport regression reproduced it; fixed bounded unavailable error or disconnect provides a terminal outcome, and follow-up review found no issues. The below-minimum-error disconnect branch is implemented but not independently integration-exercised. Reviewer executed no checks. A full transport attempt during implementation timed out; final complete database-enabled gate passed. Final gate initially caught formatting in `transport.ts`; formatted and reran the complete gate successfully.

**Limits/next:** wire bytes, not full-history CPU/memory, are bounded. Histories changing during traversal require explicit restart; an indivisible oversized row fails unavailable. No UI/rollback dispatch, persisted pagination session, engine rule, schema or dependency change. **Next: resume 9.13 browser timeline using the approved paged reader; stop here.**

### Increment 9.13 — Metadata owner timeline

- **Goal/scope:** current-match owner action/branch browsing and selectable completed-action rollback targets.
- **Dependencies/files:** 9.4, 9.7 and completed approved prerequisite 9.13p; metadata history view and ordinal target presentation.
- **Acceptance:** owner-only, active/abandoned labels and closure; no faces/handles/previews/other ballots, including historical own cards.
- **Tests:** nonowner denial, finished owner, null pre-creation state, abandoned/read-only and closed targets.
- **Risks:** the legacy whole-history endpoint remains frame-bounded; use the newly approved paged reader. Restart stale traversals explicitly, preserve complete page/branch/audit order, and do not silently truncate data. Early size measurements and pagination approval are recorded in 9.13p.
- **Status: complete within approved browser scope.** `OwnerHistory` strictly decodes every public summary/record, reconstructs pages in order under one matching snapshot/head/closure, and permits only supplied active/open completed-action selectors after full traversal. Explicit refresh/next-page use the shared receipt-aware singleflight connection. Metadata never installs a historical head as live state. New authoritative state/action, epoch/route/rollback, disconnect, malformed/stale page and refresh invalidate traversal/selection. Owner membership controls presentation only; server still authorizes access. No rollback command is sent.
- **Coverage:** eight new Node cases cover all summary variants/private extras, cross-page identity/progress/order, target eligibility, delayed/mismatched delivery sequencing, unchanged live head, disconnect/reset and closure. Three Chromium cases include one real HTTPS/PG owner read/nonowner denial and authenticated Node rollback precondition for null/abandoned history (not browser rollback), plus two explicitly engine/projector wire-fixtured finished-owner/large-retained-history cases for paging, audit/target labels, closure/stale refresh, narrow keyboard selection and privacy. Finished-match browser setup is fixture-based, not a real UI-completed match. Four-seat DOM measurement is not claimed.
- **Measurements (fixture evidence, 360px):** eight-seat retained history:33 pages,156,768 serialized bytes,646 rows,3,277 DOM nodes,3,382ms observed traversal/render; two-seat finished history:5 pages,32,369 bytes,99 rows,698 nodes,407ms. Document width360px and history client/scroll width280px in both. These are observations, not performance guarantees or new acceptance thresholds; no metadata is truncated.
- **Verification:** database-enabled `npm run check`: **608 pass/no skips**, including all188 PostgreSQL cases; final complete browser suite: **77 pass/no retries**. Final normal `npm run check`: **420 pass/seven explicit PG skips**. New disposable tmpfs PostgreSQL18 loopback55446 (`penky_timeline_ui_test`) only. Dedicated PG runner not separately repeated because its cases ran in the gate. Independent review found one P2: rollback audit labels used all-record indexes instead of audit-only ordinals. A failing browser regression reproduced it; a linear audit-only counter and exact summary/label/sequential assertions fix it. Follow-up review found no issues and ran no checks. No server/protocol/schema/dependency/game-rule change.
- **Next: 9.14 only; stop here.** No rollback dispatch/confirmation, account recovery, manual assistive-technology/native-device/full UI-match or production certification.

### Increment 9.14 — Owner rollback and interaction invalidation

- **Goal/scope:** warning/confirmation, exact selector submission, authorized notice and usable restored client.
- **Dependencies/files:** 9.8, 9.11, 9.12 and 9.13; rollback confirmation/notices and central interaction reset.
- **Acceptance:** clear gestures/evidence/procedure selection and old pending work; keep chat; no private-observation replay, automatic stale-selector retarget or promise of erased human knowledge.
- **Tests:** scenarios 17–18, stale targets/retries/retained branches/null state/disconnected restored participants/timer remainder.
- **Risks:** presence is live, not rollbackable; cached UI is never an authoritative restored snapshot.
- **Status: complete within approved browser scope.** Native modal confirmation captures the exact selected history snapshot/selector and warns that seen cards/trump cannot be forgotten. Changed selection/history cannot confirm or retarget. A sent request freezes its ID/target/true warning in mounted memory for explicit uncertain retry; no automatic replay or cross-reload recovery is promised. Acknowledgments never install historical heads as current state. Fresh strict metadata notices display actor/ordinal target/result to authorized participants; duplicates/resync do not recreate notices or private observations.
- **Invalidation:** interaction revision clears uncontrolled evidence forms and gestures, procedure/card/history selections and obsolete pending work. Retained lobby chat, exact messages and original contexts remain separate. Authoritative branch/state delivery restores gameplay, including null state; live presence is not restored from history. No server/protocol/persistence/schema/dependency/game-rule change or 9.15 work.
- **Coverage:** four new rollback Node cases plus updated connection/withdrawal fixtures cover exact warning capture/stale refusal, immutable retry across reconnect/fork, historical acknowledgment isolation, fresh notice privacy/duplicate suppression and reset/chat preservation. Reported suite counts include imported test-helper registrations. Four Chromium cases: two real HTTPS/PG flows for native cancel/focus, lost committed acknowledgment/exact retry, null/fork/chat/participant notices and stale confirmation/evidence reset; two explicitly engine/runtime-projector wire fixtures for scenarios17–18 (table/private-hand/N/turn restoration and finished-state rollback to six-second ballot with current absent participant). Fixture scenarios are not real UI-completed matches.
- **Verification:** database-enabled `npm run check`: **629 pass/no skips**, including all188 PG cases; final complete browser suite: **81 pass/no retries**. Final normal `npm run check`: **441 pass/seven explicit PG skips**. Disposable tmpfs PostgreSQL18 loopback55447 (`penky_rollback_ui_test`) only; dedicated PG runner not separately repeated because cases ran in the gate. Independent read-only review found no source issues. Full gate initially628/629 failed an older withdrawal test's empty notice fixture; strict new parsing correctly rejected it. The fixture now supplies a valid allowlisted notice, while malformed-extra rejection remains separately tested; bounded follow-up approved the correction. First browser gate80/81 failed an existing real peek/penalty case; isolated recheck and final complete rerun pass without production/test changes to that case. Reviewers ran no checks independently; no failed run is relabeled as passing.
- **Next: 9.15 only; stop here.** Reload/unmount loses uncertain rollback references; inspect fresh history/state before a new action. Native-device/manual assistive-technology/full UI-match/production certification remains deferred.

### Increment 9.15 — Results and successor

- **Goal/scope:** existing result variants and agreement-gated next match.
- **Dependencies/files:** 9.3, 9.7 and 9.14; result/successor views and current-game transition handling.
- **Acceptance:** honest last-player/all-won/draw display; rollback until actual next start; exact finished head/stable retry; no repeated consent reset or regression to old acknowledged match.
- **Tests:** results, stale head/start races, failed/uncertain starts, new-member reset and state-only successor.
- **Risks:** revision-1.4 repetition losers/minigame stay deferred; no UI-only rule substitution.
- **Status: complete for existing executable revision1.3 contracts.** Strict detached results retain phase compatibility and display last-player loser, all-won, and draw/remaining seats with earlier winners preserved. No remaining draw participants are relabeled losers and no minigame is invented. Owner successor submission captures the exact observed finished BranchHead and request ID once; explicit uncertain retries remain immutable in mounted memory. First-start persisted format stays unchanged. Reload/unmount loses successor retry references; no automatic resend/retarget or historical acknowledgment regression.
- **Consent/adoption:** explicit agreement snapshots remain server-authoritative for all durable members. Failed admission preserves the original writer/rollback window and consent; real new membership resets consent, and actual successful start resets it once. Matching accepted start acknowledgments trigger fenced state-only resync, never installation of their historical game ID. Actual successor identity resets old gameplay interactions while chat/original contexts remain separate.
- **Coverage:** three new focused Node cases cover result variants/privacy, immutable successor request/retry lifecycle and historical start acknowledgment fencing. Four explicitly engine/projector wire-fixture browser cases cover all result variants/prior winners plus failed/uncertain start/retry/fork/historical acknowledgment behavior; these are not real server start/consent evidence. Two additional real HTTPS/PG browser cases finish precondition matches through authenticated Node seat-local observations/remembered reveal (not UI-completed matches), then verify browser consent/new-member reset, not-ready denial preserving rollback/revision, lost committed acknowledgment and exact retry, exactly-once reset, state-only successor adoption, a later actual successor with historical original retry, and held UI start losing to real authenticated rollback with stale-head rejection.
- **Verification:** database-enabled `npm run check`: **632 pass/no skips**, including all188 PG cases; final complete Chromium suite: **87 pass/no retries**. Final normal `npm run check`: **444 pass/seven explicit PG skips**. Fresh disposable tmpfs PostgreSQL18 loopback55448 (`penky_successor_ui_test`) only; dedicated PG runner not separately repeated because cases ran in the gate. Initial independent review found no source bug but blocked on missing real integration; the two real tests resolve it and follow-up review found no issues. Reviewer executed no checks.
- **Regression history:** first full browser86/87 failed an older claims FIFO test; isolated reproduction and reviewed waits for the first accepted acknowledgment/rendered head and exact first-ballot vote receipts fix the version-keyed-form race without weakening FIFO/dedup assertions. Next full86/87 exposed an older withdrawal test reading the pre-withdrawal wire ballot during an action/state gap. It now waits for a new resumed claim-vote after the captured frozen-procedure index before unchanged remainder/own-vote assertions. Focused and final full87/87 passes; both test-only synchronization fixes independently approved. No earlier failure is reclassified as passing.
- **Next: 9.16 only; stop here.** Full UI-completed match matrix/native-device/manual accessibility/production certification remain deferred; revision1.4/Stage11a untouched. No server/protocol/schema/dependency/game-rule change.

### Increment 9.16 — Browser acceptance gate

- **Goal/scope:** integrated functional Stage 9 verification and confirmed integration fixes only.
- **Dependencies/files:** all earlier increments; browser suites/CI and materially affected coverage/operations docs.
- **Acceptance:** isolated 2/4/8 browser contexts complete UI-driven matches, violations/procedures/reconnect/rollback; record manual keyboard/touch/layout/usability evidence separately.
- **Tests:** actual HTTPS/disposable PG browsers, uncertainty/stale stream/privacy, representative agreed browser matrix and Node transport regressions.
- **Risks:** trusted backend match-finishing/fixtures or screenshots alone are not browser acceptance; replacement orchestration does not certify Stage 10 bot continuation or production security.
- **Operator-approved acceptance matrix:** Chromium desktop, narrow viewport and emulated touch, including UI-driven 2/4/8-seat complete matches. Manual usability, native devices, Firefox and Safari remain explicitly **unverified**, not passed. Approval followed a pre-implementation pause; the earlier partial four-seat red scaffold stopped after dealing at `trump-reveal` and was not completion evidence. This boundary does not authorize Stage10 or broaden game rules.
- **Status: complete for that approved matrix.** Three real HTTPS/PG tests in `tests/browser/acceptance.spec.ts` bootstrap identities/lobby/agreements/start and perform every gameplay mutation through native browser controls, using only public DOM, actor-own DOM and remembered timed reveal. There is no engine/trusted-state/Node socket gameplay driver or fabricated state lane. A finite1000-move bound and per-command accepted/head guards fail rather than silently retry. Legitimate repetition draws count as existing executable match completion, not an invented end shortcut.
- **Integrated evidence:** 2seats includes one genuinely lost draw acknowledgment, explicit reconnect/no draw resend and completion; 4seats composes exact retained chat, claim/vote/withdrawal, nested disconnect suspension, >30s replacement cancellation plus completed assignment/human handback, deliberate wrong draw/queued penalty with private reservation/transfer, real owner timeline/warning/rollback, retained abandoned chat/context and continued complete play; 8seats includes360px no-overflow and CDP-emulated touch draw. Native keyboard draw is exercised separately from mouse clicks. Every seat's wire observations are checked before and after final state-only resync; recipient authorization binds peek requests to their actual originating page. No private observation replay is allowed. Existing narrower tests cover additional drag/pointer/uncertainty/late-scenario boundaries and are not relabeled as full-match evidence.
- **Final-run observations:** 2seat24.3s,31plays/5pickups/2opens, last-player result; 4seat1.5min,83plays/62pickups/2opens after integrated procedures, repetition draw; 8seat4.0min,198plays/160pickups/14opens, last-player result. These randomly dealt match observations are not performance guarantees. Driver empty-hand opening relies on settled rule§6.3 automatic pickup, not inferred unobserved round rights or a production legality hint.
- **Verified gates:** final database-enabled `npm run check`: **632 pass/no skips**, including all188 PostgreSQL cases; final normal gate: **444 pass/seven explicit PG skips**; final full Chromium suite: **90 pass/no retries** (17.6min). New isolated tmpfs PostgreSQL18 container on loopback55449 (`penky_browser_acceptance_test`) only. Dedicated PG runner was not separately repeated because cases ran in the gate. CI PostgreSQL job limit15→45min accommodates serial database/full-UI gates; GitHub-hosted CI execution itself is not claimed. Nonfatal Vite socket-reset cleanup warnings occurred.
- **Review/failure history:** initial incomplete red stopped at trump reveal; subsequent driver timeout/inferred-round errors and expensive privacy assertion bookkeeping were addressed only in test code (equivalent strict Node assertions, finite600s full-match limit). A four-seat integrated assignment originally left one of three eligible voters unanswered; all three now reply before expecting assignment. Reviewer P2 gaps required privacy revalidation after resync and actor-bound peek authorization; both fixed and independently approved. Full suites then89/90 failed older peek-refusal and eight-seat claim helpers. Committed-head waits after each refusal and queued-claim acknowledgment/head fencing before voting preserve all original assertions; focused rechecks and independent reviews passed. One subsequent full invocation ended without terminal result after all three matches; its process/container were gone and it is recorded as interrupted, not passed. Fresh environment final full90/90 and both repository gates passed. Reviewers ran no checks independently. No production code, dependencies, contracts, rules, bots or next-stage implementation changed.
- **Next: Stage10 constrained bot observations, as a separately scoped increment only. Stop here.** Stage9 completion is limited to the approved automated matrix; manual usability, physical touch/native devices, Firefox/Safari, human multiplayer playtest, load/security/production certification and revision1.4/minigame remain unverified/deferred.

**Default order:** 9.1 → 9.16, one per run. Chat/history can be scheduled once their explicit prerequisites exist; this does not authorize overlapping writers. Outstanding decisions remain scoped to their increment: fresh-peek display, spoken episode UX, practical history-size handling and broader browser/visual acceptance. No new game rules, recovery/discovery APIs, live push, server timing fields or redundant routing are inferred.

### Overall Stage 9 checklist

- [x] Build lobby creation/joining, seat identity, owner controls, editable house-rule text, and readiness reset. Verified lobby/start/agreements scope in 9.1–9.4; owner history/rollback remains the separate item below.
- [x] Build a simple functional table before polished 3D rendering. Ordered public table and click/drag interactions verified in 9.7–9.8; full UI-match acceptance remains 9.16.
- [x] Implement draw click/drag, hand play, take-bottom, and own-stump click. Click controls verified in 9.7; deck/hand drag equivalence in 9.8.
- [x] Permit specified rule-breaking attempts; do not add legality hints that remove the game's observation/memory challenge.
- [x] Show the private initial-recipient notice and one-time 10-second final-card reveal; omit permanent trump and dealing-turn indicators.
- [x] Add chat, read-only in-match house rules, accusations, votes, withdrawal, and penalty-card selection/refusal. Chat (9.9), original match terms (9.3) and penalties (9.6) are verified; accusations/votes (9.10) are verified; withdrawal (9.11) is verified.
- [x] Add suspension/reconnect and bot-replacement controls. Verified in9.12 and integrated UI-only flow9.16; no autonomous bot decisions.
- [x] Add a redacted owner timeline, branch labels, rollback target selection, warning, and confirmation. Verified9.13–9.14 and integrated9.16.
- [x] Clear pending local gestures/animations on authoritative rollback or resync. Current gestures verified in 9.8; future animation work must preserve this invariant.
- [x] Keep transient visual interaction state separate from server state; do not optimistically expose secrets.

**Exit criteria:** humans can complete full matches, punish violations, replace a disconnected player, and roll back without developer-only tools.

## Stage 10 — Bot with constrained observations

**Depends on:** Stages 8–9; replacement orchestration is implemented in Stage 6.

**Status: 10.1–10.7 implemented; verification recorded below.** D006–D012 approve constrained memory, atomic capture, fenced runner/dealing/legal play with explicit unknown-right waiting, and conservative procedure decisions. Increments10.8–10.9 remain unimplemented.

### Existing foundations and constraints

- Reuse `src/projections/game.ts`, `live.ts` and `actions.ts` for seat-authorized current and fresh observations. Raw `GameState`, runtime publications, checkpoints, histories and action batches must never become policy inputs. Projectors are not themselves bot-memory or delivery-freshness APIs.
- Reuse `src/game/cards.ts` for pure comparison, and ordinary serialized `GameRuntime.dispatch` with bot controller/branch binding and queued admission. Do not introduce a parallel rules engine or ordinary-human turn/version restrictions.
- Reuse runtime/host subscriptions, replacement, handback, recovery and successor lifecycle seams. A controller check alone does not fence a bot→human→bot ABA transition: capture decision/controller tenure and revalidate inside the queue before receipt lookup. Already-admitted atomic actions drain; obsolete unadmitted work is canceled.
- `src/server/external-match.postgres.test.ts` and `tests/browser/acceptance.spec.ts` supply observation-driven test strategies, not production bot interfaces. Proposed `src/bots/` paths below do not yet exist.
- Preserve no-human suspension, fixed N, opaque hidden IDs, nested timers, committed publication and atomic persistence. Bot decisions, randomness and timers remain server-authoritative. No new dependencies, accounts, services, minigame strategy or revision-1.4 result substitution belong here.

### Decisions required before autonomous execution

| Decision | Required resolution / conservative proposal |
| --- | --- |
| Observation entitlement     | Resolved: committed observations legitimately available to the seat, not confirmed network deliveries. Neither proves the human saw them. See D006.                                                                                                                                                                                                                               |
| Rollback knowledge | Resolved in D007: restore exact previously captured permitted memory at the rollback target; missing checkpoints stay unknown. Never reconstruct abandoned-future secrets or enrich from private authoritative history. |
| Durability and legacy games | Resolved in D008: runtime-owned memory in the existing atomic frame transaction, explicit versions with legacy unknown knowledge, exact prior checkpoint rollback, corrupt/unsupported memory fails recovery. No private-history enrichment. |
| Claim/withdrawal policy | Resolved D012: explicitly abstain on all eligible unanswered claim ballots without evidence inference; explicitly approve eligible unanswered withdrawal consent; retain penalty refusal without contribution strategy. Never originate claims/withdrawal requests or human-only replacement votes. |
| Unknown knowledge | D010 resolves dealing fallback: wait when order is unknown until fresh permitted observation establishes it, even if stalled. Unknown trump stays distinct from known no-trump; no authoritative next-recipient/trump shortcut. |

These are approval gates, not permission to invent game rules. Add the chosen decisions to the existing decision workflow when resolved; significant interfaces and persistence changes still require explicit approval.

### Increment 10.1 — Seat-constrained observation boundary

- **Goal/scope:** pure policy-input adapter and narrow observation contract; no scheduler or autonomous commands.
- **Dependencies:** existing projectors; resolved observation-entitlement semantics.
- **Expected files/modules:** proposed `src/bots/observation.ts` and tests; relevant projection tests and architecture documentation.
- **Acceptance:** policy receives only current seat-authorized data, never raw state/history/publications or other seats' private cards/ballots. Detached inputs cannot mutate authority. Hidden-state differences cannot affect otherwise identical permitted observations.
- **Required tests:** failing public-interface privacy tests first at 2/4/8 seats; finished seats, procedures, timed reveals, private transfers and invalid viewer binding.
- **Risks:** private data hidden inside a nominally safe wrapper; treating historical/recovery information as a fresh disclosure.
- **Verification:** test-first missing-module failure recorded; final `npm run check` passes **460 tests/seven explicit database skips**, including all16 adapter cases, format/lint/types/build. No database/browser tests required or run for this pure boundary. Independent review found coverage gaps (finished-seat privacy, transfers/detachment, populated answers, reveal lifecycle); focused assertions added and gates rerun; final independent read-only review approved with no remaining issues. Later memory policy remains unresolved; next increment10.2 requires an explicit rollback-knowledge decision.
- **Implementation:** `src/bots/observation.ts` composes existing current/action projectors with explicit seat binding (including finished seats; null state invalidates binding). Outputs alone are policy inputs; raw snapshots/action pairs remain trusted adapter inputs. No capture integration, memory, persistence, scheduler or autonomous commands.
- **Coverage:** 16 bot-boundary cases cover 2/4/8-seat procedures, current reveals/expiry, finished-seat visibility, detached outputs, hidden-face noninterference, invalid binding, private transfers and duplicate suppression. Existing projector suites remain the detailed disclosure regression coverage. Stateless adapters cannot prove commit/freshness; callers must not replay history during recovery.

### Increment 10.2 — Pure permitted-memory reducer

- **Goal/scope:** accumulate only approved observations per game/seat, independently of current human/bot control; no autonomous execution.
- **Dependencies:** 10.1 and explicit rollback-memory policy.
- **Expected files/modules:** proposed `src/bots/memory.ts` and tests; decision/coverage documentation.
- **Acceptance:** record observed dealing progress, legitimately observed trump and necessary opening-right history with provenance. Unknown knowledge stays unknown. Duplicate observations and rejected draws do not advance dealing memory. Branch transitions follow the chosen policy without private-history enrichment.
- **Required tests:** initial notice, successful/rejected draws, interrupted reveal, duplicate delivery, recipient-private observations, consumed/preserved opening rights and rollback branches.
- **Risks:** face inference from opaque IDs, authoritative trump lookup or incomplete round observations masquerading as knowledge.
- **Implementation:** pure `src/bots/memory.ts` records dealing progress/next observed recipient, observed trump (including known no-trump) and conservative own opening-right provenance. Controller identity is irrelevant. Same-head duplicates do not advance actions; gaps discard continuity. Rights are inferred only at a contiguous play-only exact round completion, consumed by legal opening, preserved through hand obstruction; generic/complex boundaries stay unknown. Matching final own private draw can establish trump; another seat's redacted draw cannot. Branch restore uses an exact trusted prior permitted checkpoint; no archive reconstruction, runtime integration, persistence or commands.
- **Verification:** missing-module red recorded before implementation; seven reducer cases pass: six at 2/4/8 seats using explicitly synthetic permitted-observation transitions plus one real engine/projector boundary composition (not network/DB integration). `npm run check`: **467 pass/seven explicit database skips**, format/lint/types/build passed. Database/browser integration not required or run for this pure increment. Independent review identified stale continuity from duplicate-redacted captures; unseen heads with empty captures now conservatively clear dealing/opening knowledge, with regressions. Added real engine/projector boundary coverage plus missing/mixed capture negatives. Final independent read-only review approved with no remaining issues.
- **Next:** 10.3 requires separate storage ownership/versioning, atomic commit coupling and legacy/missing-memory decisions. Stop after10.2; no runtime capture or persistence format authorized.

### Increment 10.3 — Durable memory capture and recovery

- **Goal/scope:** make approved seat memory recoverable at the same authoritative commit boundary as the actions producing it; not a general history redesign.
- **Dependencies:** 10.2 and separately approved storage ownership/versioning/legacy-game policy.
- **Expected files/modules:** relevant runtime/checkpoint and `src/persistence/postgres.ts` seams, host integration and proposed bot-memory persistence tests. Add a migration only if the approved design requires one.
- **Acceptance:** failed commits publish neither new state nor new knowledge. Fresh-process recovery restores only approved memory without replaying raw archives as fresh observations. Missing/legacy knowledge follows the explicit policy.
- **Required tests:** disposable real PostgreSQL commit failures, fresh-process recovery, duplicate receipts, missing/legacy memory, rollback checkpoints and same-head controls.
- **Risks:** second writers, non-atomic subscription writes, persistence compatibility and unbounded retained-memory growth. This slice bounds knowledge persistence, not all history resources.
- **Status: verified.** Runtime checkpoint version2 embeds memory schema version1, captured for every seat independently of subscribers/controllers via existing permitted adapters/reducer. Exact action captures and same-head current observations join the existing frame transaction before publication. A256-entry FIFO retains pre-command knowledge; eviction never removes game history and missing targets restore unknown. Version1 checkpoints remain supported with unknown knowledge. Recovery/rollback suppress historical transient disclosure; no archive observations become fresh. Strict storage validation binds shapes, capacity, game/seat/head, command targets and source ancestry. No SQL migration, network payload, host writer, scheduler or bot command is added.
- **Verification:** worker test-first implementation and normal `npm run check`: **475 pass/nine explicit DB skips**; focused disposable PostgreSQL suite **16 pass**. Parent final database-enabled `npm run check`: **665 pass/no skips**, including format/lint/types/tests/build. Fresh PostgreSQL18 tmpfs container `penky-memory-103-test`, loopback55453, database `penky_memory_test` only. No browser/manual tests run. Independent read-only review found no issues and approved subject to gates, now passed.
- **Failure history:** first database gate reached665 test passes but the200-second tool timeout prevented a verified full gate/build completion. Second gate failed an existing host corrupt-recovery cleanup assertion (backend count1 versus0); isolated host suite passed23/23 without changes. Fresh final full gate passed665/no skips and build. No test assertions were weakened or production cleanup code changed.
- **Next:10.4 only**, after explicit conservative penalty-refusal policy and bot-specific queued admission/exact-head decisions. No autonomous execution is authorized by10.3.

### Increment 10.4 — Serialized bot runner and one safe action

- **Goal/scope:** first autonomous vertical slice: replacement leads to one eligible bot penalty refusal, then human handback.
- **Dependencies:** 10.3 and approval of this conservative refusal policy.
- **Expected files/modules:** proposed `src/bots/runner.ts`, host lifecycle integration and focused runtime tests.
- **Acceptance:** ordinary dispatch binds server-owned seat, bot controller and branch. Queued admission checks captured writer/game/branch/controller tenure and decision cancellation token. Handback, pause, rollback, recovery and successor invalidate obsolete work; no-human suspension remains intact.
- **Required tests:** replacement→refusal→human return, queued handback, bot→human→bot ABA, duplicate publications, stale decisions, no-human pause and already-admitted atomic completion.
- **Risks:** outside-queue authorization, duplicate scheduling and subscription feedback loops. Decide bot-specific exact-head admission explicitly; do not change ordinary-human command semantics.
- **Status: verified.** D009 approves only eligible unanswered penalty refusal. `src/bots/runner.ts` passes seat-projected current views to the policy; dispatch binds server-owned seat, bot controller, branch and cancellation signal. `GameRuntime.botAdmission` checks runtime instance, exact head, committed publication sequence, controller tenure, pause and cancellation inside the queue before receipts. Controller transitions fence ABA; new publications cancel/reconsider unadmitted work. Admitted atomic completion drains. Host installs runners only on live entries and stops them before release; recovery/successors get new fences. Human command semantics, no-human suspension and persistence/network formats are unchanged.
- **Verification:** test-first focused runtime/runner suites89 pass; final focused runner10 pass and real PostgreSQL host25 pass. Parent final database-enabled `npm run check`: **677 pass/no skips**, format/lint/types/tests/build passed. New disposable PostgreSQL18 tmpfs container `penky-runner-104-test`, loopback55454, database `penky_runner_test` only. Parent normal `npm run check`: **485 pass/nine explicit database skips**, including build. No browser/manual tests or complete autonomous matches claimed.
- **Review:** initial independent review confirmed policy/fences but found autonomous dispatch failures bypassed host invalidation. Both runner installations now report to non-awaited epoch-fenced host health cleanup. New real PostgreSQL failure regression requires invalidation without another host request, no draft publication, safe recovery and exactly one committed refusal. Follow-up read-only review approved with no remaining issues. Earlier pre-fix full database gate passed676; final677 includes the regression.
- **Next:10.5 only:** legal dealing and reveal observation, with no play/ballot/claim-policy expansion. Stop after10.4.

### Increment 10.5 — Legal dealing and reveal observation

- **Goal/scope:** bots take their dealing turns and remember the permitted final reveal; never submit timer-expiry commands.
- **Dependencies:** 10.4.
- **Expected files/modules:** proposed dealing policy module, observation/memory tests and runtime integration tests.
- **Acceptance:** draw only from the personal initial notice or remembered successful clockwise draws. Wait through authoritative reveal/procedure boundaries. Never read hidden dealing order, fabricate a permanent dealing-turn hint or recover historical trump from authoritative state.
- **Required tests:** 2/4/8 seats, two stump passes, unequal final hands, rejected draws, replacement during dealing, suspended reveal and unknown-memory recovery.
- **Risks:** deadlock with unavailable historical knowledge; missing observations must use the approved fallback, not privileged hints.
- **Status: verified.** `src/bots/dealing.ts` chooses draws only from the personal initial notice or permitted clockwise-draw memory for the exact current seat/game/branch/head. Unknown knowledge waits (D010), including legacy recovery. Procedures, pause and reveal prevent drawing. Runner retains refusal and existing bot admission/cancellation/error-cleanup fences. `readBotMemory(seatId)` returns detached seat-only memory installed with the committed snapshot after persistence, never staged/failed knowledge. Existing permitted reveal capture remembers trump; no historical reconstruction, next-recipient hint, expiry command or play policy is added.
- **Coverage:** nine `runner-dealing.test.ts` cases include real engine/projector/runtime 2/4/8-seat dealing, separate stump passes, unequal final hands, replacement, rejected/duplicate draws, unknown legacy recovery, suspended reveal and blocked/failed-commit memory privacy. One additional real PostgreSQL host case verifies installed-runner dealing, durable receipts, recovery and no repeated draw after continuity is lost.
- **Verification:** worker test-first focused50 pass and PostgreSQL host26 pass; parent normal `npm run check`: **494 pass/nine explicit DB skips**; final database-enabled `npm run check`: **687 pass/no skips**, format/lint/types/tests/build passed. New disposable PostgreSQL18 tmpfs container `penky-dealing-105-test`, loopback55455, database `penky_dealing_test` only. Independent read-only review found no issues. No browser/manual or complete autonomous-match acceptance claimed. Missing order can intentionally stall until a permitted fresh observation; no private fallback is invented.
- **Next:10.6 only**, legal round play and stump opening using permitted memory. Stop after10.5.

### Increment 10.6 — Legal round play and stump opening

- **Goal/scope:** simple legal leads, beats, pickups and mandatory stump openings; no strategic search or need for voluntary out-of-turn opening.
- **Dependencies:** 10.5.
- **Expected files/modules:** proposed play policy module and tests; reuse `canBeat` from `src/game/cards.ts`.
- **Acceptance:** use own cards, public table and approved memory only. Respect spade isolation, six-over-ace and one-use opening rights. Unknown trump permits only provably legal choices and is not treated as no-trump. Preserve fixed N and authoritative automatic consequences.
- **Required tests:** approved round/stump scenarios, empty hands, automatic pickups, preserved/consumed rights, interrupted turns, penalty-restored hands and repetition completion.
- **Risks:** inferred rights, mistaking intermediate events for settled state and unnecessary strategy complexity.
- **Status: verified within D011's approved conservative safety scope.** `src/bots/play.ts` chooses the first permitted lead/beat, otherwise legal bottom pickup with a nonempty hand. Unknown trump requires `canBeat` to hold for every allowed trump (including no-trump). Empty hands open only on own turn with positively remembered current-round entitlement; unknown rights wait, potentially indefinitely, without probing or bypass pickup. Empty turns without entitlement remain engine-normalized. Runner preserves existing dealing/refusal, committed seat-memory inputs and exact-head/cancellation fences. No memory proof expansion, hidden rights/trump hint, social policy or strategy search added.
- **Coverage:**16 added policy/runtime cases in `play.test.ts`/`runner-play.test.ts` cover spades/six-over-ace/unknown trump, mandatory consumed/preserved rights, penalty-restored hands, interrupted turn, fixed N, automatic pickups, repetition and2/4/5/8-seat deterministic runtime traces. All four runtime match fixtures reached approved unknown-right waits; they are NOT complete matches. Repetition completion is separately engine/projector-tested. One real PostgreSQL host integration verifies live lead, durable receipt, recovery without repeated play and human handback.
- **Verification:** worker59 bot cases and27 PostgreSQL host cases passed. Parent normal `npm run check`: **510 pass/nine explicit DB skips**. Final database-enabled `npm run check`: **704 pass/no skips**, including format/lint/types/tests/build. New disposable PostgreSQL18 tmpfs container `penky-play-106-test`, loopback55456, database `penky_play_test` only. Independent read-only review found no issues. No browser/manual or complete autonomous-match acceptance claimed.
- **Failure history:** first parent database gate failed the existing corrupt-recovery host cleanup assertion (backend count1 versus0); isolated host27/27 and fresh final full704/no skips passed without source/assertion changes to that test. Docker Desktop initially was stopped; started before creating the disposable target. Earlier investigation paused before production edits for explicit D011 approval; discarded draft tests had not run.
- **Next:10.7 only**, requiring explicit claim-ballot and withdrawal policy approval. Complete autonomous-match liveness with unknown rights remains unverified; no private knowledge fallback is authorized.

### Increment 10.7 — Remaining procedure behavior

- **Goal/scope:** complete conservative claim and penalty participation under approved policy.
- **Dependencies:** 10.6 and explicit claim/withdrawal policy decisions.
- **Expected files/modules:** proposed procedure policy module/tests and existing projection/runtime test suites.
- **Acceptance:** never originate spoken accusations; abstain as approved. Respond only to eligible unanswered procedures. If contribution choices are included, use only own cards and preserve last-card protection/reservations. Do not conflate withdrawal consent, claim votes and human-only replacement voting.
- **Required tests:** claimant/accused electorates, sequential claims, abstention, withdrawal unanimity semantics, nested timers, contribution/refusal completion and stale procedure IDs.
- **Risks:** treating unlike procedures identically or inventing evidence classification. No new claim-evidence projection is implicitly authorized.
- **Status: verified.** `src/bots/procedures.ts` consumes only permitted current seat projections. Eligible unanswered unpaused top-level claim ballots get explicit abstention, withdrawal gets explicit true consent, penalties get explicit refusal. Suspended claim ballots are not independently acted on; strict null checks preserve answered false approvals. Existing `choosePenaltyRefusal` contract remains compatible. Runner retains exact-head/tenure/cancellation fences, dealing/play, no-human suspension and host fault cleanup. No evidence classifier/projection, contributions, accusations, withdrawal requests or replacement voting added.
- **Coverage:** seven new policy/runtime cases in `procedures.test.ts`/`runner-procedures.test.ts` cover own-only answers, claimant/accused eligibility, explicit consent, nested pause/resume remainder, FIFO ballots, stale procedure commands, multiple bots, evidence-independent abstention and false-claim penalty refusal completion. Real PostgreSQL host integration adds consent/abstention and durable recovery without duplicate replies.
- **Verification:** worker test-first focused31/31, PostgreSQL host28/28, types/lint/format passed. Parent normal `npm run check`: **517 pass/nine explicit DB skips**. Final database-enabled `npm run check`: **712 pass/no skips**, including format/lint/types/tests/build. New disposable PostgreSQL18 tmpfs container `penky-procedures-107-test`, loopback55457, database `penky_procedures_test` only. Docker Desktop started before target creation. Independent read-only review found no issues. No browser/manual or full autonomous-match acceptance claimed; approved unknown-order/right waits remain.
- **Next:10.8 only**, lifecycle/rollback/successor cross-feature verification. Stop after10.7; complete-match liveness remains for10.9 and is not implied here.

### Increment 10.8 — Lifecycle, rollback and successor integration

- **Goal/scope:** cross-feature verification of the complete runner and approved knowledge treatment. Basic cancellation already belongs in 10.4.
- **Dependencies:** 10.7.
- **Expected files/modules:** bot runner/host integration, runtime rollback/recovery/handoff and PostgreSQL integration tests.
- **Acceptance:** obsolete work cannot survive rollback, handback, writer replacement or successor adoption. Current presence stays live. Failed successor preparation preserves the old runner; successful handoff retires it. No knowledge leaks across branches or games.
- **Required tests:** rollback to null, nested timer remainder, abandoned-future knowledge exclusion, fresh-process recovery, storage faults, multiple absences and no-human suspension/resume.
- **Risks:** old epoch reuse, cross-game memory leakage and accidental human-command suppression by bot-specific fences.

### Increment 10.9 — Stage 10 acceptance gate

- **Goal/scope:** prove mixed human/bot complete matches and replacement flows end to end; confirmed integration fixes only.
- **Dependencies:** 10.8.
- **Expected files/modules:** bot acceptance tests, real transport/PostgreSQL tests, focused browser replacement tests and coverage/operations documentation.
- **Acceptance:** bots complete legal turns at 2/4/8 seats, preserve N, relinquish control correctly and never continue without a connected active human. Policies never receive privileged state.
- **Required tests:** complete matches; replacement during dealing/play/procedures; reconnect races, rollback/recovery, successor transition and adversarial privacy checks. Real bot execution must not be substituted by trusted match finishers or test drivers.
- **Risks:** test harnesses accidentally doing bot work; unit passes mistaken for live orchestration evidence. Record executed browser/database/manual boundaries accurately.

### Order, verification and implementation stop boundary

**Dependency order:** decisions → 10.1 → 10.2 → 10.3 → 10.4 → 10.5 → 10.6 → 10.7 → 10.8 → 10.9. Suggested first increment: **10.1**, after observation-entitlement agreement and explicit authorization to begin.

For each increment, write failing observable tests first, implement the smallest complete slice, obtain independent review, and run relevant tests plus `npm run check`. Persistence slices require disposable real PostgreSQL verification; final acceptance requires genuine orchestration evidence, not mocks alone. Update materially affected documentation, commit and push each verified increment, then stop. Only 10.1–10.7 have subsequently been authorized and implemented; later increments retain their explicit decision gates.

### Overall Stage 10 checklist

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
