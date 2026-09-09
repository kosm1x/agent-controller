# stuck-watchdog + early-exit promotion + literal-gate guard — R2 (independent 2nd pass), 2026-09-03

Bundle: uncommitted, 9 src files. Watchdog keys on `updated_at` + new `task.progress`
subscriber; `exitReason`/`unfinishedGoals` on OrchestratorResult; `completedWithConcerns`
widened to early exits; `isLiteralSourcedCheck` refuses echo/printf/true/false/: plan gates.

**Verdict: PASS-with-folds. 0 Critical, 4 High.**

## Doctrine crumbs (transferable)

- **A heartbeat is wired at the EMITTER, not the subscriber.** `PersistentEventBus.subscribe()`
  is served only by the private `broadcast()`, called from `emitEvent`/`emitRaw`. A plain
  `eventBus.emit(type, payload)` (EventEmitter passthrough via the `lib/event-bus.ts` facade)
  reaches `.on()` listeners and NOTHING registered by `subscribe()`. Two call styles for the
  same event name in one repo = a silently dead subscriber. Probe: init the real bus on
  `:memory:`, register both `subscribe` and `on`, fire each style, count. Do not trust the
  event NAME matching — trust the counter.
- **When a fix's payload arrives via a mocked bus, the fix is unpinned.** A test that mocks
  `getEventBus` and invokes the captured handler directly proves the handler's SQL and
  nothing about delivery. Every fail-open wiring point needs one real-bus test.
- **A liveness fix must be scored against the population that actually died.** `SELECT
  agent_type, count(*) … WHERE error LIKE 'Stuck task detected%'` returned fast|3 nanoclaw|1
  swarm|2. The fold covers only the 2 swarm rows; nanoclaw's timeout is an *inactivity* guard
  (wall-clock unbounded) and it emits `task.progress` exactly once, at spawn. Enumerate the
  kills, not the intent.
- **Promotion without a completion FLOOR + a parent that maps the promoted status to COMPLETED
  = collapse-to-green.** `completed > 0` is not a floor: 1-of-8 goals promotes, the dispatcher
  writes `progress=100`, and `syncSubTaskStatuses` maps `completed_with_concerns` →
  `GoalStatus.COMPLETED` unconditionally.
- **Promoting a timed-out child hands its UNFINISHED goals' gates to the parent's re-verify.**
  Plan gates are declared for ALL goals BEFORE execution; `reverifyChildLedger` runs with
  `rerun:true`, so gates for goals that never ran fail and demote the goal — re-creating the
  very failure the promotion was meant to remove. The `unfinishedGoals` list is the key that
  should ABANDON those gate ids; the bundle computes it and never uses it for this.
- **Dropping a bad gate is not the same as abandoning it.** `ledgerVerdict` returns `"none"`
  at `total === 0`, so silently deleting every literal-sourced gate of a goal deletes the
  verdict too. The module's own header promises "Surrender is visible."
- **A first-command anchor cannot express a tautology.** The real invariant behind
  `echo … | grep -q … && echo '<expect>'` is *the `expect` string is produced by a literal
  inside the check*, not *the check starts with echo*. Verified survivors:
  `test -z '' && echo 'X'`, `cd /tmp && echo x`, `(echo x)`, `{ echo x; }`, `bash -c 'echo x'`,
  `/bin/echo x`, `command echo x`. (`$(echo x)` is caught downstream by
  `validateShellCommand`'s command-substitution deny — check the downstream guard before
  scoring a regex FN as live.)
- **A pre-existing mislabel becomes load-bearing the moment a promotion reads it.**
  `exitReason` is `timeout` iff the AbortController fired, else `budget_exhausted` — but the
  loop also breaks on "replan threw" and "soft vote deferred, no work remains". Harmless as a
  snapshot label; a false operator sentence + a promotion trigger once it drives
  `completedWithConcerns`.
- **A guard added to one door only:** `isLiteralSourcedCheck` sits in `gateSpecsFromGoal`
  (planner door) and not in `parseGateSpecs` (API `POST /tasks` + ritual `gates` column door).
- **Verify "second copy" findings for liveness before ranking them.** `resume.ts` carries a
  second, un-updated copy of the promotion rule — but `resumeFromRun` has zero callers outside
  its own file, so it is DORMANT. Grep the caller before calling it High.

## Verified-clean (don't re-audit)

- 9 writers of `tasks.updated_at`; no SQLite trigger on `tasks`; 0/3178 rows have NULL
  `updated_at`. Checkout, the dispatcher fallback reset and `updateTaskStatus('running')` all
  set `started_at` + `updated_at` together ⇒ non-heartbeating runners keep exact
  15-min-from-start behavior. `fast` has no wall-clock bound of its own — the watchdog is its
  only ceiling, and it emits no progress, so it is unchanged.
- Readers immaterial: idle-detect window `-4 hours`; stalled-tasks / reflection scope 7 days;
  recurring-blockers reads terminal rows and the heartbeat is scoped `WHERE status='running'`.
- `tsc --noEmit` clean; 77/77 green in the 4 files I ran. `exitReason` const narrowing is
  sound (function scope, after the loop, `graph` not mutated before `finalSummary`).
