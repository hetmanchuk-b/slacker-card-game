# Penky

A TypeScript multiplayer card game with a planned Three.js table. Agreed rule-breaking attempts are part of gameplay, not simply disabled controls.

## Status

The third engine increment is implemented:

- 36-card deck and suit/rank comparison, including spade isolation and six-over-ace.
- Deterministic game creation and event replay.
- Clockwise manual dealing for 2–8 seats, two separate stump passes, and remaining hand cards.
- Out-of-turn drawing with random reinsertion and queued pre-game punishment.
- A 10-second final-card reveal deadline and trump selection.
- Sequential pre-game penalties before releasing the first leader.
- Round play with a frozen target, top-card beating, bottom-card pickup, and atomic automatic pickups.
- One-use stump-opening rights, preserved rights after temporary hand obstruction, and punishable own-stump peeking.
- Automatic penalties with optional card contributions/refusals, last-card protection, and 10-second timeout commands.
- Round-bound exits, simultaneous victory, and threefold repetition after settled gameplay actions, including cycles inside one round, with previous winners retained.
- Atomic in-memory action history, optimistic version checks, duplicate protection, and replay recovery.

**Not playable online yet:** spoken-rule claims/voting/withdrawal, connection management, durable rollback, server, bots, and browser/Three.js client are still planned. Timer deadlines are implemented in engine commands; real-time scheduling comes with the runtime.

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

The build is currently an engine library, not a running web application. No database is needed for the current increment.

## Documents

- [Implementation plan and progress](IMPLEMENTATION_PLAN.md)
- [Agreed game specification](docs/game-rules.md)
- [Worked scenarios](docs/game-scenarios.md)
- [Architecture decisions](docs/architecture.md)
- [Rule-to-test coverage](docs/rule-test-matrix.md)
- [Open implementation decisions](docs/open-decisions.md)

## Engine interface

- `decide(state, command, context)` validates a trusted internal command and returns either a rejection or an accepted atomic action.
- `applyAction(state, action)` applies recorded events without fresh time or randomness.
- `validateState(state)` reports server-only conservation/structural diagnostics.

Time and bounded randomness are injected into command decisions. Their outcomes are captured in events for deterministic replay. Card IDs must be opaque and independent of card faces.

Raw engine state, events, and history snapshots contain private information. They are not network payloads and must not be exposed to players or bots. Authorized projections and transport validation will be implemented before a browser client is connected.
