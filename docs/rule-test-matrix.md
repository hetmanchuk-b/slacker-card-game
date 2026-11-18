# Rules and scenario coverage

Status is updated as executable tests are added. A planned test is not passing coverage.

## Approved test seams

The engine command/event/invariant interface, runtime clock/ordering interface, authorized projections, and atomic history interface are established by the implementation plan. See `docs/architecture.md` for what each seam catches and misses.

## Specification coverage

| Specification | Behavior | Test location / planned stage | Status |
| --- | --- | --- | --- |
| 1 | Clockwise seats, stable identities, stack order | `engine.test.ts`, `dealing.test.ts`, `rounds.test.ts` | Engine passing |
| 2 | Lobby rules, owner edits, readiness reset, chat | Transport/client, stages 8–9 | Planned |
| 3.1, 4 | 36 unique cards, trump, rank and suit comparisons | `src/game/cards.test.ts` | Passing |
| 3.2 | Random recipient, two stump passes, uneven hands | `src/game/engine.test.ts`, `src/game/dealing.test.ts`, `src/projections/live.test.ts`, `src/projections/actions.test.ts` | Engine passing for 2–8 seats; private initial-notice refresh boundary and redacted draw observations passing at 2/4/8; transport/UI pending |
| 3.3 | One-time 10-second reveal, last recipient leads | `dealing.test.ts`, `runtime/runtime.test.ts`, `projections/live.test.ts`, `projections/actions.test.ts` | Timed projection hides suspended/expired reveal, resumes remainder and excludes permanent public action reveal; transport/UI pending |
| 3.4 | Out-of-turn draw, random reinsertion, deferred penalties | `dealing.test.ts`, `claim-scopes.test.ts` | Engine passing, including spoken claims and deferred cancellation |
| 5 | Fixed N, beat top, take bottom, two completion paths | `rounds.test.ts` | Engine passing |
| 6.1 | One-use rights, hand obstruction, entitlement expiry | `stumps.test.ts` | Engine passing |
| 6.2 | Mandatory opening and penalty-updated retry | `stumps.test.ts`, `penalties.test.ts` | Engine passing |
| 6.3 | Automatic pickup for empty participant | `rounds.test.ts` | Engine passing, including pickup chains |
| 6.4 | Own-stump peek; no access to others | `stumps.test.ts`, `projections/actions.test.ts` | Fresh-action-only private peek, duplicate/reconnect suppression and separate repeat attempt passing; wire privacy pending |
| 7, 13.1 | Round-bound exits, one loser, simultaneous victory | `rounds.test.ts`, `stumps.test.ts` | Engine passing |
| 8.1 | Illegal action consequences and repeated attempts | `dealing.test.ts`, `rounds.test.ts`, `stumps.test.ts`, `penalties.test.ts` | Automatic consequences and distinct repeat attempts passing |
| 8.2, 13.2 | Scoped claims, server ordering, sequential queue | `claims.test.ts`, `claim-scopes.test.ts` | Engine command ordering/scopes passing; authenticated evidence binding in stage 8 |
| 8.3 | Eligible voters, abstention, ties, false claim | `claims.test.ts`, runtime tests | Engine and scheduling passing; network delivery pending |
| 8.4, 13.4 | Withdrawal, unanimity, suspended timer | `withdrawal.test.ts`, `claim-scopes.test.ts` | Passing, including queued requests and deferred verdicts |
| 8.4, 13.5 | Incident deduplication; spoken dispute remains social | `claims.test.ts`, `withdrawal.test.ts` | Canonical-key deduplication passing; spoken semantic identity remains manual |
| 9 | Optional private transfer, never last card, timeout refusal | `penalties.test.ts`, runtime deadline tests, `projections/live.test.ts`, `projections/actions.test.ts` | Engine/scheduling and donor-only reservations, sender/recipient-only completed transfers/timeout passing; wire privacy pending |
| 10.1, 13.8 | Suspension priority, multiple absences, departed winners | `runtime.test.ts`, `presence.test.ts`, `clock.test.ts` | Runtime interface passing; physical socket integration pending |
| 10.2 | 30-second wait, replacement vote, reconnection | `replacement.test.ts`, `recovery.test.ts` | Runtime control passing; lobby/UI integration pending |
| 10.3, 13.6 | Bot observation limits and atomic handover | `replacement.test.ts`; bot/projections in stage 10 | Controller handover passing; bot strategy/observation memory not implemented |
| 11, 15.1 | No secrets in player views or owner history | `src/projections/*.test.ts`; transport in stage 8 | Baseline/live/action privacy and D003 metadata-only owner history passing at 2/4/8 seats; retained branches omit even public card faces/handles; authenticated wire privacy pending |
| 12 | Conservation, structural validity, deterministic replay | `engine.test.ts`, `invariants.test.ts`, scenario helpers, history tests | Current engine phases, nested replay and generated rollback histories passing; broader adversarial command fuzzing remains Stage 12 |
| 13.3 | Unused stump right survives temporary cards | `stumps.test.ts` | Passing |
| 13.7 | Third repeated meaningful state, prior wins retained | `repetition.test.ts`, `match.test.ts` | Passing at settled action checkpoints, including in-round cycles (D001 resolved) |
| 15.2–15.5 | Owner rollback, branches, timers, chat, knowledge warning | `persistence/branches.test.ts`, `runtime/rollback.test.ts`, `projections/history.test.ts`; stages 7–9 | Core/durable rollback and metadata-only owner timelines/targets passing, including pre-creation ownership, inherited prefixes and closure; authenticated delivery/selector resolution/UI pending |
| 16 | Post-game strikes, card counts, force/aim, dodges, connection handling | Stage 11a | Approved rules documented; no implementation yet; revision 1.4 repetition-loser outcome also pending |

## Scenario coverage

| Scenario in `game-scenarios.md` | Planned executable coverage | Stage |
| --- | --- | --- |
| 1. Dealing for 2/4/8 | Exact distribution, clockwise order, last recipient; extend to 3/5/6/7 | 3 |
| 2. Two seats, empty-table finish | Terminal transition without an extra turn | 4 |
| 3. Two seats, temporarily empty hand | Exit only after completing action | 4 |
| 4. Four seats, six-action round | Exact bottom-to-top stack and next leader | 4 |
| 5. Empty player returns | Automatic bottom pickup instead of skipping | 4 |
| 6. Eight seats, simultaneous exits | Frozen N and next active leader | 4 |
| 7. Opening entitlement | Opening between/during following round | 4 |
| 8. Hand emptied during round | No new entitlement; pickup or illegal peek | 4–5 |
| 9. Mandatory opening | Canceled pickup, penalty changes retry conditions | 4–5 |
| 10. Trump cannot beat spades | Invalid attempt leaves stack unchanged, turn retries | 4–5 |
| 11. Votes for 2/4/8 | Explicit counts, exclusions, abstention and ties | 5 (passing) |
| 12. Dealing penalties | Random reinsertion, queued punishments, correct first leader | 3, 5 (passing) |
| 13. Disconnect during vote | Six remaining seconds after resume, replacement management | 6 (runtime passing); bot decisions in 10 |
| 14. Claim vs completing play | Both event orders, closed scope, repeat incident | 5–6 (engine/runtime ordering passing); transport in 8 |
| 15. Everyone wins | Zero remaining participants is victory, not draw | 4 |
| 16. Repetition draw | Third meaningful occurrence after the 12-round cycle | 4 |
| 17. Administrative rollback | Restore cards/turn/N, retain abandoned branch and chat | 7 (core, durable branches and retained chat passing); transport/UI pending |
| 18. Rollback result and timers | Restore procedure/remaining time; live absence still pauses | 7 (runtime/storage and actual next-match closure passing); transport/UI pending |
| 19. In-round cycle (D001) | Third state occurrence draws; table/discard preserved | 4 (passing) |

## Current executable coverage

- `src/game/cards.test.ts`: 4 tests for the full deck and card-comparison combinations.
- `src/game/engine.test.ts`: 8 tests for creation, configuration validation, random-source contracts, replay integrity, time, and input/state isolation.
- `src/game/dealing.test.ts`: 9 tests, including sequential deferred penalty execution.
- `src/game/rounds.test.ts`: 7 tests for two/four/eight seats, round transitions, exits, automatic pickup chains, and out-of-turn actions.
- `src/game/stumps.test.ts`: 7 tests for opening rights, illegal peeking, mandatory opening, preserved/expired entitlement, and foreign-card rejection.
- `src/game/penalties.test.ts`: 6 tests for immediate/repeated penalties, optional contributions, timeouts, validation, and safe response dictionaries.
- `src/game/repetition.test.ts`: 4 tests for boundary/in-round draws, unchanged punishment procedures, and retained winners.
- `src/game/match.test.ts`: 7 full deterministic engine matches (2–8 seats), including complete replay and the formerly looping five-seat match.
- `src/game/claims.test.ts`: 16 tests, including 2/4/8-seat verdicts, eligibility, FIFO claims, duplicate incidents, invalid inputs, empty-hand participants, and final-play ordering.
- `src/game/withdrawal.test.ts`: 6 tests for unanimous cancellation, denial/timeout resumption, queued requests, authorization, and stale consent.
- `src/game/claim-scopes.test.ts`: 7 tests for dealing/between/round scopes, delayed punishments, withdrawal before punishment, and reveal suspension/resumption.
- `src/game/invariants.test.ts`: 6 tests for round, rights, terminal-result, claim/withdrawal consistency, and reserved-contribution integrity.
- `src/persistence/memory-history.test.ts`: 7 tests for atomic commits, retries, branch/version checks, detached snapshots, full-deal replay, and chronology/event identity.
- `src/persistence/claim-history.test.ts`: 1 integration test replaying dealing, withdrawal, a false accusation, contribution, and a queued vote, including duplicate append protection.
- `src/game/clock.test.ts`: 1 engine test for logical clock suspension/resumption and captured-timer invariants.
- `src/runtime/runtime.test.ts`: 9 tests for deadlines, multiple absences, nested clocks, serialization, retries, stale callbacks, and controller/branch guards.
- `src/runtime/replacement.test.ts`: 7 tests for the strict absence threshold, majority/tie/timeout, cancellation, handover, authorization, and bot-only suspension.
- `src/runtime/recovery.test.ts`: 6 tests for checkpoint-head validation, JSON round-trip recovery, nested time preservation, receipts, live replacement deadlines, and malformed metadata.
- `src/runtime/presence.test.ts`: 1 test reaching an intermediate winner and checking winner/spectator departures do not pause play.
- `src/runtime/system.test.ts`: 2 tests for native clock cancellation/error handling and cryptographic system inputs.
- `src/persistence/branches.test.ts`: 9 tests for pre-action points, archived branches, validation, idempotence, replay, empty-history ownership, closure, identity collisions and detached metadata.
- `src/runtime/rollback.test.ts`: 15 tests for trusted-owner rollback, exact/nested timer restoration, penalty gifts, absences, explicit branch guards, uncancelable old callbacks, receipt recovery, completed 2/5/8-seat matches, replacement cancellation and next-match closure ordering.
- `src/persistence/archive.test.ts`: 9 tests for versioned JSON recovery, snapshot-plus-tail/full-replay equivalence, four nested-clock phases, integrity/prefix checks, empty-state ownership and malformed archives.
- `src/runtime/durability.test.ts`: 4 tests for commit-gated publication/receipts/scheduling, fail-stop storage behavior, and obsolete-callback disposal.
- `src/persistence/postgres.test.ts`: 13 real PostgreSQL integration scenarios (plus the parent test) for session/process recovery, immutable revisions, writer leases, durable branches/audit, atomic SQL failure, independent control clocks, completed-match closure, recorded randomness, connection loss, revision conflicts and corrupted metadata/frames.
- `src/persistence/generated-rollback.test.ts`: 19 generated-history tests: all fixture action points for nested phases at 2/4/8 seats and sampled checkpoints of complete 2–8-seat matches, including exact state/timers and snapshot/replay equivalence.
- `src/runtime/handoff.test.ts`: 3 tests for both rollback/handoff queue orders, commit-gated retirement and non-fatal observer errors.
- `src/persistence/lobby.postgres.test.ts`: 11 real database scenarios plus the parent test for retained authors/text/context, chat ordering/scopes, idempotent pagination/retries, owner validation, actual successor creation/recovery, failed preparation/INSERT and rollback/start races.
- `src/projections/game.test.ts`: 11 tests for bound-seat/public/finished current views at 2/4/8 seats, opaque own-stump handles without faces, ordered public table, hidden-face substitution, redacted phase/result fields, owner non-escalation, null/mismatched snapshots, safe errors, output isolation and unknown-property exclusion. This baseline excludes transient observations, procedures/control and history; it is not wire authorization or complete resync coverage.
- `src/projections/live.test.ts`: 9 tests using real runtime/fake-clock fixtures for 2/4/8-seat initial notices, hidden suspended/expired reveal, exact resumed time, nested withdrawal, donor-only reservation, independent replacement clock, own-only ballots, safe time/viewer errors and detached outputs.
- `src/projections/actions.test.ts`: 14 tests for 2/4/8-seat redacted draws, fresh-only private peeks and distinct repeated clicks, private opens/transfers, immediate discard and automatic pickups, duplicate suppression, exact pre/post branch/head/replay checks, redacted diagnostics, creation/final-draw secrecy, penalty timeouts/zero-card completion and prototype-like final-responder seat IDs.
- `src/projections/history.test.ts`: 16 tests for 2/4/8-seat metadata-only owner timelines, fixed authorization/errors, active/abandoned/nested branches and inherited origins, original owner after pre-creation rollback, closure and completed-match availability, claims/final decisions without ballot/selection leakage, public/peek/transfer card and correlated-ID redaction, state-free projection, output isolation and archive/cache recovery equivalence.
- **Current non-database gate: 230 passing tests and 2 skipped PostgreSQL parent suites**, verified with `npm run check` for Stage 8.3 (50 projection tests total). The previous database-enabled Stage 7 gate passed 206 checks; PostgreSQL was not rerun for this projection-only increment. Authenticated evidence resolution, committed history/selector delivery, bots, the minigame and browser flows remain pending.

## Verification commands

- `npm test` — executable tests.
- `npm run typecheck` — strict TypeScript including test sources.
- `npm run lint` — static lint checks.
- `npm run format:check` — code/config formatting (product documents are not rewritten).
- `npm run build` — emit runtime JavaScript and declarations, excluding test fixtures.
- `npm run check` — all of the above in the CI order; includes database scenarios when `PENKY_TEST_DATABASE_URL` is set.
- `npm run test:postgres` — real database suite; requires an explicitly configured disposable `*_test` database (see `postgres.md`).
