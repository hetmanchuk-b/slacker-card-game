# Proposed ADR — Shared immutable transport captures

**Status: architectural direction approved; staged implementation only.** Approved sequence: (1) immutable committed-capture contract/race-free registration; (2) entry-level fanout/per-peer handles; (3) state-root sharing/accounting/lifetimes; (4) fairness/preparation/backpressure/resets; (5) genuine acceptance/capacity. Complete and independently review each increment before proceeding. Resource quotas below remain provisional. Compression investigations are closed under the current ownership model. Stage10.9 remains incomplete; Stage11 is untouched. Existing acceptance-test drafts remain uncommitted.

## Verified migration progress

**Increment1 complete:** additive server-private `GameRuntime.subscribeCommittedCapture` supplies serialized action-free baselines and ordered committed updates. Each update is cloned once into an owned graph, transitively frozen, and shared only among new-seam listeners. Existing `read`/`subscribe` isolation remains unchanged. Nine new regressions cover mutation, registration across queued command/timeout/same-head control/rollback commits, failed commits, listener failures, unsubscribe/disposal and no replay of private observations. Independent review approved.

Verification against the committed baseline plus increment1: normal `npm run check`534pass/nine DBskips; disposable PostgreSQL-enabled733pass/no skips, including format/lint/types/build. The two unfinished10.9 test drafts were excluded temporarily and restored byte-for-byte. No browser, fanout, resource-accounting or capacity claim; freezing cost remains unmeasured. Increment2 is recorded below.

**Increment2 complete:** each live host entry owns one runtime immutable-capture subscription. The additive host `subscribeCommittedCapture` fans out frozen publication/rollback/lifecycle envelopes; transport queues reference those shared captures. Legacy host `subscribe` still clones notices per observer. Late registration is ordered through the runtime queue and constructs an action-free baseline from the latest owned capture; same-head controls remain separate publications. Release stops the owner, clears its latest capture and invalidates observers before disposal. Owner-callback failures reach matching-epoch observer reporters; one reporter cannot suppress another.

Final focused host35/35 and transport108/108 passed. Parent committed-baseline-plus-increment gates: normal534pass/nine DBskips; disposable PostgreSQL-enabled736pass/no skips, including format/lint/types/build. Inherited acceptance/browser drafts were excluded and restored byte-for-byte. Independent review's owner-failure reporting and mutable-invalidation findings were fixed and reapproved. No browser/capacity claim. Existing64-job/4MiB JSON-expanded peer debt, outbound limits and delivery checks remain unchanged; no state-root interning, new accounting quotas or scheduling yet. An entry pins its latest full capture; baseline registration still incurs `runtime.observe` snapshot construction. Those costs and repetition growth remain for later increments. Increment3 is recorded below.

**Increment3 complete:** entry-owned `CaptureStore` writer capabilities verify game/branch/version and content before canonical root reuse. Cached conservative root/metadata weights replace per-peer JSON sizing; each publication's logical debt counts distinct roots once, while store charges persist until final handle release. Entries retain only admitted state-only owner handles, release idle ownership and reacquire a fresh action-free baseline after capacity recovery. Transport retains queued/in-flight handles; cancellation releases queued work immediately but active work only in `finally`. Admission failure reports delivery failure, never faults the committed game. Existing detached APIs and late authorization/projection remain unchanged.

Store candidates are now enforced as logical admission quotas (2MiB/publication,8MiB/game,64MiB/global,8 games,64 publications/game,2,048 handles);4MiB/64-job peer limits and wire bounds remain. They are NOT validated healthy capacity or heap ceilings. Existing upstream runtime clone/freeze remains synchronous and outside this ledger; only bounded synchronous store construction is reserved/accounted here. Scheduled construction/pending-source admission remains increment4 work, not silently completed.

Verification:100 runtime/store/outbound and149 focused PostgreSQL/TLS cases passed; parent committed-baseline-plus-increment normal gate542pass/nine DBskips, database gate750pass/no skips, including format/lint/types/build. Independent read-only review approved. Synthetic repetition profiles:1,024 positions weigh1,860,542 bytes (three peer jobs exceed4MiB);2,048 positions fail publication admission. Clone/freeze and sizing costs were measured in the synthetic test, not genuine multi-match capacity. Inherited drafts excluded/restored; no browser/Stage10.9 acceptance claim. **Stop here; increment4 is next.**

## Root cause

`GameRuntime.#deliver` clones each publication per subscriber to isolate mutable consumers; `Readonly` does not freeze data. `PostgresGameHost.#bind` installs one runtime subscription per observer, multiplying copies by peers/tabs. Separate detached `MemoryHistory.read()` calls create action-before, action-after and final snapshot objects. Equal values therefore do not share identity; `structuredClone` preserves existing aliases but cannot discover equality.

The engine does **not** blanket-clone states: `applyAction` starts from the prior state and constructs replacements. Repetition tracking shallow-copies a growing dictionary whose private keys encode complete gameplay positions. Runtime/history detachment loses opportunities to reuse roots and components.

Transport retains complete captures through ordered receipts and charges expanded JSON per peer. The genuine8-seat failure retained2,800,294 bytes when a1,411,729-byte capture arrived, exceeding4MiB at depth3. Authorization/projection latency permits backlog despite immediate ACKs. Compression experiments bounded counters by discarding work and starved slow peers; they did not validate production delivery.

**Source anchors:** `src/runtime/runtime.ts` (`#deliver`, `#view`, `#commit`); `src/server/game-host.ts:#bind`; `src/persistence/memory-history.ts:read`; `src/game/repetition.ts`; `src/server/transport.ts` (`#publication`, `#publish`).

## Alternatives

| Option | Trade-off / decision |
| --- | --- |
| Current per-subscriber copies | Mutation isolation is simple, but duplicated graphs and sizing scale with peers. Retain detached APIs where promised, not this delivery ownership. |
| Shared immutable captures + peer handles | Removes subscriber copy multiplier; requires enforced immutability and explicit lifetimes. **Recommend first.** |
| Structural sharing | Reuse proven identical state roots, immutable cards and unchanged components. Audit ownership before borrowing engine roots; do not change persistence. **Add narrowly.** |
| Persistent repetition-map redesign | May reduce dictionary copying across versions; broader replay/serialization migration. Defer; never prune repetition counts or use a mutable shared Map. |
| Delta capture storage | Adds baseline chains, reconstruction and fork-dependent retention. Last resort if simpler sharing is insufficient. Compression is not assumed. |

## Recommended architecture

1. **One capture owner per live game entry.** Add a trusted committed-capture seam and entry-level fanout, preserving existing detached reads/subscriptions. Do not simply delete generic subscription cloning.
2. **Own and freeze once.** Publish a transitively immutable capture only after persistence. Never expose/freeze a mutable draft. Register observers with an ordered action-free baseline and no missed transition or replayed private observation.
3. **Canonicalize by provenance.** Reuse state roots across action-after, final snapshot and next action-before only within the same writer epoch/game/branch/version. Same-head runtime controls remain publication-specific. Head equality alone cannot intern arbitrary caller data; inconsistent content fails closed. Keep every original replay field and existing `projectAction` validation.
4. **Queue handles, not copies.** Each peer retains its own cursor, authorization, generation, branch, sequence, receipt and deadline. Keep fresh credential/participant/expiry checks, current reveal suppression and projection/emission at the existing late authorized boundary. Never share viewer-specific payloads across seats.
5. **Release explicitly.** Owner and queued/in-flight handles pin captures. Release completed pairs when nobody needs them. Cancellation invalidates delivery immediately but retains charges until active work settles. Final release removes store references; GC/RSS reclamation is separate.
6. **Preserve no-gap semantics.** Overflow disconnects/resets the affected stream; never skip an action and continue. Resync is a fresh authenticated state-only baseline. Delivery pressure must not block authoritative queues or undo committed gameplay.

## Proposed resource bounds

These are **initial validation candidates**, not proven heap ceilings or supported capacity:

- **Shared payload:**64MiB process-wide,8MiB/game,2MiB/publication; at most8 capture-active games. Cache conservative root weights including keys/strings/arrays and metadata. Charge each canonical root once while retained. Visit aliases once within a root; conservatively charge shared descendants again across distinct roots, avoiding a complex per-object accounting system. This is not physical-heap accounting.
- **Peer debt:** cache a publication's metadata plus distinct root weights once, rather than expanded JSON aliases. Sum those charges across each peer's queued/in-flight publications, even where adjacent publications share roots. Initially retain4MiB logical debt and64 jobs/peer; sharing does not itself prove this is adequate. Cap64 publications/game and2,048 handles globally. Keep32-message/256KiB outbound limits and2-second receipt timeout; propose a separately tested2-second queued-age cutoff.
- **Construction:** reserve a game/job slot and2MiB allowance before construction; initially one construction globally. Pending sources consume the same store budget. If source ownership cannot be bounded before asynchronous work, fail delivery admission. Freeze/size in bounded scheduled work, not an unbounded runtime callback. Keep construction overlap charged until temporary references disappear; finalize to cached root charges. Native/clone scratch remains separately measured headroom.
- **Lifetime:** pending, queued, active and invalidated-but-unsettled work occupies quotas until settlement. Final root-owner release removes its charge. An empty delivery store releases its game slot even if gameplay remains live. A ninth game's delivery is denied while eight slots are occupied—not its authoritative commands. Denied existing streams reset/disconnect.
- **Pressure/fairness:** within an overloaded game, disconnect the peer pinning the oldest queued capture first (stable peer-ID tie break). Do not evict unrelated healthy streams. Schedule ready games/peers round-robin. Bound authorization/projection preparations by spare DB pool capacity after writer leases and a control/recovery reserve, one/peer; release that shared slot after emission submission, **before receipt wait**, while retaining capture/output charges. This requires separating preparation from receipt lifetime, not wrapping existing `outbound.prepare` with a long-held semaphore.

Actual heap/native/RSS headroom requires measurement. Neither payload weights nor the rejected128MiB codec trial establishes a hard memory limit. Deployment admission/OS limits need a separate decision if a hard process ceiling is required.

## Migration and risks

Review small steps: immutable capture/registration contract; entry-level fanout/handles; canonical roots/accounting; real multi-match validation. Preserve DTOs, game/bot rules, persistence and full replay checks. Persistent maps/deltas require a later ADR.

Risks: mutation crossing viewers, registration races, incorrect same-head control deduplication, premature/double release, slow peers pinning history, expensive sizing/freezing, and host queue/authorization throughput remaining the bottleneck. Sharing reduces allocation; it does not guarantee delivery capacity.

## Acceptance criteria

- Raw capture allocation stops scaling with subscribers; proven roots are reused without lost replay data. Existing detached APIs retain isolation.
- Actions remain ordered or the peer explicitly resets. Registration, authorization/receipt cancellation, rollback, expiry/revocation, recovery and successor races release every reference exactly once. Hidden faces/repetition keys never enter wire/errors.
- Genuine mixed2/4/8 matches finish using production runners, including multiple deterministic8-seat seeds; Chromium replacement/handback passes. No trusted finishing or human driver acting for bots.
- Validate at least two concurrent8-seat matches, eight-game saturation/ninth-game denial/slot recovery, bursts, delayed authorization and withheld receipts. Report useful throughput, disconnects, starvation, queue age, unique roots, temporary allocation, CPU/event-loop and post-drain retention. Disconnecting everyone is not capacity success.
- Independent review and full database-enabled repository checks pass. Only the original10.9 criteria can close Stage10; this ADR cannot.
