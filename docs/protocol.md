# External protocol — Stage 8.4

This is a transport-independent contract/validation library, **not itself an HTTP/Socket.IO server**. Stages 8.8–8.10's separate `PenkyTransport` consumes resync/a bounded gameplay subset and emits safe state/action/error/command-ack envelopes; see `transport.md`. Stage 8.11 binds claim submission through authoritative queued evidence resolution; Stage 8.12 binds current-match owner-history and rollback selectors and adds the approved metadata-only rollback-notice envelope. Stage 8.13 binds authenticated retained-chat submission/history using existing DTOs; start-match remains disabled. Engine/runtime commands, persistence records and projection inputs remain trusted server interfaces. A decoded intent is neither authenticated nor an accepted game action.

## Incoming messages

`decodeClientMessage(unknown)` accepts already-deserialized plain data records:

```json
{
  "protocolVersion": 1,
  "requestId": "stable-request-id",
  "intent": {
    "type": "play-card",
    "gameId": "game-id",
    "branchId": "current-branch-id",
    "cardId": "opaque-own-card-handle"
  }
}
```

All keys are exact, own data properties; nested extra keys, accessors, inherited fields, symbols, arrays in place of records and unsupported intent types are rejected. No coercion, trimming, normalization or input mutation occurs. IDs are validated nonblank strings before branding, not restricted to UUID syntax. Valid prototype-like ID values remain supported. NUL and malformed Unicode are rejected in strings. Rejections contain only `invalid-message` or `unsupported-version`, never paths, values, input objects or exception diagnostics.

### Intent vocabulary

| Intent | Additional fields (besides `type`) |
| --- | --- |
| `draw-card`, `take-bottom` | `gameId`, `branchId` |
| `play-card`, `open-stump` | game route plus `cardId` |
| `penalty-response` | game route plus `procedureId`, `cardId` (explicit null means refusal) |
| `cast-vote`, `replacement-vote` | game route plus `procedureId`, `vote` (`yes`/`no`/`abstain`) |
| `request-withdrawal` | game route plus `claimId` |
| `withdrawal-response` | game route plus `procedureId`, strict boolean `approve` |
| `propose-bot` | game route plus `absentSeatId` (a target, never the actor binding) |
| `submit-claim` | game route plus `accusedId`, nonblank `reason`, unresolved `evidence` |
| `rollback` | `target: { expected: { gameId, branch, version }, beforeActionVersion }`, boolean `knowledgeWarningAcknowledged` |
| `owner-history` | `gameId` |
| `resync` | `lobbyId` (server resolves the current match, not an old client branch) |
| `post-chat` | `lobbyId`, stable `messageId`, verbatim nonempty `text` |
| `chat-history` | `lobbyId`, `afterSequence` string, `limit` |
| `start-match` | `lobbyId`, `expected` (null for first match, otherwise exact `{ gameId, branchId, version }` of the observed prior result) |

Procedure replies return the exact visible `timer.id` as `procedureId`; withdrawal requests use the visible claim ID. The decoder never silently retargets a stale procedure. Rollback `branch` is a positive **display ordinal**, not a runtime branch ID; `beforeActionVersion` selects a completed action to roll back before, must be positive and cannot exceed the displayed expected version. A false warning acknowledgment is well-shaped input but does not authorize rollback.

Evidence is one of `{ type: 'spoken', key }`, `{ type: 'chat', messageId }`, `{ type: 'action', commandId }`. Action references can name opaque IDs from authorized fresh action views; this does not add a generic player history or guarantee reference availability. Neither evidence authorship/provenance nor current scope is established by decoding. Client `scope`, `scopeNumber`, incident keys and author fields are forbidden. Stage 8.11's queued resolver establishes original author/actor, accused consistency, lobby/game, original scope and active-branch provenance from server-owned history. Spoken episode identity retains the existing explicit-key/social rules.

### Initial resync transport — Stage 8.8

`PenkyTransport` accepts exactly one protocol object on `client-message` and emits existing state/error envelopes on `server-message`. It reauthenticates cookie membership, checks actual current-match participation, and projects a fresh baseline synchronously with emission after final credential validation. No pending authentication can replay an expired reveal. Writer/socket epochs and per-socket sequences are allocated for baselines only, not reliable live/action publication. No current match yields `unavailable`; nonparticipant membership yields `unauthorized`, never implicit spectator access. Deferred well-shaped intents yield `unavailable` without gameplay dispatch. Stage 8.9 adds the bounded routing below; the pure decoder/envelopes remain unchanged. See `transport.md` for TLS/origin/limits/cancellation and real network coverage.

### Authenticated gameplay subset — Stage 8.9

After resync establishes a socket's lobby, `PenkyTransport` accepts draw/play/take/open, penalty responses, vote/withdrawal responses and bot-replacement controls (ten explicit intent types). Server membership supplies the actor, `absentSeatId` is only a target, and card/procedure/claim references remain exact. Stage 8.11 additionally binds claim submission; Stage 8.12 additionally binds rollback and owner-history; Stage 8.13 additionally binds post-chat/chat-history; start-match stays disabled. No client identity/controller/configuration field or ordinary-play version/turn gate is introduced.

An approved optional runtime admission guard checks fresh credentials and current socket/roster/human control inside the queue before receipt lookup. Headless denial is `unauthorized`; infrastructure failure is fixed `unavailable`, without faulting the runtime. Wrong-game intent routing is a headless `wrong-game`; authorized old branches/stale procedures preserve existing command rejection codes. Accepted IDs keep the existing per-runtime namespace: changed/cross-seat payload collisions reject; duplicates retain their original head and never become current-state cursors. Acknowledgments come only from committed dispatch and expose no private observations. Stage 8.10 adds bounded best-effort live/action publication below; full external claim/admin flows remain deferred.

### Authoritative claim binding — Stage 8.11

The existing `submit-claim` DTO is unchanged. Runtime queue admission authenticates before receipt lookup; exact accepted claim retries retain their original canonical scope before any new resolution. A new request resolves spoken scope at queue execution, immutable chat authors/original contexts, or initiating action actors/original action scopes. Active inherited prefixes are valid; abandoned futures and system/non-attributable references are not. Invalid provenance maps to fixed `invalid-claim`, closed scope to `scope-closed`, and resolver infrastructure failure to headless `unavailable`, without leaking evidence or creating punishment. The engine retains incident deduplication and all claim procedures. See `transport.md` and `runtime.md`. Stage 8.12 binds owner-history/rollback; Stage 8.13 binds chat creation/history; start-match remains deferred.

### Owner history and rollback — Stage 8.12

Existing incoming `owner-history` and ordinal `rollback` DTOs are unchanged. Both require a one-lobby authenticated attachment and fresh owner membership. Only the current lobby game is routed; no arbitrary old-game reader/writer is acquired. Original owner identity is checked independently of rollbackable state, including finished/pre-creation states. Owner status never adds live card visibility.

History is projected from a detached committed capture at the prepared outbound emission slot after final non-refreshing authorization, with no intervening await before projection/emission. It shares stream epochs/sequences and the existing frame/queue bounds; large histories disconnect rather than leak raw archives or silently paginate. Receipt-time generation/watch checks discard history superseded by resync, rollback or writer replacement, even if still waiting in the inbound queue.

Selectors map persisted display ordinals and completed-action versions to exact canonical expected heads/command targets. Observe then dispatch is optimistic: intervening actions reject, never retarget. Retained source branches reconstruct identical accepted retries before runtime receipt lookup; new archived requests still fail current-head checks. Warning/owner/controller/presence/closure checks remain authoritative. No client identity/raw branch ID is trusted, no timestamp/branch configuration is regenerated, and no receipt format changes.

The operator approved additive `RollbackNoticeMessage`: `{ protocolVersion: 1, type: 'rollback-notice', delivery, notice: { actorId, target: { expected: HistoryHead, beforeActionVersion }, head: HistoryHead } }`. Heads use display branch ordinals, not private correlated identifiers. It contains no card faces/handles, raw command IDs, events, ballots, snapshots or previews. Only a fresh committed rollback emits the notice to freshly authorized current-match participants, before its action/state stream, including a rollback to null state with no action pair. Duplicates, initial/resync/recovery baselines and failed commits never replay it. Delivery remains bounded best-effort, not an outbox or an offline-notification guarantee.

### Authenticated retained chat — Stage 8.13

The operator approved **messageId as durable chat identity, requestId as correlation only**. `(lobbyId, messageId)` binds exact server-authenticated author session/seat and verbatim text to one immutable record. Identical retries may use another requestId; they return the same message/sequence/time/original context. The same requestId with a different new messageId is another operation. Changed author/text reuse is fixed unavailable, without prior-record disclosure. No request ledger, schema, DTO or gameplay command-ID namespace changes.

Both intents require an established one-lobby attachment and fresh membership, not actual current-match participation or human control. A resync attempt can establish the attachment even if no game exists or the member cannot view its roster. Chat never authorizes private game state or starts a subscription. Author and original scope/head/time come from server storage/runtime, never client fields.

`post-chat` returns an existing `chat-page` with one committed immutable message; `chat-history` returns a bounded page after its canonical decimal cursor. The 1–100 count limit is also capped by a serialized frame budget (at most 64 KiB including a 128-byte framing allowance). Return an ordered prefix; clients continue after the last sequence even if fewer than requested rows arrive. Never trim/normalize/truncate text or skip rows. An individually oversized trusted row produces fixed unavailable rather than an ambiguous empty page. Empty page otherwise means no remaining rows. Author session IDs, extra storage fields, raw runtime state and private observations are omitted by the existing builder.

Queued posting admission runs before duplicate lookup/insertion. Final non-refreshing authorization occurs at the bounded outbound slot immediately before synchronous projection/emission. Receipt-time generation/watch fencing discards stale history without treating cancellation as a wire fault. Committed post replies survive resync as correlated responses with original context, not current-state cursors. There is no unsolicited chat push, reliable replay/outbox, browser rendering or UI. Start and lobby admission remain separate increments.

### Committed live stream and transport receipts — Stage 8.10

The existing version-1 `StateMessage`/`ActionMessage` shapes are unchanged. A subscribed socket receives each committed job's exact fresh action pairs in order, followed by its final state; same-head controls still receive sequenced state. Initial/resync/recovery/successor baselines are state-only. Baselines are authorized at emission and drop older queued observations; duplicate acknowledgments never replay action observations. Stream epochs rotate on resync, rollback and writer replacement; sequences order state/action packets, not historical command receipts.

The outgoing Socket.IO event is now **`server-message(message, receipt, acknowledge)`**. Clients must echo the opaque per-emission receipt in the callback promptly, not after long animations. The nonce prevents fabricated acknowledgments of predictable packet IDs; it is not authentication, a command ID or permission to replay an observation. One in-flight packet, count/byte caps and timeout bound application and underlying socket buffering. Overflow, timeout or invalid receipt disconnects; reconnect/resync obtains state only, never retries uncertain observations. No new reliable outbox, incoming operation, game rule or persisted format is introduced. See `transport.md` for exact limits and lifecycle semantics.

### Technical bounds

`PROTOCOL_LIMITS` currently sets request IDs to 128 UTF-16 code units, references/spoken keys to 256, reason/chat text to 4096, and pages to 1–100 messages. Chat whitespace is preserved; a whitespace-only reason is rejected. Reference room accommodates suffixes derived from accepted request IDs. Future server ID allocation must fit these bounds. Sequence cursors are canonical nonnegative decimal strings within PostgreSQL signed-bigint range; versions/ordinals/limits are safe integers with their documented minima. No timestamp, floating-point coercion or client clock is accepted.

These are technical API limits, not game rules or penalties. This decoder does **not** parse bytes, enforce transport byte/depth limits before deserialization, rate-limit connections or validate a whole arbitrary JSON tree. Those boundaries must be installed in the transport before exposure. Lobby creation/join/admission, readiness/house-rule editing and minigame intents are deliberately not invented here.

## Authority, staleness and retries

- Never accept browser `actorId`, `ownerId`, session/controller/author identity, clock/expiry/connection commands, randomness, roster, successor/card IDs or authoritative state. The external union is explicit, not derived from internal runtime types.
- Game intents carry game and branch identity, but ordinary play has **no expected-version lock** and no turn/beat/stump eligibility checks in decoding. Well-shaped deliberate out-of-turn/invalid-beat/peek attempts must reach the engine after authentication. Wrong-game/obsolete-branch routing is still a server duty; syntactic validity proves neither.
- Bind session membership, seat/controller and owner privilege on the server. Bind the validated request ID to the trusted command only after authorization. A valid target `accusedId` or `absentSeatId` is not an actor credential.
- Resolve rollback display selectors against a fresh matching committed capture, then retain runtime owner/warning/head/closure checks. Never cast an ordinal into a branch ID.
- Preserve request IDs and exact intent content across gameplay/admin retries. For chat, approved 8.13 semantics use messageId as the durable operation identity and requestId only to correlate replies; exact author/text/context remain immutable across message retries. Start handlers must look up the canonical accepted/in-flight intent before generating server identities or selecting a roster; never regenerate configuration for a retry. These orchestration handlers are not implemented by the decoder.

## Outgoing envelopes

`src/protocol/messages.ts` constructs allowlisted envelopes, never generic serialized blobs:

- `makeStateMessage`, `makeActionMessage`, `makeOwnerHistoryMessage` invoke their authorized projectors directly. They accept trusted authoritative inputs and viewer bindings, not prebuilt DTO objects with potentially leaking extra properties. Reconnect uses current live state, not historical action observations. Duplicate action inputs produce no observations; the future publisher must enforce fresh committed delivery.
- State/action/history messages include server-supplied `{ epoch, sequence }` delivery metadata. It is independent of game-head versions, which need not change for control-only effects. Allocation, restart epoch lifecycle, ordering and resync are later publisher work, not a new persistence contract here.
- `makeCommandAck` selects only accepted outcome/head/duplicate or a reviewed fixed rejection code/head. Unknown internal outcomes/codes yield a fixed unavailable error; extra receipts, commands, state and diagnostics are not copied. An acknowledgment head may be historical on retry and is **not a state-update cursor**.
- `makeChatPage` preserves original text, author seat, sequence, time and original context/head, but omits author session IDs and arbitrary extra properties. It does not authenticate lobby access or escape HTML for a future renderer.
- `makeMatchStartAck` selects safe successor identity/duplicate status or mapped rejection codes. Never serialize the live session/runtime or canonical private start request.
- `protocolError` returns only reviewed technical codes, falling back to `unavailable`. Never send exception messages/causes, validator paths with values or invalid request IDs back to a viewer.

Builders do not authenticate, commit or publish. Stage 8.6's server-private `GameRuntime.subscribe` can supply committed snapshots and exact fresh action pairs without a network dependency; never serialize its raw notice. Subscribe to successor runtimes only after successful atomic starts. Stage 8.10's host/transport now authorizes each live-stream recipient and allocates bounded/ordered stream epochs/sequences with fixed failures. Stage 8.11 implements queued evidence resolution; Stage 8.12 integrates committed owner-history capture and ordinal selector resolution. Additional history capture must occur synchronously at the committed callback point, not by reading staging history after delivery awaits. No network, real-browser or database verification is implied by pure decoding/envelope tests or test-only explicit runtime bindings.
