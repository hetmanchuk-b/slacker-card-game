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

**Stage 8 is complete for the approved server/transport scope:** baseline and scoped live/action projections expose only authorized data, including timed reveals, seat-private fresh peek/open/transfer observations and redacted procedures/control state. Paused reveals are hidden; peek duplicates/reconnects do not replay the face. Owner history is metadata-only across active/abandoned branches, with safe rollback selectors but no card faces/handles or previews. Ownership and finishing grant no additional card visibility. Fifty-one projection tests cover privacy and runtime/history integration, including 2/4/8 seats. A version-1 protocol library now strictly decodes browser intents and constructs safe envelopes; nineteen protocol tests include explicit engine/runtime binding checks without claiming network verification.

**Guest-access libraries are implemented:** hash-only persistent credentials, 30-day sliding expiry, revocation without seat release/ownership transfer, and durable owner-first clockwise membership capped at eight seats. Cookie/origin helpers and real PostgreSQL race/recovery tests are included; no account or recovery system is added.

**Committed runtime subscriptions are implemented:** server-private initial baselines and post-commit command/deadline/control notices include exact fresh action pairs. Listener failures cannot undo commits or stall the queue through unresolved delivery promises. These are not network payloads or reliable delivery.

**Durable local game host implemented:** one leased runtime per game, current-lobby routing, consolidated seat connections, durable fault recovery and atomic successor adoption. Twenty-two real PostgreSQL scenarios cover ownership, lifecycle/rebinding, cancellation and fault isolation. This is a private server library, not network authentication or delivery.

**Authenticated transport slices implemented:** `PenkyTransport` provides HTTPS guest sessions, authenticated presence/private resync, and ten explicitly bound card/procedure/replacement intents with durable, allowlisted command acknowledgments. Real TLS/PostgreSQL scenarios cover 2/4/8-seat card interactions and private live streams, punishable attempts, retries/branches, queue invalidation, credential/controller checks, backpressure, reveals and recovery. Claim submission is now bound through authoritative evidence resolution; owner-history and rollback routing are now implemented; bounded chat submission/history is now implemented; canonical owner-authorized start routing is now implemented.

**Bounded live/action delivery implemented:** host lifecycle subscriptions rebind committed replacements, while per-socket action/state streams use fresh authorization, epoch invalidation and nonce-backed delivery receipts. Fresh peeks/transfers remain seat-private; resync/recovery never replay observations. Slow or uncertain recipients disconnect without blocking game queues. Clients must acknowledge the outgoing transport receipt; this is not reliable replay.

**Authenticated claims implemented:** spoken episodes derive scope inside the runtime queue; chat/action references bind original authors, scopes and retained active-branch provenance. Accepted retries preserve their original canonical scope across recovery without a new vote. Invalid evidence yields fixed technical rejection, never private diagnostics or punishment.

**Authenticated owner history and rollback implemented:** current-match owner timelines remain metadata-only across active/abandoned branches. Ordinal targets resolve against committed history; exact accepted retries survive forks and recovery. Authorized participants receive an allowlisted rollback notice with actor and ordinal target/result, including rollback before game creation. No history previews or private observations are replayed.

**Authenticated retained chat implemented:** durable lobby members can post and page through chat without current-match participation or human control. Exact text, author and original game/branch/scope survive retries, rollback and match changes. `messageId` is the durable idempotency key; `requestId` only correlates chat replies. Pages are byte-bounded ordered prefixes, with no private author sessions or game-state payloads. This is request/response, not live chat push or UI.

**Canonical authenticated starts implemented:** owner intents resolve durable receipts before preparing opaque game/card IDs. Exact retries retain the originally accepted match across recovery and later successors; new starts validate observed head, finished state and the locked membership roster. Queued admission precedes rollback closure, and denial leaves the original writer usable. New member-backed starts now also require every durable member's acceptance of the current agreements; accepted retries bypass that new gate and do not reset twice. Future minigame gating remains deferred.

**Authenticated lobby admission implemented:** HTTPS POST creation/join returns only own lobby/seat identity. Creation keys resolve durably to one original lobby across concurrent retries and fresh-process recovery; lobby, owner membership and mapping commit atomically. Strict JSON/UTF-8/byte/rate/origin checks and credential revalidation apply. Admission does not attach sockets or grant game visibility; clients explicitly resync afterward.

**External complete matches verified:** isolated Node TLS/Socket.IO clients now bootstrap through HTTP guest/lobby APIs and finish 2/4/8-seat matches using only each seat's wire observations and remembered reveal. The four-seat flow includes retained chat, claims/withdrawal, private penalties/peeks, owner rollback and reconnect timer preservation. All three verify retries, private projections and atomic successor handoff. No trusted gameplay setup or full-state match driver is used in this suite.

**Lobby agreements/acceptance implemented:** D005 accepts the existing private per-socket routing instead of redundant Socket.IO rooms. Authenticated HTTP lobby state, owner text editing and own-seat acceptance are durable. `ready` means agreement acceptance only, not general willingness to play. The revision is an acceptance epoch: actual text changes, new members and successful starts increment it and clear all acceptances; individual confirmations do not, so members can accept concurrently. Identical text, reconnects, failed starts and accepted start retries do not reset it. New starts atomically validate all durable members (owner/disconnected included), bind immutable match agreements and clear consent. Policy denial preserves the old writer/rollback window. No lobby live push or UI is added.

**Stage 9.1 browser shell implemented:** React/Vite over loopback HTTPS now confirms a cookie-only guest session, creates one canonical lobby and displays only own seat/owner identity. Uncertain creation survives reload with the original nonsecret reference; missing/expired original credentials are not silently replaced. Six client tests and nine real Chromium/HTTPS/PostgreSQL tests cover this bounded slice. See [browser setup and boundaries](docs/browser-client.md).

**Stage 9.2 join/restoration implemented:** known lobby references and nonsecret URL fragments support explicit same-cookie reload/new-tab membership confirmation. Fresh guest entry requires explicit consent; restoration never issues credentials, and original creation retries remain separate. Seven additional client tests and nine additional browser cases verify join/retry/expiry, full/running admission and validation recovery.

**Stage 9.3 agreements/acceptance UI implemented:** explicit snapshots support owner exact-text editing, own acceptance/withdrawal and separate read-only original match terms. Concurrent members accept one epoch; stale/uncertain changes require a fresh read without automatic resubmission. Seven additional client tests and eleven additional browser cases cover resets, locks, exact UTF-8/CRLF text, privacy and recoverable drafts.

**Stage 9.4 connection/first start implemented:** same-origin receipt-aware WSS supports explicit attach, owner first start, immutable retries after uncertainty/reload, state-only resync and a read-only projected count/phase/control summary. Historical acknowledgments never become current state; assigned null state is not an empty lobby. Eleven additional Node tests and six browser cases cover ordering, nonce loss, retries, suspension, rollback-to-null and preserved proxy authorization.

**Stage 9.5 manual dealing implemented:** deck clicks permit deliberate out-of-turn attempts, actual draw actors remain observable, and own hand faces/closed stumps render privately. D002 initial notices and temporary final-card reveals obey receipt-anchored expiry, suspension and reset; no next-recipient hint, permanent trump or observation replay is added. Four additional real browser cases cover 2/4/8-seat dealing and lost draw acknowledgment; six net new Node tests cover the client boundaries.

**Stage 9.6 penalty contribution/refusal implemented:** eligible seats can reserve an own hand card or explicitly refuse, with last-card/stump protection. Reservations never move cards optimistically; completed transfer faces go only to donor/recipient. Paused countdowns resume their remainder, local zero never completes a procedure, and stale selections/uncertain responses are not replayed. Nine new Node tests and three real four-seat browser cases cover queued and later penalties, privacy, timeout, stale IDs, interrupted-round restoration and lost acknowledgments.

**Stage 9.7 click-based play implemented:** own hand clicks attempt play, pickup targets exactly the public table bottom, and one own-stump control lets the server decide legal opening versus punishable peek. Wrong-turn/beat attempts stay available. Ordered table/round feedback preserves automatic consequences; the approved actor-only peek notice is dismissible and penalty-bound, with no timer or replay. Six new Node tests and seven browser cases include two real gameplay integrations and five explicitly labeled engine/projector wire-fixture cases for late scenarios 2–10.

**Stage 9.8 drag equivalence implemented:** deck→own-hand/seat and hand→table gestures invoke the same draw/play methods as native buttons. Cancelled/stale gestures send nothing, competing contacts stay blocked until they end, and post-drag clicks cannot duplicate commands. Source-only touch handling preserves scrolling elsewhere; a temporary drop strip supports long/narrow pages without moving or revealing cards. Five Node and six Chromium cases include real draw/play integration plus explicitly labeled fixture-based reset/touch checks.

**Stage 9.9 retained chat implemented:** the approved shared connection supports lobby posting/paging even when game visibility is denied. Exact text, immutable message-ID retries and original author/context remain separate from current game state. History follows last-returned sequence, including gaps and byte-bounded short pages; posts never advance its cursor. Five new Node tests and four browser cases cover validation/privacy, lost replies, rollback retention and paging. Retry references are mounted-memory only; no live push or extra production socket is added.

**Stage 9.10 claims/voting implemented:** manual exact spoken episode keys, retained chat IDs and fresh action command IDs use the shared connection. Sequential own-only ballots preserve paused time and stale-command boundaries; technical acknowledgments never become social verdicts. Nine new Node tests and six real browser cases cover evidence, 2/4/8 voting, ties, timeout, dedup, authoritative penalty recipients and closed dealing evidence. Acceptance is now verified: the corrected human-draw evidence test requires `scope-closed`; two additional real-server tests cover controlled claim-first/play-first delivery and stale-ballot isolation. Fresh gates passed: 366 Node tests/seven explicit DB skips, 182 PostgreSQL tests and 67 browser tests. Independent review approved the evidence and boundary tests. Withdrawal stays deferred in 9.11.

**Stage 9.11 withdrawal UI verified:** current own-claim requests, own approval/refusal, separate suspended ballot and consent timers, exact stale-route binding and technical feedback use existing server contracts. Five real withdrawal browser cases pass within the 72-pass browser suite; `npm run check` reports 382 pass/seven DB skips. Independent review findings are fixed. The earlier PostgreSQL 14.5/Windows blocker is resolved by fresh verification against disposable PostgreSQL 18: database-enabled `npm run check` passes 564 tests/no skips, and the final full browser run passes 72 tests/no retries. No authoritative queued-claim listing or 9.12 work is added.

**Stage 9.12 presence/replacement controls verified:** connected/absent human/bot status, server-checked replacement proposals and own ballots use existing contracts. Replacement time continues while gameplay timers freeze; return cancels voting or restores human control, and reconnect never replays observations. No inferred absence countdown or bot decisions are added. Six Node cases and two real browser integrations cover lifecycle, privacy, multiple tabs/absences and handback; exact 30-second boundary remains runtime-tested. Database-enabled check: 579 pass/no skips; full browser suite: 74 pass/no retries. Independent review found no issues.

**Not a complete online game yet:** history/result workflows, bot decisions and Three.js are still planned. A source-only HTTPS development launcher exists, not a production game-server CLI. Chat authors and context are bound by the server; claim references are resolved against retained server-owned chat/history.

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
npm run build            # Server JS/declarations/maps plus dist/client/ browser assets
npm run dev              # Loopback HTTPS; explicit DB/TLS setup required (see browser guide)
npm run test:browser     # Chromium + disposable configured database required
```

The build contains server-side libraries, an instantiable TLS transport component, a migration CLI and the bounded browser shell, not a production game-server CLI. The browser dev launcher runs from source. Non-database tests need no PostgreSQL. For real persistence tests, see [PostgreSQL setup](docs/postgres.md):

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
- [External protocol contracts and validation](docs/protocol.md)
- [Guest credentials, cookies and durable membership](docs/guest-access.md)
- [Runtime interface and recovery policy](docs/runtime.md)
- [Durable local game host](docs/game-host.md)
- [Authenticated HTTPS / Socket.IO resync](docs/transport.md)
- [Browser client and loopback HTTPS development](docs/browser-client.md)
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

Raw engine state, events, and history snapshots contain private information. They are not network payloads and must not be exposed to players or bots. `projectGame`, `projectLiveGame` and `projectAction` are allowlisted server-side projection APIs, not network endpoints or bot memory. Their caller authenticates viewers, supplies committed snapshots/action pairs and trusted time, and suppresses duplicate action delivery. `projectOwnerHistory` separately projects a trusted committed history capture into metadata-only owner timelines. Its display selectors must be resolved against fresh server history; they do not authorize rollback. `decodeClientMessage` validates untrusted shapes without authenticating or constructing trusted commands. `PostgresGuestAccess` provides server-private credential/membership gates, not network endpoints or permanent authorization capabilities. `GameRuntime.subscribe` supplies a private committed publication seam; consumers must authorize/project its data and order their own network delivery, not serialize raw notices. `PostgresGameHost` owns local writer lifecycles and aggregates trusted connection bindings; `PenkyTransport` binds cookie-authenticated membership and match participation for resync and its explicit gameplay subset. Its approved runtime admission guard rechecks credential/liveness/controller permissions inside the queue before receipt lookup. `PostgresGameHost.subscribe` supplies private lifecycle notifications; the transport now projects and bounds live delivery. `GameRuntime.dispatchClaim` and `PostgresGameHost.submitClaim` now serialize authoritative evidence resolution and dispatch. `PostgresGameHost.observeHistory` and `rollback` now integrate committed owner-history capture and optimistic ordinal selector resolution using existing runtime APIs. `PostgresGameHost.postChat` and `chatHistory` route bounded retained-chat operations with queued membership admission and redacted responses. `PostgresGameHost.startFromIntent` resolves canonical starts under fresh owner authorization and uses the existing atomic handoff/adoption path. Remaining lobby/client flows must still be integrated before a complete browser game is connected.
