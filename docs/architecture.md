# Architecture decisions — initial implementation

## Agreed implementation seams

The implementation plan and approved architecture establish the test seams:

- **Engine:** command decision, event application/replay, and invariant validation. This catches rules and deterministic transitions, not socket authentication or visual behavior.
- **Runtime:** serialized commands, clock, and randomness. This catches delivery ordering and timer suspension, not rendering.
- **Projections:** authorized player/history views. This catches information leakage, not whether a human remembers a revealed card.
- **Persistence:** atomic append and branch recovery. This catches lost/duplicated history, not transport delivery.

Tests cross these interfaces. No tests against private helper call order are required.

## Determinism and identity

- Use branded string IDs to prevent accidental mixing of seats, cards, actions, and branches.
- Card IDs are independent of faces. Production IDs come from cryptographically generated opaque identifiers.
- The engine receives time and bounded random integers as inputs, rather than importing system time or crypto.
- Creation records the card catalog, shuffled deck, and first recipient in its event. Replaying it does not re-run randomness.
- One accepted command produces one atomic action containing one or more events. It is a valid history unit; internal events are not independent rollback targets.
- A rejected command produces no action. A recognized in-game violation produces an accepted action with a violation outcome.
- Engine state and raw events are private authoritative data. They must never be sent directly to browsers or bots.

## Timer and pause model

Gameplay phase, claim/penalty procedure, and live connection suspension are separate concepts. A disconnected player does not erase the procedure being interrupted. Timer values use injected milliseconds; future runtime scheduling must turn elapsed deadlines into serialized system commands.

Live socket/presence information is not part of rollbackable game state. Recompute disconnection suspension after a rollback. A replacement vote belongs to runtime pause management and can run while gameplay timers are frozen.

## Storage decision

Use PostgreSQL with the `pg` driver and explicit SQL migrations when durable persistence is implemented. No ORM is required for the initial schema. Store versioned action batches, branch ancestry, snapshots, chat, and ownership metadata. Commit branch-head checks and appends transactionally. Start Stage 2 with an in-memory adapter satisfying the same atomic history semantics; do not add the database dependency until Stage 7 needs it.

## Guest sessions and ownership

- No account system is required for the first version.
- A server-issued opaque session token authenticates a guest. In browser deployment use a Secure, HttpOnly, SameSite cookie over TLS; validate origin on socket handshakes.
- Bind session identity to lobby membership and seat identity on the server. Never trust an actor/owner ID supplied by a browser payload.
- Reconnecting uses the same session; a display name or a lobby code is not a reconnect credential.
- Persist the lobby owner's session binding. Owner privileges are checked on every administrative command.
- No implicit host transfer or spectator access to private history is introduced by this decision. Obtain agreement before adding host-transfer behavior.

## Current implementation scope

Engine commands are introduced incrementally. Creation, dealing, round play, stump handling, and automatic penalty procedures are executable. A type describing future claim voting/withdrawal is not an implementation of that feature. Stage checklists and the rule-to-test matrix identify what is actually executable.

## Atomic automatic consequences

`decide` expands a user command into one action batch containing its automatic consequences. Empty-handed pickup chains, penalty start, and penalty completion are recorded as events in that batch. The runtime must commit and broadcast the complete batch, never an intermediate state or an independent rollback point inside it.

Round completion and finalized exits are deterministic consequences of the completing card event. Stump-opening rights use the eligible round number internally, but repetition equality normalizes entitlement availability instead of hashing absolute round numbers.

Penalty choices reserve a donor's selected card until the procedure completes; then transfers are applied together. Normal play is suspended throughout, so cards cannot be spent concurrently. Responses use own-property lookups: a valid opaque seat identifier must not be confused with an inherited JavaScript property.

Private stump peek knowledge is stored separately from the card's physical location. Illegal peeking does not transfer the stump into the hand. Raw peek data and repetition keys remain server-only.

## Settled-action repetition (D001 resolved)

Repetition is checked after all automatic consequences of an accepted gameplay action settle, including states inside a round. The explicit `repetition-checked` event is part of the same atomic batch; intermediate pickups, pending procedures, and retries are not extra occurrences.

The key includes phase, ordered table, participants, fixed round target, current turn/next leader, cards, trump, and normalized opening rights. It excludes time, hand order, absolute round numbers, chat, and history metadata. The rollbackable occurrence map and `lastRepetitionKey` prevent unchanged no-op procedures from counting again.

An in-round draw preserves the physical card locations, opening-right metadata, and completed-round count. Terminal-state invariants therefore permit a nonempty table only for a draw. The six-action reproducer and the previously looping five-seat match are now passing regression tests. See `docs/open-decisions.md` for the approved decision.
