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

Gameplay phase, claim/penalty procedure, and live connection suspension are separate concepts. A disconnected player does not erase the procedure being interrupted. `GameRuntime` turns injected clock deadlines into serialized system commands. The engine records logical clock suspension and the IDs of timers that were running; nested timers already paused by a claim/withdrawal remain paused.

Live socket/presence information is not part of rollbackable game state. Recompute disconnection suspension after a rollback. A replacement vote belongs to runtime pause management and runs while gameplay timers are frozen. Runtime checkpoints capture presence/controllers, accepted receipts and control audit records separately from engine history; old sockets are disconnected on recovery. See `docs/runtime.md`.

## Storage decision

Stage 7 now uses PostgreSQL with `pg` and explicit checksum-checked SQL migrations. No ORM is required. Versioned private frames store the operation archive (action batches, ancestry, ownership and rollback audit), active snapshot and runtime checkpoint, including accepted command receipts. An optimistic head update and frame insert commit together on one leased connection. `History` is the synchronous private staging interface; the runtime's awaited commit adapter is the durability seam. Public state/acknowledgment publication waits for it. Real PostgreSQL tests cover faults and separate-process recovery. Recovery can load a validated materialized history cache and replay its operation tail; independent full replay remains available for auditing. Lobby chat is separately retained with original author/scope/head metadata. Actual next-match handoff atomically closes old rollback and commits the successor, lobby pointer and start receipt. See `docs/postgres.md` and `docs/lobby-persistence.md`.

## Guest sessions and ownership

- No account system is required for the first version.
- A server-issued opaque session token authenticates a guest. In browser deployment use a Secure, HttpOnly, SameSite cookie over TLS; validate origin on socket handshakes.
- Bind session identity to lobby membership and seat identity on the server. Never trust an actor/owner ID supplied by a browser payload.
- Reconnecting uses the same session; a display name or a lobby code is not a reconnect credential.
- Persist the lobby owner's session binding. Owner privileges are checked on every administrative command.
- No implicit host transfer or spectator access to private history is introduced by this decision. Obtain agreement before adding host-transfer behavior.

## Current implementation scope

The engine and serialized runtime are executable: scheduling, connection suspension, replacement control, and checkpoint recovery now drive the existing game/claim procedures. In-memory branch history and trusted owner rollback are also executable, including pre-action timer rebasing and branch invalidation. PostgreSQL persistence and durable rollback/recovery are executable. Retained lobby chat and atomic actual-next-match transitions are also implemented. Authenticated transport, bot decisions, and browser rendering remain later work. See `docs/history.md`. No running multiplayer server or browser application is claimed.

## Atomic automatic consequences

`decide` expands a user command into one action batch containing its automatic consequences. Empty-handed pickup chains, penalty start, and penalty completion are recorded as events in that batch. The runtime must commit and broadcast the complete batch, never an intermediate state or an independent rollback point inside it.

Round completion and finalized exits are deterministic consequences of the completing card event. Stump-opening rights use the eligible round number internally, but repetition equality normalizes entitlement availability instead of hashing absolute round numbers.

Penalty choices reserve a donor's selected card until the procedure completes; then transfers are applied together. Normal play is suspended throughout, so cards cannot be spent concurrently. Responses use own-property lookups: a valid opaque seat identifier must not be confused with an inherited JavaScript property.

Private stump peek knowledge is stored separately from the card's physical location. Illegal peeking does not transfer the stump into the hand. Raw peek data and repetition keys remain server-only.

## Claims, evidence references, and withdrawal

- Claim records form an ordered ledger. The first unresolved record starts a vote; later accepted records wait without restarting the current timer. Penalties caused by a verdict finish before the next claim vote starts.
- Engine commands carry a canonical evidence reference and scope. These are **trusted internal inputs**: Stage 8 must resolve chat/action IDs, authors, original scope, and active-branch provenance from server-owned history. A browser must not be allowed to relabel an old message as a current episode.
- Spoken episodes use explicit stable keys; equivalent prose is not machine-deduplicated. Players settle disputed spoken identity socially, as specified.
- Automatic violations are immediately recorded as handled action incidents. Reporting one again does not create a second punishment. Reusing a resolved, tied, withdrawn, or still-pending claim's incident key is rejected.
- A claim vote includes active seats except the accused. Withdrawal consent includes active seats except the claimant, including the accused. The runtime blocks ordinary commands during absence and records timer suspension; the engine does not infer live socket presence.
- Withdrawal pauses an active ballot with its exact remaining milliseconds. A denial or timeout restores those ballots and that remaining duration; a queued claim whose vote has not started gets a fresh timer only when it actually starts.
- A deferred dealing verdict can still be withdrawn before its punishment starts. A request queued behind another procedure is honored before the matching deferred punishment; other punishments are not interrupted.
- During the last-card reveal, accepted claims freeze the reveal timer until the full claim queue is drained. Resumption is an explicit event; replay never obtains fresh time.
- Claim ledgers, automatic incident keys, and punishment-start markers are rollbackable state. The separately persisted lobby chat is retained across rollback, with its original author and branch/scope context; Stage 8 must validate that provenance rather than trust browser-supplied labels.

## Settled-action repetition (D001 resolved)

Repetition is checked after all automatic consequences of an accepted gameplay action settle, including states inside a round. The explicit `repetition-checked` event is part of the same atomic batch; intermediate pickups, pending procedures, and retries are not extra occurrences.

The key includes phase, ordered table, participants, fixed round target, current turn/next leader, cards, trump, and normalized opening rights. It excludes time, hand order, absolute round numbers, chat, and history metadata. The rollbackable occurrence map and `lastRepetitionKey` prevent unchanged no-op procedures from counting again.

An in-round draw preserves the physical card locations, opening-right metadata, and completed-round count. Terminal-state invariants therefore permit a nonempty table only for a draw. The six-action reproducer and the previously looping five-seat match are now passing regression tests. See `docs/open-decisions.md` for the approved decision.
