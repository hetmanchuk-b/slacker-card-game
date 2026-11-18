# Penky

A TypeScript multiplayer card game with a planned Three.js table. Agreed rule-breaking attempts are part of gameplay, not simply disabled controls.

## Status

The eighth engine/runtime increment completes Stage 7 for the trusted server/storage interface:

- 36-card deck and suit/rank comparison, including spade isolation and six-over-ace.
- Deterministic game creation and event replay.
- Clockwise manual dealing for 2–8 seats, two separate stump passes, and remaining hand cards.
- Out-of-turn drawing with random reinsertion and queued pre-game punishment.
- A 10-second final-card reveal deadline and trump selection.
- Sequential pre-game penalties before releasing the first leader.
- Round play with a frozen target, top-card beating, bottom-card pickup, and atomic automatic pickups.
- One-use stump-opening rights, preserved rights after temporary hand obstruction, and punishable own-stump peeking.
- Automatic penalties with optional card contributions/refusals, last-card protection, and 10-second timeout commands.
- Scoped spoken/chat/action claims, sequential voting, majority verdicts, timeout abstention, false-claim punishment, and incident-key deduplication.
- Unanimous withdrawal with suspended vote timers, queued requests, and cancellation of dealing punishments that have not started.
- Reveal-timer suspension across claims and full event replay of nested procedures.
- Round-bound exits, simultaneous victory, and threefold repetition after settled gameplay actions, including cycles inside one round, with previous winners retained.
- Atomic in-memory action history, optimistic version checks, duplicate protection, and replay recovery.
- A serialized runtime with automatic deadlines, disconnect suspension, multiple-absence handling, and nested timer preservation.
- Bot-replacement voting after more than 30 seconds, human/controller handover, and no bot-only continuation without a connected human participant.
- Checkpoint recovery that preserves remaining gameplay time, accepted receipts, controller metadata, and live replacement deadlines.
- History branches and trusted owner rollback with pre-action timer restoration, retained abandoned futures, warning acknowledgment, and administrative records.
- PostgreSQL migrations and transactional frames persisting history, snapshots, receipts and runtime metadata before state/acknowledgment publication.
- Single-writer leases, optimistic revisions, and verified recovery in a fresh Node process; failed storage commits fault the runtime rather than accept unpersisted actions.
- Integrity-checked materialized snapshots with tail replay, verified against independent full archive replay.
- Old-branch command/deadline invalidation and atomic actual-next-match handoff, including rollback closure, successor state, lobby pointer and retry receipt.
- Retained lobby chat with immutable authors, exact text and server-derived game/branch/scope context; rollback never deletes or relabels messages.

**Not playable online yet:** private player/history projections, authenticated Socket.IO transport, bot decisions, and the browser/Three.js client are still planned. Scheduling, persistence and presence rules are server-side libraries, not a running network application. Chat/action evidence references remain trusted internal inputs until transport adapters resolve them against server history.

**New rules, not implemented yet:** revision 1.4 adds a post-game deck-strike minigame and makes remaining participants losers when repetition ends a match. These approved changes are tracked in Stage 11a; current result contracts still follow revision 1.3.

**D001 resolved:** the approved repetition extension detects cycles inside a round without forcing discard or moving cards. See [decision record](docs/open-decisions.md). Full deterministic engine matches for all supported seat counts are covered by regression tests.

## Requirements

- Node.js 24 or newer
- npm

```sh
npm ci
npm run check
```

Individual commands:

```sh
npm test                 # Node tests run directly from TypeScript
npm run typecheck        # Strict type checking, including tests
npm run lint
npm run format:check
npm run format           # Format source and configuration files
npm run build            # JavaScript, declarations and source maps in dist/
```

The build contains server-side libraries and a migration CLI, not a running web application. Non-database tests need no PostgreSQL. For real persistence tests, see [PostgreSQL setup](docs/postgres.md):

```sh
npm run db:test:up
# Set PENKY_TEST_DATABASE_URL to the disposable test database (see the setup guide).
npm run test:postgres
npm run db:test:down
```

The integration suite injects database faults; never point it at a shared database.

## Documents

- [Implementation plan and progress](IMPLEMENTATION_PLAN.md)
- [Agreed game specification](docs/game-rules.md)
- [Worked scenarios](docs/game-scenarios.md)
- [Architecture decisions](docs/architecture.md)
- [Runtime interface and recovery policy](docs/runtime.md)
- [Branch history and rollback](docs/history.md)
- [PostgreSQL setup, storage and recovery](docs/postgres.md)
- [Lobby chat and atomic match transitions](docs/lobby-persistence.md)
- [Rule-to-test coverage](docs/rule-test-matrix.md)
- [Open implementation decisions](docs/open-decisions.md)

## Engine interface

- `decide(state, command, context)` validates a trusted internal command and returns either a rejection or an accepted atomic action.
- `applyAction(state, action)` applies recorded events without fresh time or randomness.
- `validateState(state)` reports server-only conservation/structural diagnostics.

Time and bounded randomness are injected into command decisions. Their outcomes are captured in events for deterministic replay. Card IDs must be opaque and independent of card faces.

Raw engine state, events, and history snapshots contain private information. They are not network payloads and must not be exposed to players or bots. Authorized projections and transport validation will be implemented before a browser client is connected.
