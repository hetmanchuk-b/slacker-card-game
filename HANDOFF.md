# Penky session handoff

## State and objective

- Branch: `main`. Implementation HEAD before this handoff: **`6d6398b`**; prior implementation commits were pushed.
- **Active objective:** finish shared-capture migration increment5 / original **Stage10.9 production acceptance**, pragmatically, without another transport redesign.
- **Stage10.9 is INCOMPLETE. Stage11 is untouched.** No validation, subagent or test process is currently running. All session-created disposable databases were removed.
- Read `AGENTS.md`, `README.md`, relevant `IMPLEMENTATION_PLAN.md` sections and approved specifications first. Some older status paragraphs predate the latest experiments summarized here.

## Completed work / authoritative documents

Stages1–9 are implemented within their documented verification boundaries; Stage9 automated Chromium coverage is not manual/native-device certification. Stage10.1–10.8 bot foundations/policies/lifecycle are implemented. D013 added a narrow permitted opening-right proof. See the plan for detailed scope and historical gates.

The approved [capture ADR](docs/transport-capture-adr.md) migration has completed increments1–4:

| Commit | Verified increment |
| --- | --- |
| `3ade561` | Additive transitively immutable committed-capture contract |
| `fff4e79` | One host owner / immutable fanout / peer references |
| `9b80324` | Provenance-checked roots, accounting, explicit handles |
| `6d6398b` | Scheduled construction, registration barriers, fair preparation, deadlines/resets |

Other anchors: `8036a63` original ADR; `81f8e70` D013 opening proof; `e505fe6` Stage10.8 lifecycle tests; `c5d010d` procedure policies; `157bb88` conservative play; `4f94431` dealing; `405c88b` runner; `e368914` durable memory.

References: [rules](docs/game-rules.md), [scenarios](docs/game-scenarios.md), [decisions D006–D013](docs/open-decisions.md), [architecture](docs/architecture.md), [runtime](docs/runtime.md), [host](docs/game-host.md), [transport](docs/transport.md), [PostgreSQL](docs/postgres.md), [coverage](docs/rule-test-matrix.md), [browser setup](docs/browser-client.md).

## Approved architecture and actual defaults

- Complete immutable captures are shared through entry-owned fanout; canonical roots require trusted writer/game/branch/version provenance **and content consistency**.
- New capture delivery may occur **after `dispatch()` resolves**. Registration must deliver a live, action-free baseline barrier; callers cannot substitute dispatch completion for capture completion.
- Rollback sidecars are captured synchronously at commit. Legacy runtime/host subscriptions retain synchronous detached behavior through a compatibility lane.
- One process-wide scheduled constructor; preparation rotates games/peers per DB pool and releases permits **before receipt waiting**. Cancellation retains active ownership until settlement. Queue deadlines rearm per packet.
- No compression, deltas or persistent-map redesign is authorized.

**Shipped defaults remain unchanged:**

| Bound | Current value / source |
| --- | --- |
| Source/publication and fixed pending reservation | **2MiB**, `src/runtime/capture-construction.ts` |
| Per-game / global store | **8 / 64MiB** |
| Capture-active games / publications per game / handles | **8 / 64 / 2,048** |
| Peer logical debt / jobs | **4MiB / 64**, `src/server/transport.ts` |
| Outbound | 32 packets / 256KiB; 64KiB prepared frame |
| Receipt / per-packet queued age | **2 seconds each**, separate technical clocks |

These are logical/resource admission bounds, **not heap ceilings**. Synchronous admission/equality and individual wide-object enumeration/freeze retain bounded residual event-loop cost. Repetition history grows with unique settled positions.

## Git status: preserve this work

Before adding this handoff, only these files were modified; nothing was staged:

- `src/server/external-match.postgres.test.ts` — **156 added lines**, genuine mixed2/4/8 drafts and four-line accepted-head synchronization. Human automation never sends gameplay for the disconnected bot seat.
- `tests/browser/presence.spec.ts` — **45 added lines**, actual bot dealing and human handback.

Both are inherited acceptance drafts, deliberately uncommitted. Do not discard them. Temporary instrumentation/configuration changes were restored byte-for-byte; production code has no uncommitted changes. `HANDOFF.md` is the only new handoff deliverable.

## Verified results and current blockers

### Committed increment4 regression baseline

Final normal `npm run check`: **556 pass / nine explicit DB skips**. PostgreSQL-enabled gate: **772 pass / no skips**, including format/lint/types/build. **Those gates temporarily excluded the two unfinished drafts and restored them afterward.** They do not prove the current acceptance drafts pass.

Independent review fixed registration/owner/sidecar races and per-packet deadline rearming. Existing genuine8-human regression passed. An intermittent host corruption-cleanup assertion observed backend count1 instead of0; isolated/final reruns passed unchanged. Earlier failures/timeouts are recorded in the plan; do not weaken assertions or reclassify failures as passes.

### Real runner acceptance with default limits

- Genuine human2/4/8 and mixed2/4 matches passed.
- Mixed8 repeatedly disconnected seven healthy humans at v213: active+queued debt3,577,676B plus incoming1,802,636B = **5,380,312B >4MiB**.
- Pins were under184ms; latest receipt0.84ms; max preparation queue0.30ms. No demonstrated source/projection failure or preparation starvation.
- Chromium presence/runner/handback **3/3**, host PostgreSQL **42/42**, transport **115/115** passed. This is focused evidence, not full acceptance.

### Approved test-only peer8MiB experiment

One actual deterministic mixed8 match passed in **28.78s**; default RNG always returned `upper-1`.

- Peer high-water **5,836,924B / three jobs**; store **6,055,614B**.
- 238 distinct captures delivered to every human, ~9.50/s; no unexpected disconnects/gaps.
- Event-loop p99/max43.91/63.34ms; sampled RSS83.5→338.7→302.2MB after cleanup.
- Functional all-human state barriers apply: **not open-loop/concurrent capacity evidence**. Production defaults were restored afterward.

### Broader test-only peer8MiB validation: stopped at first new seed

Xorshift32 **seed1**, injected into actual host randomness, failed at **v237 /196 repetition positions**:

- Source admission **2,100,526B >2,097,152B**, excess3,374B. This happens **before construction/canonical finalization**.
- Peer high-water4,107,080B; no peer overflow/queue expiry. All seven healthy streams failed closed through owner reporting.
-233 captures/human delivered before failure, ~9.35/s. Max packet waiting115ms; max pin200ms; store high-water5,233,102B.
- Sampled RSS98.7→342.0MB. After harness release/drain heap was70.0MB; **one labeled diagnostic GC outside workload** reduced heap to16.5MB versus18.4MB baseline, while RSS remained170.6MB. **No proven leak; no repeated-workload stability proof.**

Seeds7/42/314159/3737844653, ten same-live-server matches, concurrent8, offered-load/slow-peer and saturation phases are **UNRUN**. Full repository gates were not rerun for these stopped experiments.

Metadata reports and reversible reproduction scripts, local-only and potentially subject to temp cleanup:

- `C:/Users/Павел/AppData/Local/Temp/penky-production-acceptance-report.json`
- `C:/Users/Павел/AppData/Local/Temp/penky-peer-debt-experiment-report.json` and `.py`
- `C:/Users/Павел/AppData/Local/Temp/penky-peer-debt-validation-report.json` and `.py`

Reports distinguish parent test counts from actual named matches. Wrappers propagate Node failures and restore temporary edits in `finally`. Inspect paths/config before reuse; scripts require sole-writer execution and an explicit disposable DB. No raw captures/credentials were persisted.

## Rejected / deferred approaches

- Compression under old ownership: good ratios, but no strict allocation proof; alternative scheduler trials lost work/starved slow peers and skipped failed jobs, violating production no-gap semantics. Investigation closed; do not restart it.
- Slimming replay states or dropping repetition data: loses complete replay/integrity inputs; forbidden.
- Isolated quota increases: peer8MiB cleared one failure but exposed source2MiB; evaluate a coupled package instead.
- Deltas, persistent maps and further transport redesign: deferred complexity, not needed for the proposed configuration-first MVP path; require separate approval.

## Latest read-only diagnosis — proposal, NOT approval

No accounting leak was demonstrated. Source weights conservatively size a graph; canonical debt sums distinct roots plus metadata; retained-store charges reuse roots. They are different logical measures. One publication constant also controls source admission and **full-maximum pending reservations**, which overlap live roots/finalization. Raising only one limit is insufficient; store overrides alone do not bypass module-default source checks.

Rough existing-evidence extrapolation for typical one-action sources:250 positions≈2.6MiB;500≈5.1MiB;750≈7.7MiB;1,000≈10.2MiB. **Not bounds or measured distributions**; identifiers, phase and multiple actions change size. Short-ID synthetic profiles underestimate production UUID cases.

**Latest recommendation, independently reviewed as a validation candidate only:** evaluate together **8MiB source/publication,32MiB peer debt,32MiB/game,256MiB/global**; keep counts, wire limits, deadlines and pool headroom unchanged. This is constants/configuration work, not a redesign. Full reservations mean four allowances do not guarantee four admitted publications.8MiB does not promise1,000-position matches;256MiB is not a physical process limit.

**The user has NOT approved implementing or testing this package. Exact next action: obtain approval for this coherent bounded configuration/envelope, then validate it together—not progressively raise isolated limits.** Do not change production defaults on a bare assumption that the proposal was approved.

## Remaining mandatory acceptance / minimal route

After quota approval: complete genuine runner mixed2/4/8 matches and five actual deterministic8-seat seeds; ten sequential matches on the **same live host/transport process**; two genuinely concurrent8 matches; long-match growth; slow-peer isolation, delayed auth/receipts, saturation/ninth denial/recovery; handback/no-human pause, rollback/recovery/successor and privacy; Chromium; independent review; full DB-enabled gates; docs and verified commit/push.

Measure useful per-peer/game throughput, resets/starvation, queue age/pins, retained captures, CPU/event-loop and post-drain heap/external/RSS. Do not mistake ACK counts, zero counters, forced GC or dropped work for capacity. Eight simultaneous *long-game* soak/fleet certification can be optional prelaunch work, but **existing requested acceptance cannot silently be waived**. No additional architecture/experimentation is the default next step.

## Commands and invariants

Node24+ and npm; last environment Windows/Node26.13.1. Git Bash examples; start Docker Desktop if needed:

```sh
npm run db:test:up
export PENKY_TEST_DATABASE_URL='postgresql://postgres:penky-local-test@127.0.0.1:55432/penky_test'
node --test src/server/external-match.postgres.test.ts
node --test src/server/game-host.postgres.test.ts src/server/transport.postgres.test.ts
npm run test:browser -- tests/browser/presence.spec.ts
npm run check
npm run test:postgres
npm run db:test:down
```

Use **only a disposable `_test` database**: tests inject failures/corrupt frames/terminate writers. Do not run competing mutating suites against one DB. The current mixed8 draft is expected to fail at shipped defaults; full gates must report that honestly. Do not exclude drafts silently. Experimental scripts need their documented environment/seed/override; changing DB env alone does not enable proposed quotas. Chromium provisioning: `npx playwright install chromium` if absent.

Preserve complete deterministic replay inputs, viewer-specific redaction and opaque IDs. Authenticate seat/owner/controller server-side; never feed authority/history to policies or send bot commands from the human driver. Keep post-commit publication, exact registration barriers, synchronous rollback sidecars, branch/epoch/expiry/revocation checks, per-peer order and explicit reset on overflow—**no silent gaps**. Cancellation is not settlement; retain active reservations until actual release. Preserve nested timers, fixed N, no-human suspension, legacy API contracts and idempotent receipts.

No compression, deltas, persistent data structures, speculative optimizations or unrelated refactoring. No Stage11 or revision1.4/minigame implementation. Stage10.9 closes only after its acceptance passes, not after quota approval or one successful match.
