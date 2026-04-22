## Dimension 4 — Resilience audit

> **Status**: COMPLETE — 2 rounds run (Round 1 direct audit + Round 2 independent qa-auditor agent pass). 2 Critical + 1 Major landed as round-1 fixes; Round 2 found **3 additional Criticals + 1 Major the round-1 fixes introduced or missed** — all landed as round-2 fixes. 4 Warnings deferred with explicit triggers. 0 Critical findings remain.
> **Baseline**: `../benchmarks/2026-04-22-baseline.md`
> **Methodology**: `../planning/stabilization/full-system-audit.md` (double-audit required for Resilience)
> **Post-fix commits**: see Commits section below.
>
> **Headline**: Round 1 closed 2 Criticals (SDK circuit breaker missing, no startup reconcile of orphaned tasks) + 1 Major (static ritual failures not recorded). Round 2 (independent qa-auditor pass against the round-1 fixes) found **3 additional Criticals** — Prometheus fan-out spuriously escalating breaker-OPEN errors, `recordRitualFailure` swallowing all errors via a bare `catch {}`, and `reconcileOrphanedTasks` silently flipping user-facing tasks with no `task.failed` event emitted → no retry, no user notification. Plus 1 Major (inverted `providerOutcome` default that turned "no signal" into "success"). Pattern confirmed for the second audit in a row: **single-round audits of high-blast-radius dimensions ship new bugs with the fixes**. The double-audit protocol is load-bearing for Resilience just as it was for Security.

---

## Summary

| Probe | Round-1 severity | Round-2 severity     | Decision                                                                                                                                                               |
| ----- | ---------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1    | Pass             | -                    | Pass: openai-adapter path has multi-provider fallback + circuit breaker + exponential backoff on 429/5xx. Well-designed.                                               |
| R2    | **Critical × 1** | **Critical × 1** new | Fix: circuitRegistry.get("claude-sdk") wired into queryClaudeSdk; round 2 then found fan-out escalation — retry classifier fix.                                        |
| R3    | **Critical × 1** | **Critical × 1** new | Fix: reconcileOrphanedTasks at boot; round 2 found silent-flip — return IDs + emit task.failed events.                                                                 |
| R4    | Pass             | -                    | Pass: WAL mode + wal_checkpoint(PASSIVE) on shutdown + periodic every-100-writes checkpoint. Hot-copy integrity_check=ok.                                              |
| R5    | Major            | **Critical × 1** new | Fix: schedule.run_failed events from all 7 ritual failure paths; round 2 found bare-catch silently swallowed programming bugs — narrow catch with console passthrough. |
| R6    | Pass             | -                    | Pass: dual-write to SQLite first, own circuit breaker (3/60s), SQLite fallback on recall failure, 4×3s Hindsight health retry at boot.                                 |
| R7    | Pass             | -                    | Pass: NorthStar sync has reentrancy guard, journal-based LWW with bootstrap-vs-subsequent distinction, collision-proof paths.                                          |
| R8    | Warning          | -                    | Defer: stale-artifact-prune ritual already handles `status=exited` containers >6h; running orphans from parent crash unaddressed (W-RES-5 trigger).                    |
| R9    | Pass             | -                    | Pass: `isAnyWindowExceeded` gate in dispatcher before every new task; hourly/daily/monthly windows + `blocked` status.                                                 |
| R10   | Pass             | -                    | Pass: `MAX_RESTART_ATTEMPTS=5` with backoff 5-30s; `restartScheduled` + `shuttingDown` guards prevent double-count + shutdown log noise.                               |

**Bonus round-2 Major**: `providerOutcome === null` defaulted to success on claude-sdk breaker classification — under-reported outages to the breaker.

Severity: Critical (ship-blocker, landed) / Major (P0, landed or deferred-with-trigger) / Warning (P1/P2, documented) / Info (no action).

---

## Round 1 — Findings

### C-RES-1 (Critical) — Claude SDK path has zero circuit-breaker integration

**Evidence**: `src/lib/circuit-breaker.ts:148` exports `circuitRegistry`. The only caller was `src/inference/adapter.ts:770` (openai path). `src/inference/claude-sdk.ts` had zero `circuitRegistry` calls.

**Impact**: Since `INFERENCE_PRIMARY_PROVIDER=claude-sdk` went primary on 2026-04-22, every Sonnet failure burned the full `SDK_TIMEOUT_MS=15min` before giving up. N consecutive Sonnet 500s multiplied that — 5 failures in a row = up to 75 minutes of blocking. The shared breaker never saw the signal, so openai fallback decisions couldn't factor in Sonnet health either. Matches `feedback_incomplete_migration.md`: "X is now primary" touching one file = partial migration.

**Fix**: `src/inference/claude-sdk.ts` — imported `circuitRegistry`, added `breaker.allowRequest()` guard at `queryClaudeSdk` entry (throws `"Circuit breaker OPEN"` if refused), tri-state `providerOutcome` ('success' | 'failure' | null) tracked through the for-await loop, `recordSuccess()` / `recordFailure()` called after `clearTimeout`. Partial content with terminal-error subtype = success (the model was responsive until SDK-internal limit hit). Zero-content + timeout / no-signal = failure.

### C-RES-3 (Critical) — No startup reconciliation of orphaned tasks

**Evidence**: `src/index.ts:254-267` graceful-shutdown handler marks `running`/`pending`/`queued` → `failed`. `src/reactions/manager.ts:277-309` polls for stuck `running` tasks > 15min. But on SIGKILL / OOM / hard-reboot: the graceful handler never fires, and the stuck-task poll only catches `running` rows with `started_at` set — `pending`/`queued` rows (queued-before-dispatch, or dispatched-but-pre-started) never had `started_at` assigned and slip past the 15-min check forever.

**Impact**: A production SIGKILL (OOM) leaves every interactive user task in a permanent limbo status. User asked a question, got silence, and will continue to get silence because nothing will retry or notify.

**Fix**: New `reconcileOrphanedTasks()` in `src/db/index.ts` called from `src/index.ts` `main()` immediately after `initDatabase()`. Idempotent. Error message preserves original status string (`'Orphaned across non-graceful restart — task was X when service died'`) so forensic triage distinguishes mid-run deaths from queued-when-killed cases. (Round-2 C-RES-6 later expanded this to return IDs + emit events.)

### M-RES-1 (Major) — Static rituals log failures to console only

**Evidence**: `src/rituals/scheduler.ts:127,267,291,392,452,476` — every ritual failure path is `console.error(...)`. Methodology success criterion: "Scheduled task failures produce an `events` row with category=`schedule_run` + type=`failed`". Dynamic scheduler (`src/rituals/dynamic.ts`) has `schedule_runs` table — but static rituals (morning-briefing, nightly-close, market-\*, kb-backup, memory-consolidation, diff-digest, stale-artifact-prune, autonomous-improvement) emit nothing durable.

**Impact**: No way to observe ritual outages without live-tailing journalctl. Can't query "how often did nightly-close fail in the last 7d?" Can't wire reaction rules to auto-escalate persistent ritual failure.

**Fix**: New `ScheduleEventType = "schedule.run_failed"` + `ScheduleRunFailedPayload { ritual_id, error, phase }` in `src/lib/events/types.ts` (new `"schedule"` category). Helper `recordRitualFailure(ritualId, err, phase)` in `src/rituals/scheduler.ts` wired into all 7 ritual catch blocks. Category auto-derives from the first dot-segment, so `category=schedule`.

---

## Round 2 — Findings (independent qa-auditor pass)

Round 2 was performed by the `qa-auditor` subagent on the round-1 fixes. These were **missed by round 1** or **introduced by the round-1 fixes themselves**.

### C-RES-4 (Critical) — Prometheus fan-out spuriously escalates Circuit-breaker-OPEN errors

**Evidence**: `src/prometheus/executor.ts:564` (`executeGraph` uses `Promise.allSettled(ready.map(g => executeGoal(...)))`). When the claude-sdk breaker is HALF_OPEN, `allowRequest()` returns `true` for exactly one probe and `false` for every concurrent call (see `CircuitBreaker.allowRequest()` at `src/lib/circuit-breaker.ts:48-62`). With 3+ ready goals fanning out, one wins; the rest throw `"[claude-sdk] Circuit breaker OPEN — refusing call until cooldown elapses"`. Executor's `classifyError` at `executor.ts:60-70` checks only `TRANSIENT_PATTERNS = ["timeout","timed out","rate limit","429","503","connection reset","connection refused","eagain"]` — **"circuit breaker" matches none**. The error escalates to permanent fail after 3 retries with 2-8s exponential backoff — all well inside the 30s cooldown window.

**Impact**: Normal breaker-recovery pattern (one probe succeeds → CLOSED → next call works) becomes a partial-task-fail: 1 goal succeeds, N-1 goals spuriously escalate. Orchestrator replans or marks the task failed. The breaker's core value — short-circuiting while the provider recovers — is inverted into cascading failure for every Prometheus task during the recovery window.

**Fix**: `src/prometheus/executor.ts` — added `"circuit breaker"` to `TRANSIENT_PATTERNS` and `BREAKER_OPEN_TOKEN = "circuit breaker open"` constant. When an error matches the breaker token, retry backoff is `CB_COOLDOWN_MS + random(0, 5000)` (30-35s jitter) instead of the 2-8s exponential — matches the breaker's own cooldown so the next retry finds HALF_OPEN at worst, CLOSED at best.

### C-RES-5 (Critical) — `recordRitualFailure` bare `catch {}` swallows all errors

**Evidence**: Round-1 fix added a bare `try { ... } catch {}` around `getEventBus().emitEvent(...)` to tolerate boot-time event-bus-not-initialized race. The bare catch swallows **TypeError, ReferenceError, SQLITE_MISUSE, payload-shape-mismatch**, and any future programming bug in the emit path. If `emitEvent`'s payload contract changes and starts requiring a new field, every ritual failure drops silently — the enforcement gate becomes theater with no observability.

**Impact**: Same class as the F9 `feedback_f9_rituals.md` "enforcement mechanisms ship with dead-wiring bugs every time" pattern. The landed round-1 fix could itself be broken without anyone knowing.

**Fix**: Replaced bare catch with `catch (busErr) { console.error("[rituals] recordRitualFailure: event bus unavailable (${busMsg}) — original error: ${message}") }` — still non-fatal (ritual already failed; bus failure shouldn't crash the cron callback) but bus breaks are now visible in journalctl for diagnosis.

### C-RES-6 (Critical) — `reconcileOrphanedTasks` silently flips rows with no event emission

**Evidence**: Round-1 fix returned a count (reconciled.changes) and logged to `log.warn`. Nothing else. `src/reactions/manager.ts:61` subscribes to `task.failed` events on start — but the reconcile's raw SQL UPDATE doesn't route through the event bus. Result: orphaned user-facing interactive tasks get flipped to `status='failed'` with error="Orphaned..." and **no downstream signal**. Reactions engine can't retry (it never saw a task.failed event). User got no response when the task died and gets no response now.

**Impact**: Regression from the pre-fix state. Before: rows stuck as `running` forever — bad, but at least the stuck-task poll might eventually notice. After round-1 fix: rows pre-flipped to `failed`, stuck-task poll skips them (wrong status), nothing in the reaction/notification pipeline fires. User experience: silent task loss.

**Fix**: Changed `reconcileOrphanedTasks()` to return `string[]` (the list of orphaned task IDs) in a single transaction — SELECT IDs + UPDATE atomically. `src/index.ts` `main()` captures the list, initializes the event bus (unchanged line ordering), then iterates and emits `task.failed` events with `agent_id="startup-reconcile"`, `recoverable: true`. Events fire before `new ReactionManager(db).start()`, so the reaction subscription picks them up when it drains the event bus on subscribe. Non-chat tasks go through the normal retry/notify paths; chat tasks are filtered at `reactions/manager.ts:102-108` (pre-existing behavior — user can re-ask).

### M-RES-4 (Major) — `providerOutcome === null` defaulted to recordSuccess

**Evidence**: Round-1 fix ended with `if (providerOutcome === "failure") breaker.recordFailure(); else breaker.recordSuccess();`. The code comment said "explicit decision beats maybe success by default" but the ternary did the opposite: `null` (no signal ever fired — SDK subprocess died mid-stream, iterator closed without emitting a terminal message, etc.) defaulted to **success**.

**Impact**: Breaker under-reports failures. If Claude Code subprocess crashes silently (SIGPIPE, exits without terminal), breaker records success despite zero content returned — the very kind of silent outage the breaker is supposed to protect against.

**Fix**: Inverted ternary to `if (providerOutcome === "success") recordSuccess(); else recordFailure();`. `null` now conservatively trips the failure counter, matching the fix's stated intent.

---

## Deferred follow-ups with explicit triggers

| ID      | Title                                                                                                  | Trigger                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| M-RES-2 | SDK credentials expiry not surfaced as a distinct alert — generic STATUS line only                     | Anthropic credentials incident or user-reported silent-failure after creds rotation                |
| M-RES-3 | Running orphan `mc-*` containers not reaped on startup (only `status=exited` handled by hourly ritual) | Next nanoclaw or heavy-runner incident where parent-killed container kept running 30+ min          |
| W-RES-1 | `schedule_runs.status` stays 'running' forever for watched rituals that fail mid-task                  | If scheduling/reporting dashboard needs correct status values for alerting                         |
| W-RES-2 | Telegram 5-restart cap exhaustion emits only `console.error`, no events row, no WhatsApp fallback      | First prod incident where Telegram actually hits the cap — currently theoretical                   |
| W-RES-3 | `prometheus_snapshots` rows not cleared when orphaned task reconciled → stale-resume risk              | If any operator ever re-dispatches an orphaned heavy task_id (rare; would need explicit re-submit) |
| W-RES-4 | `/health.circuitBreakers` doesn't surface cooldownRemainingMs                                          | Operator dashboard lands (planned outside this audit window)                                       |
| W-RES-5 | Orphan-container reaper at startup (stale-artifact-prune only covers `status=exited`)                  | Related to M-RES-3; promote together                                                               |

---

## Fixes landed this audit

| Round | #   | File                                      | Change                                                                                                   |
| ----- | --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| R1    | 1   | `src/inference/claude-sdk.ts`             | Wire circuitRegistry — allowRequest guard + tri-state providerOutcome + record success/failure (C-RES-1) |
| R1    | 2   | `src/db/index.ts`                         | New `reconcileOrphanedTasks()` (C-RES-3)                                                                 |
| R1    | 3   | `src/index.ts`                            | Call reconcile at startup after initDatabase (C-RES-3)                                                   |
| R1    | 4   | `src/lib/events/types.ts`                 | New `"schedule"` category + `"schedule.run_failed"` type + `ScheduleRunFailedPayload` (M-RES-1)          |
| R1    | 5   | `src/rituals/scheduler.ts`                | Helper `recordRitualFailure()` + wired into 7 ritual catch blocks (M-RES-1)                              |
| R1    | 6   | `src/inference/claude-sdk.test.ts`        | 3 new regression tests (breaker trips, partial-content = success, successful completion resets)          |
| R1    | 7   | `src/db/reconcile-orphaned-tasks.test.ts` | 3 new regression tests (reconcile marks + leaves terminals alone + idempotent)                           |
| R1    | 8   | `src/rituals/scheduler.test.ts`           | 2 new regression tests (emits schedule.run_failed on submit throw, not on success)                       |
| R2    | 9   | `src/prometheus/executor.ts`              | Add "circuit breaker" to TRANSIENT_PATTERNS + CB_COOLDOWN_MS-sized backoff for breaker errors (C-RES-4)  |
| R2    | 10  | `src/rituals/scheduler.ts`                | Narrow recordRitualFailure catch with console passthrough (C-RES-5)                                      |
| R2    | 11  | `src/db/index.ts`                         | reconcileOrphanedTasks returns `string[]` via atomic transaction (C-RES-6)                               |
| R2    | 12  | `src/index.ts`                            | Emit `task.failed` events for orphaned tasks after initEventBus (C-RES-6)                                |
| R2    | 13  | `src/inference/claude-sdk.ts`             | Invert providerOutcome default: null → failure (M-RES-4)                                                 |
| R2    | 14  | `src/prometheus/executor.test.ts`         | Regression guard: breaker-OPEN retry succeeds after cooldown (C-RES-4)                                   |
| R2    | 15  | `src/db/reconcile-orphaned-tasks.test.ts` | Updated tests for new ID-returning shape (C-RES-6)                                                       |

**Tests**: 3721 → 3730 pass (+9 regression guards: 3 breaker + 3 reconcile + 2 ritual-failure + 1 breaker-aware retry). Typecheck clean.

**Live verifications**:

- **R4 WAL integrity**: hot-copy of running DB + WAL sidecar → `PRAGMA integrity_check` returns `ok`, `journal_mode=wal`, 2877 tasks + 4608 conversations intact. Better-sqlite3's WAL mode is crash-safe by design.
- **R3 + C-RES-6 live**: injected `SMOKE-R3-ORPHAN-1` row with `status='pending'` while service stopped → restart → service reconciled the row to `status='failed'` with error `"Orphaned across non-graceful restart — task was pending when service died"` + `[mc] "reconciled orphaned tasks" count=1` log line + `task.failed` event persisted in events table with the exact task_id. End-to-end wired.
- **R2 breaker**: 3 regression tests assert trip after CB_FAILURE_THRESHOLD=5 failures, partial-content-then-error doesn't count as failure, normal completion resets counter. `/health.circuitBreakers` wires lazily (first call registers) — same as openai path.
- **R5 events**: regression test asserts `schedule.run_failed` emitted with `phase=submit` + error when `submitTask` throws; asserts no emission on success.

---

## Key patterns captured

1. **Double-audit is load-bearing for Resilience too, not just Security.** Round 1 closed 2 Criticals + 1 Major. Round 2 found 3 additional Criticals (one of which — C-RES-5 — was introduced by the round-1 fix's bare-catch) + 1 Major (M-RES-4, inverted default in the round-1 code despite an explicit comment saying otherwise). For the SECOND audit in a row, round-2 findings on a "done" fix outnumber the originals. Methodology stands: Security + Resilience both get double-audit discipline.

2. **The round-1 fix is a moving target round 2 must audit.** Round 2's C-RES-5 (bare catch) and M-RES-4 (inverted default) are bugs **in the round-1 fixes themselves**. Round-2 auditors should not just look for "what round 1 missed" but "what round 1 introduced." This is a deeper auditing frame than security round 2 applied (which found adjacent bugs on untouched tools) — here it's bugs inside the landed code.

3. **Breaker-OPEN is a transient error class, not a permanent one.** The Prometheus executor's retry classifier was built around provider-level errors (timeout, 429, connection reset) and didn't know about breaker errors. When the breaker became a first-class signal on the SDK path (C-RES-1 fix), the downstream retry classifier had to learn that signal too — otherwise fan-out goals escalate spuriously during recovery. Any new error class a subsystem introduces needs a grep across every retry/classify/handle-error site.

4. **Silent-flip after SQL update ≠ fixed.** Round-1's reconcile flipped rows but emitted no events — which for DB-state-only changes is fine, but for state changes that have downstream consumers (reactions engine, user notifications, metrics) it's a silent-drop pattern. Rule of thumb: any UPDATE that changes task status in-place must also fire the corresponding lifecycle event so subscribers pick it up.

5. **Bare `catch {}` is enforcement theater.** The enforcement gate's failure mode matters as much as its success mode. A bare catch absorbs the gate's own bugs AND the genuine startup race it's there to tolerate — leaving no way to distinguish. Narrow catches with passthrough logs preserve tolerance while keeping the gate diagnosable. Pattern matches `feedback_f9_rituals.md`'s "enforcement mechanisms ship with dead-wiring bugs every time."

6. **Null-state defaults should be conservative.** `providerOutcome` tri-state handles the legitimate unknown-state case (loop exited without a signal) — but the default for unknown must match the failure direction, not the success direction. For breakers, under-reporting failures is structurally worse than over-reporting. Same applies to classifier, retry, and alert gates: when the code path "never decides," treat it as the problematic outcome, not the benign one.

7. **`circuitRegistry` is a process-wide shared singleton** — one breaker name per provider/service key. Two callers using the same name share failure state, which is what we want (fast-runner SDK call + Prometheus SDK call both trip the same "claude-sdk" breaker). But the HALF_OPEN-only-one-probe semantics mean that concurrent callers on the same breaker need retry awareness — see pattern 3. A redesign to CAS-based probe slotting would improve fairness but is deferred (architectural, not mechanical).

---

## Closing criteria

- [x] All 10 probes produced evidence-backed findings
- [x] 0 Critical findings remain — 2 round-1 + 3 round-2 = 5 fixed
- [x] 1 Major landed at round 1 (M-RES-1) + 1 Major landed at round 2 (M-RES-4)
- [x] Double-audit round completed — independent qa-auditor agent
- [x] All "fail-loud" paths documented; silent fallbacks eliminated on critical routing (SDK breaker, ritual failures, orphan reconcile now all emit events)
- [x] WAL integrity verified survives hot-copy (equivalent to SIGKILL recovery path)
- [x] Scheduled task failures produce `events` row with `category=schedule` + type=`failed` (method-specified criterion met)
- [x] Tests pass 3730 + typecheck zero errors (+9 regression guards)
- [x] Live-fire verification: R3 reconcile end-to-end, R4 integrity, R5 event emission, R2 breaker unit-tested
- [x] 7 deferred items have explicit promotion triggers

---

## Commits

Two-commit bundle on main:

1. `fix(audit): Dim-4 Resilience round 1 — SDK breaker + orphan reconcile + ritual failure events` (landed before round 2 audit)
2. `fix(audit): Dim-4 Resilience round 2 — fan-out breaker awareness + silent-flip notifications + narrow catch + inverted default` (landed after round 2 audit)
