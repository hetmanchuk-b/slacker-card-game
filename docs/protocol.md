# External protocol — Stage 8.4

This is a transport-independent contract/validation library, **not a running HTTP/Socket.IO server**. Engine/runtime commands, persistence records and projection inputs remain trusted server interfaces. A decoded intent is neither authenticated nor an accepted game action.

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

Evidence is one of `{ type: 'spoken', key }`, `{ type: 'chat', messageId }`, `{ type: 'action', commandId }`. Action references can name opaque IDs from authorized fresh action views; this does not add a generic player history or guarantee reference availability. Neither evidence authorship/provenance nor current scope is established by decoding. Client `scope`, `scopeNumber`, incident keys and author fields are forbidden. The later queued resolver must establish original author/actor, accused consistency, lobby/game, original scope and active-branch provenance from server-owned history. Spoken episode identity retains the existing explicit-key/social rules.

### Technical bounds

`PROTOCOL_LIMITS` currently sets request IDs to 128 UTF-16 code units, references/spoken keys to 256, reason/chat text to 4096, and pages to 1–100 messages. Chat whitespace is preserved; a whitespace-only reason is rejected. Reference room accommodates suffixes derived from accepted request IDs. Future server ID allocation must fit these bounds. Sequence cursors are canonical nonnegative decimal strings within PostgreSQL signed-bigint range; versions/ordinals/limits are safe integers with their documented minima. No timestamp, floating-point coercion or client clock is accepted.

These are technical API limits, not game rules or penalties. This decoder does **not** parse bytes, enforce transport byte/depth limits before deserialization, rate-limit connections or validate a whole arbitrary JSON tree. Those boundaries must be installed in the transport before exposure. Lobby creation/join/admission, readiness/house-rule editing and minigame intents are deliberately not invented here.

## Authority, staleness and retries

- Never accept browser `actorId`, `ownerId`, session/controller/author identity, clock/expiry/connection commands, randomness, roster, successor/card IDs or authoritative state. The external union is explicit, not derived from internal runtime types.
- Game intents carry game and branch identity, but ordinary play has **no expected-version lock** and no turn/beat/stump eligibility checks in decoding. Well-shaped deliberate out-of-turn/invalid-beat/peek attempts must reach the engine after authentication. Wrong-game/obsolete-branch routing is still a server duty; syntactic validity proves neither.
- Bind session membership, seat/controller and owner privilege on the server. Bind the validated request ID to the trusted command only after authorization. A valid target `accusedId` or `absentSeatId` is not an actor credential.
- Resolve rollback display selectors against a fresh matching committed capture, then retain runtime owner/warning/head/closure checks. Never cast an ordinal into a branch ID.
- Preserve request IDs and exact intent content across retries. Chat also retains its original message ID, author binding, text and stored context. Start handlers must look up the canonical accepted/in-flight intent before generating server identities or selecting a roster; never regenerate configuration for a retry. These orchestration handlers are not implemented by the decoder.

## Outgoing envelopes

`src/protocol/messages.ts` constructs allowlisted envelopes, never generic serialized blobs:

- `makeStateMessage`, `makeActionMessage`, `makeOwnerHistoryMessage` invoke their authorized projectors directly. They accept trusted authoritative inputs and viewer bindings, not prebuilt DTO objects with potentially leaking extra properties. Reconnect uses current live state, not historical action observations. Duplicate action inputs produce no observations; the future publisher must enforce fresh committed delivery.
- State/action/history messages include server-supplied `{ epoch, sequence }` delivery metadata. It is independent of game-head versions, which need not change for control-only effects. Allocation, restart epoch lifecycle, ordering and resync are later publisher work, not a new persistence contract here.
- `makeCommandAck` selects only accepted outcome/head/duplicate or a reviewed fixed rejection code/head. Unknown internal outcomes/codes yield a fixed unavailable error; extra receipts, commands, state and diagnostics are not copied. An acknowledgment head may be historical on retry and is **not a state-update cursor**.
- `makeChatPage` preserves original text, author seat, sequence, time and original context/head, but omits author session IDs and arbitrary extra properties. It does not authenticate lobby access or escape HTML for a future renderer.
- `makeMatchStartAck` selects safe successor identity/duplicate status or mapped rejection codes. Never serialize the live session/runtime or canonical private start request.
- `protocolError` returns only reviewed technical codes, falling back to `unavailable`. Never send exception messages/causes, validator paths with values or invalid request IDs back to a viewer.

Builders do not authenticate, commit or publish. Stage 8.6's server-private `GameRuntime.subscribe` can supply committed snapshots and exact fresh action pairs without a network dependency; never serialize its raw notice. Subscribe to successor runtimes only after successful atomic starts. Their host still must authorize each recipient, allocate/order transport epochs/sequences, resolve current identity/evidence/selectors and catch failures with fixed errors. Additional history capture must occur synchronously at the committed callback point, not by reading staging history after delivery awaits. No network, real-browser or database verification is implied by pure decoding/envelope tests or test-only explicit runtime bindings.
