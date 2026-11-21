# Open decisions discovered during implementation

## D006 — Bot observation entitlement (10.1)

**Status:** operator approved committed seat-authorized observations rather than confirmed network deliveries. This is availability to the seat, not proof the human saw it. The pure `src/bots/observation.ts` adapter returns only existing seat projections, including normal finished-seat restrictions. Null state has no seat binding. Exact committed fresh action pairs may supply permitted private observations; duplicate captures disclose none. Recovery, resync and rollback must not replay historical observations as fresh. Commit/freshness classification remains the trusted caller's obligation, not something this stateless adapter can prove.

This authorizes only 10.1. Rollback knowledge (10.2), atomic durability/legacy games (10.3) and autonomous execution remain separate approval gates; no memory or capture integration is implemented.

## D005 — Stage 8 acceptance and lobby agreements/readiness integration

**Status:** approved and implemented in Stage 8.18. The operator accepted private per-socket routing, all-durable-member acceptance and exact reset causes, then approved the bounded server-only API/persistence proposal in principle and authorized proceeding once acceptance/epoch semantics were clarified below.

**Routing resolved:** retain authenticated private per-socket host lifecycle subscriptions (`PostgresGameHost.subscribe`, `PenkyTransport.#publication/#publish`) in place of literal application Socket.IO rooms. Existing authorization, recipient isolation, reconnect and delivery tests remain enabled. No redundant routing layer is introduced.

**Already approved in rules §2:** the owner edits textual agreements before a match; editing is locked during play, when text remains readable; readiness expresses agreement; changing the text resets everyone's readiness. Spoken agreements need not be recorded. These facts are not reopened. There is no readiness button between rounds (rules §6.1).

**Consent, not general match readiness:** `ready` means acceptance of the current lobby agreements only. No separate general willingness-to-play flag is required by the approved rules or implemented. Every durable member, including owner and disconnected members, must accept before any new member-backed match starts. Credential loss does not delete membership or grant acceptance.

**Acceptance epoch:** `revision` is a nonnegative decimal-string bigint epoch, not a whole-view version or publication cursor. It advances and all acceptances clear on actual stored text change, a genuinely new durable member, and successful new-match start. Individual true/false acceptance updates do not advance it: concurrent members confirm the same epoch without conflicts. Initial lobby revision is 0 with owner unaccepted. Same-text submissions, membership retries, disconnect/reconnect, rollback and failed starts do not reset or advance it. Stale CAS fails without mutation, even if its submitted text happens to match; matching-epoch identical text is a successful no-op while editable. Same-seat concurrent desired booleans serialize; no toggle or mutation receipt ledger is invented.

**Implemented contracts:** cookie/origin-authenticated POST `/api/lobbies/state`, `/api/lobbies/agreements`, `/api/lobbies/ready`; exact shapes and errors in `transport.md`. Durable members read; only owner edits; each member updates only its own acceptance. Both mutation types are locked unless no match is assigned or the exact durable current match is verified finished. Reserved null/corrupt state is not editable. Empty verbatim text is allowed, bounded to 4096 UTF-8 bytes with no NUL/malformed Unicode; raw workflow bodies are capped at 32 KiB. Responses allowlist epoch/text/editability, ordered seat/acceptance statuses and current match's immutable agreement binding, never credentials or private cards/state. No-game socket resync remains unavailable; HTTP state is the separate lobby read seam.

**Atomic start and rollback:** migration 005 adds lobby text/epoch, per-member acceptance and immutable per-game agreement records. Final lobby-locked admission checks the exact roster and every member's consent, then snapshots current text/epoch and clears consent/advances epoch in the same transaction as closure/successor/pointer/start receipt. New starts bind the final accepted epoch without extending the existing start intent. Accepted canonical retries resolve first, never re-gate or reset. Legacy zero-membership trusted lobbies remain compatible; historical bindings are not fabricated. Later edits and rollback never rewrite a match's original text/epoch or roll back current lobby consent; a restored running match locks mutations while both current lobby and original match text remain readable. Policy refusal preserves old history/writer; infrastructure failures remain fail-closed. Credential → lobby → game-head lock order and no access-SQL-lock waits on runtime queues are preserved.

This resolves the server prerequisite only. Stage 9 UI/dependencies, bots, reliable delivery, accounts/recovery and revision-1.4/minigame work remain in their existing later scopes.

## D004 — Guest credentials and initial lobby admission

**Status:** approved and resolved for Stage 8.5 by the user.

- Server-issued cryptographically random opaque guest token; only its hash persists in PostgreSQL. Browser deployment uses a persistent Secure/HttpOnly/SameSite=Lax cookie with a 30-day sliding lifetime.
- Revocation/expiry never releases a seat or transfers ownership. Losing/expiring the credential loses access; no recovery by display name/lobby code, credential-recovery mechanism or implicit host transfer is introduced.
- Owner takes the first seat. Later authenticated guests receive server-assigned clockwise seats, at most eight. New seats are admitted only when no match is running; existing members may reconnect. Spectator admission, kicking, seat reassignment and host transfer remain deferred.

The durable gate admits new seats before a match pointer is assigned or after a verified finished current game. An assigned unfinished/suspended/pre-creation-rollback match keeps admission closed; unknown/corrupt state is not proof of completion. A later rollback cannot insert newly admitted lobby seats into an old match roster. Legacy trusted lobbies get no fabricated credentials or automatic adoption. See `docs/guest-access.md` for transaction, cookie and future transport obligations.

## D003 — Metadata-only owner history

**Status:** approved and resolved for Stage 8.3 by the user.

- Owner history across active and abandoned branches contains action labels/actors, violations, selected claim metadata and final decisions, branch labels, and completed-action rollback references.
- No card faces or card handles appear, including previously public cards. No state previews or replayed reveal/peek/transfer observations are available through history.
- Ordinary current seat visibility remains separate; ownership does not expand it. Individual ballot/approval choices and penalty selections are not administrative history disclosures.

Implementation uses branch/action ordinals rather than raw branch/command/event/claim/procedure identifiers, avoiding accidental disclosure through identifiers derived from private data. The server must resolve an active rollback selector against a fresh matching committed capture and still enforce the existing owner, warning, head and closure checks. User-authored claim reasons remain text, not machine-enriched card descriptions. Committed capture and session authentication remain transport integration responsibilities.

## D002 — Transient disclosure presentation

**Status:** approved and resolved for Stage 8.2 by the user.

- The private initial-recipient notice may be reissued on refresh/reconnect before the first successful draw. Out-of-turn attempts do not consume it; no continuing dealing-turn hint is added.
- Hide the final-card reveal while its timer is suspended (including claims and disconnection). Resume only its remaining time; expiry never grants a new display window.
- An illegal own-stump peek is a one-time fresh-action response to that seat. Do not replay it from snapshots, the private knowledge ledger, reconnect, history or duplicate receipts. A separate new illegal click is still a separate punishable action.

**Stage 9.7 presentation approval:** the operator approved an actor-only, dismissible fresh-peek notice, ending on dismissal or when its associated penalty ends/changes, whichever comes first. Also clear it on pause, disconnect, resync, rollback or game change. There is no new timer, reopening, persistence or replay. This resolves the browser lifetime/dismissal choice without changing the underlying peek rule.

These presentation decisions are reflected in rules §§3.2, 3.3 and 6.4. They do not change engine timers, physical card locations, rollback knowledge limits or bot-memory policy. Pure projectors cannot prove delivery freshness: the future authenticated publisher must supply committed action pairs and classify duplicate deliveries.

## D001 — Repetition entirely inside one round

**Status:** approved and resolved in specification revision 1.3. No open product decision remains for D001.

The original criterion checked only settled round boundaries. It covered scenario 16 but missed states recurring inside one round. The approved extension checks settled states after gameplay actions as well.

### Minimal reproducer

Three participants, no trump, no stumps. A round is already active with target N = 3. The table contains A♥ (ace of hearts), and A is next.

- Player A: 6♥, 6♣.
- Player B: 7♣.
- Player C: 7♥, 8♣.
- All other cards are in discard.

| Action | Table, bottom to top | Effect |
| --- | --- | --- |
| A plays 6♥ | A♥, 6♥ | Six legally beats same-suit ace |
| B takes bottom A♥ | 6♥ | B now owns the ace |
| C plays 7♥ | 6♥, 7♥ | Seven legally beats six |
| A takes bottom 6♥ | 7♥ | A recovers the six |
| B plays A♥ | 7♥, A♥ | Ace legally beats seven |
| C takes bottom 7♥ | A♥ | C recovers the seven; A is next |

The same meaningful state returns after six actions. Table size alternates between 1 and 2: it never reaches 0 or N = 3. Extra club cards prevent automatic pickups from changing the cycle. If the initial state was observed after C's opening ace, its third occurrence is after twelve further actions. The updated engine declares a draw there, preserving the table card.

### Current behavior

- Both boundary and in-round repetition are implemented.
- `src/game/repetition.test.ts` verifies the former six-action loop now draws, without discarding or moving its table card.
- `src/game/match.test.ts` runs complete deterministic matches for all supported seat counts and replays their recorded actions. The previously looping five-seat match now ends in a draw.

### Approved decision

Extend repetition checks to settled states after completed gameplay actions, not only round boundaries. Include the active phase, ordered table stack, current turn, fixed round target/participants, and normalized opening rights, in addition to the already agreed card/seat/trump data. Exclude action IDs, timestamps, chat, and hand order as before.

Count complete atomic actions after automatic consequences; do not count retransmissions, rejected commands, or intermediate events as additional occurrences. Keep the threshold of three and preserve previous winners.

The engine records an explicit `repetition-checked` event only after automatic consequences settle. It also retains the last observed key so unchanged no-op procedures are not extra occurrences. Both the occurrence map and last key belong to rollbackable state. No turn cap or forced discard was introduced.
