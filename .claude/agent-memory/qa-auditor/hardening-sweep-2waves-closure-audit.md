# Hardening sweep Wave 1+2 CROSS-AGENT closure audit (34fbb4f + bed561f, 2026-07-05)

9-lane disjoint-file hardening bundle (~2.8k+/−1k, 47 files). Per-lane gates green.
Cross-seam audit verdict: PASS WITH WARNINGS. 0 CRITICAL, 2 WARNING, 4 INFO.

## Seams that were CLEAN (traced, state once)
- **Budget default flow (Seam 2)**: health `hourly.limit` = `config.budgetHourlyLimitUsd`
  via getThreeWindowStatus (service.ts:202); mc_budget_* gauges SET (prometheus.ts:396-404),
  not just declared. Raised 2→20 / 10→50 genuinely de-fangs watchdog 9a.
- **provider-metrics × phantom-$0 (Seam 3)**: `providerMetrics.record` fires exactly ONCE
  (linear flow after the try/catch, no early return between query start and the call,
  claude-sdk.ts:~800). `isPhantomZeroCostRow` CANNOT skip a legit $0: first clause
  `!result.success` excludes ALL successes; Max-auth sets `actualCostUsd=0` (defined, not
  undefined) via `costAuthoritative` gate (fast-runner.ts:1283). `result.success` is a real
  bool field (fast-runner.ts:1263).
- **deploy migration gate (Seam 6)**: validator prints COMPACT JSON (JSON.stringify no
  indent) → grep `'"userVersion": *2'` matches zero-space; baseline_history never created
  on fresh boot; live user_version=2. Robust.
- **resume (Seam 7)**: loadResumableRun returns null (never throws) on missing row / null
  goal_graph / malformed JSON / wrong shape; safeParseObject/Array never throw; resume-run.ts
  exits 1/2/3 cleanly incl. 0-failed-goals (`if(!goalId)`). `resume` vs `task-resume` are
  DISTINCT bash case labels (mc-ctl) — no collision.
- **Seam 5 MC_API_KEY neutralize**: callers DO pass it (nanoclaw-runner.ts:78,
  heavy-runner.ts:142), substituted to non-empty placeholder → in-container required() ok.
- **Seam 1(a) metric-name match**: `mc_ritual_last_success_timestamp` byte-identical across
  scheduler→prometheus.ts gauge→alerts.yml. min-over-series won't false-fire (≥6 daily config
  rituals keep freshest <26h; a stale weekly ritual can't trip min).

## WARNINGS (reusable doctrine)
- **W1 boot-wedge blind window**: an in-memory process-lifetime gauge stamped only on
  success gives a min-over-series alert NOTHING to evaluate after every restart until the
  first success. `min(time()-gauge)` over an EMPTY series returns no data → MCRitualLoopStale
  CANNOT fire on a loop wedged before its first post-boot config-ritual success. The
  schedule.run_failed notifier only catches THROWS, not silent wedges → cold wedge is silent.
  DOCTRINE: a "liveness" gauge that resets on restart needs an `absent_over_time(...[Xh])`
  companion OR a high-cadence stamper (e.g. alert-poller @ */2) so a fresh series appears
  within minutes of boot. Only config rituals + overnight-tuning call recordRitualHeartbeat;
  mechanical crons don't stamp.
- **W2 self-monitor dies silently**: the coverage claim "mechanical rituals covered via
  recordRitualFailure→schedule.run_failed→notifier" holds for kb-reindex (scheduler.ts:597)
  and prometheus-alert-notifier (:883), but the CANARY (scheduled at boot scheduler.ts:374 →
  canary.ts:160) catch at canary.ts:182 is `console.error` ONLY — no recordRitualFailure. The
  detector meant to catch silent degradation throws silently. DOCTRINE: when auditing a
  "every failure now routes to X" claim, enumerate EVERY cron catch, not just the named ones;
  the self-monitor is the one that gets forgotten.

## INFO
- Seam 5: `--memory 2g` may OOM a heavy nanoclaw build; `--cap-drop=ALL` drops CAP_CHOWN so an
  npm postinstall that chowns fails. 8 working runs are small JS tasks — SUSPECTED for heavier.
- Seam 4: SECRET_ENV_KEYWORDS includes "PWD" → buildScrubbedEnv deletes PWD/OLDPWD (bash
  repopulates, harmless); GH_TOKEN also stripped from shell_exec (intended defense; git tools
  + container path are separate). PATH/HOME/NODE_* correctly survive. Redact regexes are
  linear (no catastrophic backtracking); shell-assignment over-redacts benign `MONKEY=` by
  design (logs only). Catches `export GEMINI_API_KEY="AIza…"`.
- Seam 8: dead-name residue — SOCIAL_TOOLS (scope.ts:253-255) + kb-injection keyword map still
  name the 3 removed tools; INERT (filtered vs registry, scope.ts:504 pattern, no throw) but
  inflates getAllAvailableTools() denominator by 3. Registration cleanly removed from builtin.ts.
- Doc nits: prometheus.ts claims RITUAL_STALE_FACTOR(1.5×) is "the contract with [alerts.yml]"
  but the alert uses fixed 93600s (factor governs /health only); alerts.yml says watchdog 9a
  "reads off /health" but 9a reads mc_budget_* prom gauges (watchdog.sh:220). No functional bug.
