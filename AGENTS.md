# Penky — Agent Instructions

These instructions apply to AI coding agents working in this repository, including Pi and its subagents. Follow them alongside the task request. Keep this file short and operational; do not duplicate the product specification or implementation plan here.

## 1. Read before changing code

- Start with `README.md` and the relevant sections of `IMPLEMENTATION_PLAN.md`.
- Consult `docs/game-rules.md` and `docs/game-scenarios.md` for approved gameplay behavior; use `docs/architecture.md` for module boundaries and design decisions.
- Consult the relevant specialized documentation (`docs/runtime.md`, `docs/history.md`, `docs/postgres.md`, `docs/rule-test-matrix.md`, `docs/open-decisions.md`) when changing those areas.
- Inspect the existing implementation, types, tests, and callers before proposing or editing an interface. Verify facts in files rather than assuming a module, feature, command, or dependency exists.
- The implementation plan is a progress tracker, not permission to invent unresolved gameplay rules. If documents conflict, identify the conflict and request a decision before implementing affected behavior.

## 2. Scope and execution

- Work on one small, dependency-ready increment at a time. Prefer a coherent vertical slice with observable acceptance criteria over a large, speculative refactor.
- Before substantial edits, briefly state the goal, touched modules, risks, and verification plan. Ask for approval before changing gameplay rules, significant architecture, public contracts, persistence formats, or adding major dependencies.
- Preserve the current implementation and public contracts unless a task explicitly requires changes. Do not introduce unrelated refactoring, new frameworks, microservices, account systems, or speculative abstractions.
- Follow the dependency order and exit criteria in `IMPLEMENTATION_PLAN.md`. Do not implement polished Three.js gameplay before the equivalent functional multiplayer interaction works.
- Do not silently expand scope or mark a stage complete because only unit tests pass.

## 3. Architectural invariants

- **Engine:** Keep `src/game` deterministic and independent of sockets, databases, UI, system time, and fresh random calls during replay. Decisions use injected time/randomness; accepted actions record all resulting events and random outcomes. A rejected malformed/unauthorized command is different from an accepted, punishable in-game violation.
- **Runtime:** Serialize commands, timeouts, connection effects, claims, penalties, and rollback per game. Preserve nested timer suspension, remaining time, idempotent receipts, version checks, and atomic action boundaries.
- **Persistence:** Commit authoritative state, event/history data, receipts, branches, and relevant runtime metadata atomically before acknowledging or publishing accepted changes. Preserve deterministic replay, recovery, branch invalidation, and rollback audit. PostgreSQL is accessed through the existing `pg`/SQL design; do not add an ORM without explicit approval.
- **Privacy:** Raw authoritative state, event logs, history snapshots, private observations, and card faces are never generic client or bot payloads. Build viewer-specific projections; keep hidden card IDs opaque and unrelated to faces. Apply the same redaction to errors, history, resync, and reconnect flows.
- **Transport and identity:** Authenticate session-to-seat/owner binding on the server. Never trust client-supplied actor or owner identities; validate external payloads and evidence references against server-owned history. Retries must be idempotent and obsolete-branch commands invalidated without suppressing intentional, punishable out-of-turn play.
- **Client and bots:** The server remains authoritative for rules, randomness, and timers. UI may permit specified rule-breaking attempts rather than disabling them all. Bots only receive observations permitted to their seat, never full internal state. Clear stale UI interactions/animations after rollback or resync.

## 4. Tests and verification

- Use test-first development for gameplay behavior and regressions: add a failing test, implement the smallest complete change, then refactor.
- Test public module interfaces and observable behavior rather than internal helper call sequences. Include invalid inputs, privacy boundaries, duplicate delivery, reconnect/recovery, timer edge cases, and rollback when relevant.
- Use Node.js 24+ and npm. Relevant commands:
  - `npm test` — non-database Node tests.
  - `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` — focused checks.
  - `npm run check` — repository-wide format/lint/types/tests/build gate.
  - `npm run test:postgres` — real PostgreSQL integration suite; requires a **disposable** configured test database (`PENKY_TEST_DATABASE_URL`). See `docs/postgres.md`.
- The PostgreSQL suite can inject failures. **Never run it against a shared, production, or otherwise valuable database.** Never run destructive database commands without confirming the target is disposable.
- Distinguish executed checks from skipped, unavailable, or unrun checks. Never claim browser, transport, or real-database verification based on mocks or a successful build alone.

## 5. Subagents and parallel work

- The main agent owns planning, integration, and the final result. Use subagents when they improve isolation or independent judgment, not automatically on every task.
- For nontrivial changes, use a read-only Scout to inspect relevant code, a Planner when dependencies or architecture are unclear, and an independent read-only Reviewer after implementation. A test-focused agent may identify missing cases.
- Give each subagent a bounded question, relevant paths, constraints, and expected output. Ask research/review agents to cite file paths and concrete evidence.
- Do not have multiple write-capable agents edit the same files or shared state concurrently. Parallelize read-only investigation/review or truly independent work in isolated branches/worktrees; integrate and test centrally.
- Validate findings before acting on them. Do not turn speculative reviewer suggestions into unrequested redesigns or repeat endless review/fix cycles.

## 6. Documentation and handoff

- After verified changes, update only the documentation materially affected: the appropriate status/checklist in `IMPLEMENTATION_PLAN.md`, rule-to-test coverage, and architecture or operations docs when behavior/contracts actually change.
- Record unresolved gameplay questions in the existing decision workflow; do not silently fill gaps. Revision 1.4's post-game minigame and repetition-result changes remain subject to their documented decisions and stage dependencies.
- After completing and verifying each increment, commit its changes and push to the configured upstream branch. Include the materially affected documentation; do not include unrelated changes. Report the commit ID and push result. If verification or push is blocked, report the blocker rather than claiming completion; never force-push without explicit approval.
- At the end of each increment report: implemented behavior, changed files, tests/checks actually run (including skips), unresolved risks, and the next dependency-ready increment.
- If blocked, stop at a safe boundary and explain what is verified and exactly what decision or environment is needed. Do not mask uncertainty with confident claims.
