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

### Progress — increment 8

**New approved direction, documentation only:** rules revision 1.4 adds a post-game little-finger/deck minigame and treats all participants remaining at a repetition draw as losers, preserving earlier winners. The current implementation still follows revision 1.3 for this outcome. No minigame or result changes have been implemented. Resolve §16.5 before implementing the affected behavior; planned work is tracked in Stage 11a below.

- **Stage 1: complete.** Tooling/CI, domain contracts, rule-to-test matrix, and architecture decisions are in place. `.gitattributes` enforces LF on Windows/Linux checkouts.
- **Stage 2: complete for the executable engine.** Creation, replay, invariants, atomic in-memory history, version checks, and duplicate protection are tested.
- **Stage 3: complete for the engine scope.** Dealing-time claims vote immediately, defer punishments correctly, and drain before the first lead. The reveal timer pauses and resumes across queued claims.
- **Stage 4: complete for the agreed engine scope.** Rounds, automatic pickups, stumps, exits, and settled-action repetition work. D001 was approved and resolved: both in-round and boundary cycles draw at the third occurrence.
- **Stage 5: complete for the trusted engine interface.** Scoped claims, FIFO voting, false-claim punishments, timeout abstentions, unanimous withdrawal, deferred-punishment cancellation, and episode-key deduplication are implemented. Binding chat/action references to authoritative evidence remains transport work in Stage 8.
- **Stage 6: complete for the runtime interface.** Serialized dispatch, automatic deadlines, nested timer suspension, multiple absences, replacement voting, controller handover, idempotent receipts, and checkpoint recovery are implemented. Bot decisions remain Stage 10; durable checkpoint storage is implemented in Stage 7.
- **Stage 7: complete for the trusted server/storage interface.** PostgreSQL persists action archives, snapshots, receipts, branch/audit metadata, controllers and timers before publication. Materialized snapshot recovery agrees with full replay. Lobby chat retains immutable author/context metadata across rollback and matches. Actual match handoff validates the observed result head and commits the old rollback closure, new initial frame, lobby pointer and start receipt atomically. Fault/race tests and generated rollback checkpoints cover nested procedures and all supported seat counts. Browser/session authentication, readiness UI and future minigame gating remain their planned later stages.
- **Stages 8–12 (including 11a): not started.** No HTTP/Socket.IO server or browser application is claimed to exist.
- Verification: `npm run check` passes with **206 passing checks when PostgreSQL is enabled** (180 non-database tests plus the two integration suites and their parent tests). Normal checks without the database explicitly skip both PostgreSQL suites. CI provisions PostgreSQL 18 on Linux and runs ordinary checks on Windows/Linux. `npm audit --omit=dev` is clean; the pre-existing dev-toolchain advisory is documented in `docs/postgres.md`.
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

- [ ] Implement separate participant, finished-player/spectator, and owner-history projections.
- [ ] Keep hidden card identifiers opaque; never encode suit/rank in public stump/deck handles.
- [ ] Give each seat only its hand and legitimately disclosed observations; remove transient reveal data after its permitted display window.
- [ ] Redact raw events, snapshots, branch previews, error messages, and reconnect payloads, not just the main game view.
- [ ] Implement Socket.IO rooms, acknowledgments, command IDs, runtime validation, and session-to-seat authorization.
- [ ] Make retries idempotent and serialize play, claims, timeouts, rollback, and disconnect events per game.
- [ ] Define stale-command handling: reject wrong-game or obsolete-branch commands, but do not accidentally block a deliberate current out-of-turn attempt that must be punishable.
- [ ] Send versioned state and support full authorized resynchronization after missed messages or refresh.
- [ ] Keep local game development single-runtime; prevent simultaneous writers instead of introducing premature distributed execution.
- [ ] Add rate limits and payload limits without changing agreed game punishments.

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
