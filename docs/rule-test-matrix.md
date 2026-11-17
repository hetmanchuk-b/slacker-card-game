# Rules and scenario coverage

Status is updated as executable tests are added. A planned test is not passing coverage.

## Approved test seams

The engine command/event/invariant interface, runtime clock/ordering interface, authorized projections, and atomic history interface are established by the implementation plan. See `docs/architecture.md` for what each seam catches and misses.

## Specification coverage

| Specification | Behavior | Test location / planned stage | Status |
| --- | --- | --- | --- |
| 1 | Clockwise seats, stable identities, stack order | `engine.test.ts`, `dealing.test.ts`; stack play in stage 4 | Partial: creation/dealing passing |
| 2 | Lobby rules, owner edits, readiness reset, chat | Transport/client, stages 8–9 | Planned |
| 3.1, 4 | 36 unique cards, trump, rank and suit comparisons | `src/game/cards.test.ts` | Passing |
| 3.2 | Random recipient, two stump passes, uneven hands | `src/game/engine.test.ts`, `src/game/dealing.test.ts` | Engine passing for 2–8 seats; UI pending |
| 3.3 | One-time 10-second reveal, last recipient leads | `src/game/dealing.test.ts`; runtime/projections stages 6, 8 | Engine deadline/trump/leader passing; UI pending |
| 3.4 | Out-of-turn draw, random reinsertion, deferred penalties | `src/game/dealing.test.ts`; execution in stage 5 | Reinsertion/queuing/pre-game gate passing; claims/execution pending |
| 5 | Fixed N, beat top, take bottom, two completion paths | Engine, stage 4 | Planned |
| 6.1 | One-use rights, hand obstruction, entitlement expiry | Engine, stage 4 | Planned |
| 6.2 | Mandatory opening and penalty-updated retry | Engine, stages 4–5 | Planned |
| 6.3 | Automatic pickup for empty participant | Engine, stage 4 | Planned |
| 6.4 | Own-stump peek; no access to others | Engine/projections, stages 4, 8 | Planned |
| 7, 13.1 | Round-bound exits, one loser, simultaneous victory | Engine, stage 4 | Planned |
| 8.1 | Illegal action consequences and repeated attempts | Engine, stages 3–5 | Planned |
| 8.2, 13.2 | Scoped claims, server ordering, sequential queue | Engine/runtime, stages 5–6 | Planned |
| 8.3 | Eligible voters, abstention, ties, false claim | Engine/runtime, stages 5–6 | Planned |
| 8.4, 13.4 | Withdrawal, unanimity, suspended timer | Engine/runtime, stages 5–6 | Planned |
| 8.4, 13.5 | Incident deduplication; spoken dispute remains social | Engine, stage 5; manual social-rule check | Planned |
| 9 | Optional private transfer, never last card, timeout refusal | Engine/runtime/projections, stages 5–8 | Planned |
| 10.1, 13.8 | Suspension priority, multiple absences, departed winners | Runtime, stage 6 | Planned |
| 10.2 | 30-second wait, replacement vote, reconnection | Runtime/client, stages 6, 9 | Planned |
| 10.3, 13.6 | Bot observation limits and atomic handover | Bot/runtime/projections, stage 10 | Planned |
| 11, 15.1 | No secrets in player views or owner history | Projections/transport, stage 8 | Planned |
| 12 | Conservation, structural validity, deterministic replay | `engine.test.ts`, `dealing.test.ts`, `memory-history.test.ts` | Initial phase/replay checks passing; later phases/generated tests pending |
| 13.3 | Unused stump right survives temporary cards | Engine, stage 4 | Planned |
| 13.7 | Third repeated meaningful state, prior wins retained | Engine, stage 4 | Planned |
| 15.2–15.5 | Owner rollback, branches, timers, chat, knowledge warning | History/runtime/client, stages 7–9 | Planned |

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
| 11. Votes for 2/4/8 | Explicit counts, exclusions, abstention and ties | 5 |
| 12. Dealing penalties | Random reinsertion, queued punishments, correct first leader | 3, 5 |
| 13. Disconnect during vote | Six remaining seconds after resume, replacement management | 6, 10 |
| 14. Claim vs completing play | Both event orders, closed scope, repeat incident | 5–6 |
| 15. Everyone wins | Zero remaining participants is victory, not draw | 4 |
| 16. Repetition draw | Third meaningful occurrence after the 12-round cycle | 4 |
| 17. Administrative rollback | Restore cards/turn/N, retain abandoned branch and chat | 7–9 |
| 18. Rollback result and timers | Restore procedure/remaining time; live absence still pauses | 7–9 |

## Current executable coverage

- `src/game/cards.test.ts`: 4 tests for the full deck and card-comparison combinations.
- `src/game/engine.test.ts`: 8 tests for creation, configuration validation, random-source contracts, replay integrity, time, and input/state isolation.
- `src/game/dealing.test.ts`: 8 tests for all seat counts, stump passes, trump reveal, deferred violations, technical rejections, and invariants.
- `src/persistence/memory-history.test.ts`: 7 tests for atomic commits, retries, branch/version checks, detached snapshots, full-deal replay, and chronology/event identity.
- **Total: 27 passing tests.** Scenario 1's engine dealing is covered. Scenario 12's draw violation and deferral are covered; its spoken-claim and penalty-execution steps remain pending. No complete browser scenario is claimed yet.

## Verification commands

- `npm test` — executable tests.
- `npm run typecheck` — strict TypeScript including test sources.
- `npm run lint` — static lint checks.
- `npm run format:check` — code/config formatting (product documents are not rewritten).
- `npm run build` — emit runtime JavaScript and declarations, excluding test fixtures.
- `npm run check` — all of the above in the CI order.
