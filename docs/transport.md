# Authenticated HTTPS / Socket.IO boundary — Stages 8.8–8.10

`src/server/transport.ts` implements `PenkyTransport` for **guest-session lifecycle, authenticated presence/private resync and a bounded gameplay-routing subset**. Socket.IO and its test-only client were explicitly approved in 8.8; the optional runtime admission guard and gameplay slice were explicitly approved in 8.9. Stage 8.10's approved bounded publisher adds authorized committed actions/live state and host lifecycle rebinding. There is no claim-submission/admin/chat/start/history handler, browser UI, lobby creation/join endpoint or application CLI yet. Existing lobbies/matches must be prepared through trusted server APIs. This is not a playable online game or a production deployment.

## Hosting

Configure a PostgreSQL pool with connection/statement timeouts and a redacted error listener; run the existing migrations explicitly. Supply a `PostgresGuestAccess`, one `PostgresGameHost`, actual TLS key/certificate and exact canonical HTTPS origins:

```ts
const transport = new PenkyTransport({
  access,
  host,
  tls: { key, cert }, // Deployment-owned certificate material, never test fixtures.
  origins: ['https://penky.example'],
});
await transport.listen(443, '0.0.0.0');
// Shutdown order:
await transport.close();
await host.close();
await pool.end();
```

The listener is real HTTPS with TLS 1.2 minimum. No plain-HTTP mode, forwarded-header trust, TLS-terminating proxy mode, account system or credential recovery is added. Exact Origin checks apply to session endpoints, Engine.IO polling requests and WebSocket upgrades; CORS alone is not authorization. Session endpoints are intended for same-origin browser requests. Static assets and the Socket.IO client bundle are not served.

`listen()` defaults to an ephemeral loopback listener and returns its HTTPS address. `close()` is idempotent: stop admission/watchers, invalidate peers, drain pending authentication/attachment and detach jobs, then finish listener shutdown. The caller owns and closes host/pool afterward. Configure DB timeouts: shutdown and revocation deliberately wait for admitted work to settle rather than abandoning its connection cleanup.

## Session endpoints

All endpoints require an allowlisted HTTPS Origin and **empty bodies**. They return empty responses, never token/session/seat/grant JSON. Responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

| Endpoint | Success |
| --- | --- |
| `POST /api/guest/session` | Commit a fresh hash-only credential, then set the approved Secure/HttpOnly/SameSite=Lax host cookie; 204 |
| `POST /api/guest/session/refresh` | Authenticate and slide durable expiry, then refresh the same cookie; 204 |
| `DELETE /api/guest/session` | Revoke the canonical cookie credential, invalidate its local sockets/pending work, drain detach cleanup and clear the cookie; 204 |

Issuance refuses an existing named guest cookie, even malformed, with 409 rather than silently replacing identity. Refresh without a valid credential returns 401. Delete accepts a canonical already-expired/revoked token to clear it but rejects malformed/ambiguous cookies. Other failures are fixed empty responses: 400 invalid body, 403 origin, 404 unknown route, 405 method, 429 rate limit, 503 unavailable. No exception/SQL/token diagnostics are returned. No state-changing GET exists. Browser cookie persistence/renewal requires these HTTPS responses; Socket.IO messages cannot emit Set-Cookie.

D004 is unchanged: 30-day sliding lifetime, revocation/expiry without seat release or owner transfer, no name/code recovery. Credentials are accepted only from `readGuestCookie`, not socket `auth`, URLs, request identity fields or stable session IDs.

## Socket contract

Namespace `/`, default `/socket.io/` path. Handshake `auth` must be empty; cookie authentication is checked before namespace admission. Both direct WebSocket and polling admission enforce Origin. A rejected upgrade may close the transport rather than return an application envelope.

- Incoming event: `client-message` with exactly one existing version-1 protocol object: `resync` or one of the ten gameplay intents below.
- Outgoing event: `server-message(message, receipt, acknowledge)`, carrying an existing `StateMessage`, `ActionMessage`, allowlisted `CommandAck` or fixed `ErrorMessage`. The receiver must promptly call the Socket.IO acknowledgment callback with the **exact opaque receipt string**. This new transport receipt is not a gameplay command, cookie or reliable-delivery/replay capability.
- Deferred well-shaped intents return `unavailable`; malformed shapes use existing decoder errors. Technical failures never become gameplay punishments.

The first authorized resync attaches the socket to one lobby using fresh durable membership. Later resyncs must name that same lobby; switching lobbies requires a new connection. Multiple sockets per seat use the host's aggregate presence, not direct per-socket runtime disconnect commands. A member without a current match can attach but receives `unavailable` rather than an invented null-state/lobby DTO.

Membership is not spectator authorization. Each resync reauthenticates membership, checks the current durable match route and actual roster, and selects only the bound seat's live projection. A newly admitted member cannot inspect an older match after rollback, even rollback before creation. Ownership/finishing grant no additional card visibility. No generic lobby-room state broadcast, raw authoritative state/history/events or privilege elevation is introduced. Fresh seat-private action observations use the separate allowlisted action projector.

Final non-refreshing authentication happens before a fresh runtime observation. Projection and synchronous best-effort socket emission then have **no intervening await**, so slow authentication cannot replay an expired reveal. No network acknowledgment/delivery promise is awaited in a host/runtime queue. State/action delivery has a writer-plus-stream epoch and one per-socket increasing sequence allocator. Explicit resync, rollback and writer replacement establish a fresh stream; initial/recovery/resync baselines are state-only. Resync is not reliable action replay, an outbox or a command acknowledgment. Gameplay acknowledgments are separate and retain historical heads on duplicate delivery; they are not state-update cursors. Attached sockets now receive best-effort live updates automatically; explicit resync discards pending old observations and starts a new baseline. Wrong/current-game races fail conservatively and require a fresh request/connection, never silently retarget an old operation.

## Bounded gameplay routing — Stage 8.9

An authenticated resync must first establish the socket's one-lobby attachment. Gameplay intents contain game/branch but no lobby or actor authority. For every operation, the adapter resolves fresh membership, checks the current match route through the host, explicitly constructs a command with the authenticated seat and original request ID, and dispatches with the exact client branch and server-owned `human` controller.

Supported intents are `draw-card`, `play-card`, `take-bottom`, `open-stump`, `penalty-response`, `cast-vote`, `request-withdrawal`, `withdrawal-response`, `propose-bot`, and `replacement-vote`. Procedure/card/claim IDs, ballots, approvals and refusal nulls are preserved exactly; `absentSeatId` is only the replacement target. No browser intent is spread into a trusted command. **All `submit-claim` variants, including spoken claims, remain disabled**, along with rollback, owner-history, chat and start. Existing procedure replies are supported without claiming a complete external claim flow; tests seed those claims through trusted fixtures.

The approved optional `dispatch.admit` guard runs inside the runtime queue before receipts/rules. It performs a non-refreshing credential check and verifies current socket liveness, expiry, actual roster membership and connected human control. Guard false is a headless `unauthorized`; guard infrastructure failure is a headless `unavailable`, not a runtime fault. Neither accepts/persists a command. An idle queued command cannot act through another tab's retained seat presence after its own socket was cancelled. Guards await only bounded server-owned authorization, never delivery or re-entrant queue work.

No turn, beat, stump entitlement or ordinary-play expected-version gate is introduced. Well-shaped current-branch attempts still reach the engine and can be accepted violations. Wrong-game routing returns fixed `wrong-game` without a head; an authorized stale branch/procedure returns the existing command rejection, never silent retargeting. Old accepted IDs cannot replay abandoned-branch actions. IDs retain the existing **per-runtime, not per-seat namespace**: same-ID/changed-payload or cross-seat collisions reject as `command-id-reused`; actor-bound identical retries execute once, including after durable recovery.

Only `makeCommandAck` output is emitted after dispatch commits and a final credential check succeeds. Acknowledgments contain outcome/head/duplicate or an allowlisted rejection, never cards, events, history, receipts or one-time observations. A duplicate's head is its historical committed head and must not regress a client's current state. An action admitted before disconnection drains atomically; canceled/expired/revoked peers receive no accepted acknowledgment, and the original ID settles later retry. Failed storage emits no accepted acknowledgment, faults/discards the draft through the existing host path, and later recovery uses durable state. Stage 8.10's independent publisher sends authorized state/actions; it never reconstructs observations from command receipts or acknowledgment retries.

## Committed live/action publication — Stage 8.10

A resync-authenticated participant socket watches the lobby through the approved server-private `PostgresGameHost.subscribe` seam. It follows only successfully installed live writers; private successor preparation is never observable. Synchronous writer invalidation cancels old queued work before disposal, then committed replacements bind a new state-only baseline. The adapter makes one host acquisition attempt after invalidation; writer refusal/failure disconnects rather than forcing ownership or retrying unknown errors. A successfully recovered writer or successor rebinds existing authorized sockets automatically.

Each ordinary committed runtime publication delivers its **exact ordered fresh action pairs**, using `makeActionMessage`, then one captured final state using `makeStateMessage`. A job containing multiple actions preserves each adjacent action head, not a synthesized whole-job pair. Controls with unchanged action heads still publish state. Duplicate/rejected/checkpoint jobs add no observations when the committed view is unchanged. Creation/recovery/resync baselines never replay actions, receipts, peeks or inherited history. A baseline starts at its authorized emission point; observations already superseded while initial authentication waited are discarded, not replayed after that baseline.

Every action/state packet performs fresh non-refreshing credential/seat authorization and checks current game/roster, writer epoch, branch, stream generation, liveness and expiry. Projection and actual emission are synchronous within a fresh runtime observation, with **no intervening await**. Captured action pairs/final states are retained, but emission-time runtime time hides expired reveals; a later claim/disconnection that paused the same reveal also suppresses its face in an older queued state. Ordinary hand visibility is unaffected. Raw snapshots and pairs stay server-private.

Explicit resync invalidates old work when its validated request is received, before incoming queue/authentication delays. Rollback invalidates old-branch work synchronously on the committed notice; handoff, disposal, disconnect, revocation and shutdown invalidate old writer/socket work. Unsent observations are discarded. Already-emitted data cannot be recalled, and clients must reject stale epochs/branches and clear old interactions. No uncertain emission or private peek is retried. Delivery failure cannot fault/reapply an accepted game action.

All outgoing `server-message` packets, including command acknowledgments/errors, share a bounded wire queue. **Only one packet is in flight until its transport receipt arrives**. Its unpredictable per-emission nonce prevents speculative acknowledgments of predictable Socket.IO packet IDs from crediting unread frames. Timeout, invalid receipt, queue/byte overflow or projection/auth failure disconnects that recipient and requires reconnect/resync. A fixed final technical error may drain before closure after private work is invalidated. Other sockets and runtime deadlines continue; no network acknowledgment promise is awaited inside a host/runtime queue. Receipt means this emission was received, not that animations finished, nor exactly-once application consumption.

Default trusted `delivery` limits are 64 captured publications / 4 MiB serialized private capture, 32 queued/in-flight wire packets / 256 KiB accounted payload, a 64 KiB prepared-frame reservation, and a 2000 ms receipt timeout. Accounting includes a conservative framing/nonce allowance. Limits include active work, not just queued arrays; Socket.IO/Engine.IO buffering cannot grow with an unread recipient because the next emission waits outside authoritative queues. Oversized single frames fail closed. `delivery` configuration is server-owned; it is not accepted from clients. These are initial operational bounds, not new game punishments or a reliable outbox.

## Cancellation, expiry and revocation

A socket's AbortSignal is passed to the host's additive optional `attach(binding, signal)` seam. The host checks it **inside its serialized admission**, before connection insertion/presence. Cancelled queued attachments cannot briefly reconnect/unpause a revoked or departed seat. Already-admitted atomic commits are not undone: cleanup drains and detaches afterward. Disconnect/shutdown/revocation invalidate pending emissions immediately and dispose late detach handles.

`PostgresGuestAccess.inspect(token, nowMs)` is a server-private, non-refreshing durable check; it returns only the private session/expiry binding or null, with fixed storage failures. It does not extend `last_seen_at_ms` or expiry. `inspectSeat(token, lobbyId, nowMs)` additionally joins durable credential/membership/current-lobby data without refreshing expiry, returning only a server-private seat binding or null. It is used for automatic publication so an idle socket is not kept alive by other players' actions. Normal incoming authorized membership operations still apply the existing sliding policy. Clients should use the HTTPS refresh endpoint to renew their actual browser cookie.

The default non-refreshing scan cadence is 1000 ms (`authPollMs`, trusted test/operations option, 10–60000 ms). Idle sockets do not keep a credential alive. A refresh from another tab is observed durably, so stale expiry timers do not disconnect it. Storage failures fail closed. Server-mediated revocation invalidates all local active/pending peers after durable commit; external revocation/expiry is observed during a scan or an operation's credential check, not through immediate distributed notifications. Detection includes scan/query latency and depends on deployment DB timeouts. There is no distributed socket registry or account recovery.

## Technical bounds

These are transport limits, not gameplay punishments:

- Engine.IO packet limit 16 KiB before Socket.IO JSON decoding; binary headers/attachment streams are refused.
- HTTPS header size 16 KiB, maximum 40 parsed headers, 5-second header / 10-second request timeouts; session bodies accept no data.
- 60 connection attempts/minute/IP; at most 256 Engine.IO connections and 256 admitted/pending namespace peers.
- 60 session requests/minute/IP, with issuance additionally limited to 6/minute/IP.
- 20 application events/second/socket, 120/minute/credential, at most four queued operations/socket. The socket budget uses its immutable lifetime identity; rotating publication epochs/resync cannot reset it. Limits apply **before** event-name/argument validation; flooding malformed events cannot produce unlimited errors.
- Fixed-window limiter stores at most 4096 keys and refuses new keys at capacity rather than evicting active limits. Observed remote addresses are used directly, never forwarded addresses.

Deployment-wide network/DoS controls, proxy support, storage-volume profiling, further per-operation/gameplay/chat tuning, browser lifecycle and UI remain later hardening work. The supported gameplay subset uses the existing packet/event/credential/queue caps. This slice is not authorization for public deployment of the unfinished game.

## Verification

`src/server/transport.postgres.test.ts` uses real ephemeral HTTPS, explicitly trusted test certificates, real Socket.IO clients and disposable PostgreSQL. It covers session cookies/origins, forged/duplicate/oversized credentials, 2/4/8 isolated seat-private baselines, multiple-tab presence, cancellation/revocation races (including committed presence), non-refreshing expiry and another-tab refresh, delayed-auth reveal expiry, stale handoff routing, restart without private peek replay, post-handshake origin rejection, nonparticipant/pre-creation privacy, storage failure cleanup, shutdown during pending authentication/attachment, issuance/event limits, binary and oversized packets. Stage 8.9 additionally drives the ten supported command types with authenticated clients, including 2/4/8-seat drawing/penalties/round interactions and punishable peeks. It covers cross-tab duplicate delivery, changed/cross-seat ID collisions, abandoned branches and recovery, stale procedures, wrong routes/forged identity, cancellation while waiting in the runtime queue, current controller checks before cached receipts, admission SQL failure and failed durable commits. Stage 8.10 adds 2/4/8-seat ordered live actions/state, exact multi-action jobs, private peeks/transfers, no retry/recovery replay, pending-publication rollback/resync invalidation, automatic successor/recovery baselines, non-acknowledging/forged-receipt clients, capture overflow and stream-reset rate regression coverage. Claim creation, rollback and match preparation remain trusted fixtures, not exposed handlers.

Two unit tests cover limiter windows/cardinality, four outbound tests cover bounded/invalidated/uncertain delivery, and four runtime admission tests cover queue admission. The host PostgreSQL suite covers lifecycle rebinding and listener/reporter failure isolation as well as actual queued-attachment cancellation. The dedicated PostgreSQL runner includes the transport suite. These checks do not establish browser cookie behavior, a browser UI, full external rule-complete matches, a browser application or reliable/exactly-once action delivery.

The certificate/private key under `src/server/testing/` are **public, disposable test fixtures**, trusted only by these Node test clients. Never use them in deployment, install them in a system trust store, or disable global TLS verification to run the suite.
