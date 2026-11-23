# Open decisions discovered during implementation

## D013 — Exact play/pickup opening proof (prerequisite to10.9)

**Status:** operator approved this bounded amendment to D007/D011 after read-only trace/proof investigation. Newly learned entitlement requires a fresh exact committed action pair at an adjacent same-game/branch head, prior remembered `round:n` or `between-rounds:n`, final `between-rounds:n+1`, a nonempty projected list containing only plays/pickups, and an active own seat with final empty hand and remaining stumps. The final boundary ends automatic round movement; no permitted suffix changes this seat's counts or consumes its new right. Other-seat private transfers can be omitted from a seat's observations, so the proof is not a claim that no hidden events occurred globally.

Baseline-only/missing/empty duplicate-redacted/gapped/wrong-round transitions remain unknown. No same-head retrospective repair or regrant; rollback uses exact earlier permitted checkpoints, missing knowledge stays unknown, and recovery never replays archives as fresh. Own transfers, openings or violations do not qualify. Waiting remains required wherever proof is absent. No public right hint, persistence format, authoritative lookup, strategy or complete-match acceptance is authorized. This is one prerequisite increment, not completion of10.9.

## D012 — Conservative bot procedure decisions (10.7)

**Status:** operator approved explicit abstention on every eligible unanswered claim ballot, without evidence-type inference; explicit approval on every eligible unanswered withdrawal consent; and continued explicit refusal for penalty contributions, without a card-contribution strategy. Withdrawal approval is consent, not ballot abstention or silence. Bots never originate accusations, withdrawal requests or human-only replacement votes. Only the currently active eligible unanswered procedure is acted on; suspended ballots, pauses, nested timer semantics and existing stale-work fences remain authoritative. No new evidence projection or gameplay rules are authorized.

## D011 — Conservative legal play and unknown opening rights (10.6)

**Status:** operator approved waiting when permitted memory cannot prove an opening right, even indefinitely. A bot opens only on its own turn with an empty hand and a positively remembered right for the current round. Unknown rights must never be guessed, probed by a punishable peek or bypassed by a potentially forbidden pickup. Legal hand play continues independently. Unknown trump permits only beats legal for every possible trump, not treating unknown as known no-trump. This slice adds simple leads/beats/pickups and mandatory proven openings, not strategy search, voluntary out-of-turn opening or new social policy. Memory is never expanded using authoritative rights or private-history reconstruction. D013 subsequently permits the exact play/pickup boundary proof; unknown-right waiting remains unchanged elsewhere. Complete-match liveness with missing knowledge remains explicitly unproven.

## D010 — Legal dealing and unknown-order fallback (10.5)

**Status:** operator approved drawing only from the seat's private initial notice or remembered successful clockwise draws. If that knowledge is missing, wait without drawing until a fresh permitted observation establishes the order, even if dealing temporarily stalls. Never consult authoritative dealing order, infer card faces from opaque handles, reconstruct missed trump reveals or submit timer-expiry commands. Remember only legitimately permitted reveals, with unknown distinct from known no-trump. Wait through procedures, suspension and final reveal. This authorizes dealing/reveal integration only, not round-play or additional social policy.

## D009 — One safe autonomous action and bot-only admission (10.4)

**Status:** operator approved automatic refusal of an eligible, unanswered penalty contribution only. No dealing, play, accusation, ballot, withdrawal or replacement decisions are authorized in this slice. Policy receives only permitted seat observations; server-owned identity and lifecycle metadata are admission concerns, not privileged policy knowledge.

Bot-only admission must recheck the captured exact head, writer/game/branch, controller tenure and cancellation token inside the runtime queue before receipt lookup. Stale decisions cancel and are reconsidered from fresh permitted observations. Handback, pause, rollback, recovery, successor and writer retirement invalidate pending work; bot→human→bot must not revive old work. Already-admitted atomic actions drain. No-human suspension and ordinary human command semantics remain unchanged.

## D008 — Atomic permitted-memory ownership and recovery (10.3)

**Status:** operator approved runtime ownership of permitted memory for every seat, independent of human/bot controller. Store memory and rollback knowledge checkpoints atomically in the existing authoritative PostgreSQL frame transaction, never via a post-publication write or second writer. Explicitly version the extended format while supporting old records. Legacy/missing knowledge starts unknown; never reconstruct prior observations from private archives. Rollback restores only an exact earlier permitted checkpoint; missing knowledge stays unknown. Corrupt or unsupported memory fails recovery rather than silently granting knowledge.

This approval does not authorize bot scheduling, autonomous decisions or ordinary-command admission changes. Knowledge checkpoints may be bounded and evicted independently of retained game history; an evicted target follows the approved missing-checkpoint policy, not private-history reconstruction.

## D007 — Branch-scoped permitted bot memory (10.2)

**Status:** operator approved restoring only previously captured permitted seat memory at the exact rollback target. Abandoned-future knowledge is excluded; missing checkpoints start unknown, never reconstructed from private authoritative histories. `restoreBotMemory` accepts an exact checkpoint selected by a trusted caller; version equality validates shape, not ancestry or checkpoint provenance. New-branch current observations remain separately authorized. No persistence format, checkpoint store, runtime capture or recovery policy for legacy games is chosen here.

The pure reducer retains source heads for observed dealing progress, trump (unknown distinct from known no-trump), and conservative own opening-right knowledge. Generic between-round/current empty-hand baselines cannot prove a right: originally only a continuously observed simple play-only round completion could grant known entitlement; D013 subsequently permits the narrowly proven play/pickup numeric transition. Missed or otherwise unproven boundaries stay unknown. Legal opening proves consumption; temporary nonempty hands do not erase known rights. This conservative knowledge ceiling does not change engine rules.

## D006 — Bot observation entitlement (10.1)

**Status:** operator approved committed seat-authorized observations rather than confirmed network deliveries. This is availability to the seat, not proof the human saw it. The pure `src/bots/observation.ts` adapter returns only existing seat projections, including normal finished-seat restrictions. Null state has no seat binding. Exact committed fresh action pairs may supply permitted private observations; duplicate captures disclose none. Recovery, resync and rollback must not replay historical observations as fresh. Commit/freshness classification remains the trusted caller's obligation, not something this stateless adapter can prove.

The original approval authorized only 10.1. D007 subsequently resolves pure memory rollback for 10.2; atomic durability/legacy games (10.3) and autonomous execution remain separate approval gates. No runtime capture integration is implemented.

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
