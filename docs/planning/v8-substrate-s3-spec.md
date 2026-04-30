# V8 Substrate S3 — Out-of-Band Drift Detector

> Spec for the third of five V8 substrate items. S3 is the out-of-band sentinel that watches production state for divergence from declared baselines and surfaces it before the divergence becomes a silent failure mode.
>
> Authored 2026-04-30 as the round-out of V8 substrate documentation. S3's value is realized in proportion to how many other substrate items declare watchable signals — so this spec is most useful AFTER S1, S2, V8.2, and V8.3 are specced (which they are). S3 reads everyone else's metrics.
>
> Activation: any time. Not freeze-blocking. S3 is mostly a query layer over cost_ledger + a small registry table + a delivery hook into the morning brief; no risky surface mutations in core inference paths.

## §1 — Problem

Things drift silently. The 2026-04-26 P1-A measurement caught one drift class (cache prefix corruption); the 2026-04-25 KB injection regression caught another (re-plan loop missed enforce-KB step); the 2026-04-26 react\b unbounded-alternation bug caught a third (regex matching changed when a synonym was added). Each had a window of days-to-weeks where production behavior had diverged from intended behavior with no signal surfacing.

The pattern is: someone had a measurement that _would_ have caught the regression, but the measurement was pre-fix, ad-hoc, and not connected to any alert. The discipline has been: "after we get burned, write a memory file so we don't get burned the same way."

S3 inverts that: declared baselines + tolerances + cadence + delivery. The watchlist EXISTS BEFORE the regression. The instrumentation is shared. The alert path is one path, not 12 different ad-hoc cron jobs.

S3's job is NOT to detect novel failure modes. S3's job is to make sure the failure modes we ALREADY KNOW HOW TO MEASURE are continuously measured. S5 (skills) institutionalizes the "how"; S3 institutionalizes the "watch."

## §2 — Current state (baseline)

What exists:

- `cost_ledger` table (S4 will universalize) — covers some token/cost metrics
- Ad-hoc `journalctl` / Prometheus / Grafana dashboards for some signals
- Memory files documenting individual incidents (`feedback_*`)
- Manual operator inspection for most production state

What's missing:

- A registry of "what we watch and why"
- A tolerance band per signal (some drifts are noise; some are alerts)
- Per-signal cadence (hourly cache health vs. weekly schema-version vs. nightly sycophancy)
- One delivery path so alerts surface alongside V8.1 morning briefs (not separate channel proliferation)
- Cross-signal correlation (override-rate spike + sycophancy-rate spike at same time = one root cause, not two)

S3 builds the registry + tolerance + cadence + delivery layer. The signals themselves come from S1/S2/V8.1/V8.2/V8.3/S5 (each substrate declares what it watches).

## §3 — Precedents (composed)

### From `feedback_metrics_extrapolation.md`

The discipline that prevents S3 from being noise: n-floor, sample-list-not-AVG, cache-window-aware queries. S3 alerts must be derived under these rules or they generate false positives.

### From `feedback_audit_discipline.md`

Audit-pattern catalog applies: 2-round protocol, expect-≥1-Critical-on-bundles. S3 alerts that bundle multiple signals (e.g., "P0: 3 signals tripped together") get the bundle treatment.

### From V8.1 spec §8 detection algorithms

V8.1 has detection cron for stalled tasks + dormant objectives + recurring blockers. S3's cron infrastructure mirrors this — same scheduling, same delivery into morning brief, just different signals.

### From V8.3 spec §10 calibration controller

V8.3's PI controller is a SPECIAL CASE of S3 watching. Override-rate exceeds 5% → V8.3 controller demotes capability. S3 generalizes: any signal exceeding tolerance → alert + (optionally) wired action.

### From `feedback_session_2026_04_25_memory_refactor.md`

Index-entry date stamps avoid stale facts. S3 baselines must carry `established_at` so alerts can be validated against "is this baseline still current?"

### From Anthropic Computer Use safety

The "default-deny external access" attitude transfers: signals default to alerting on observed-deviation; explicit suppression requires reasoning written in the registry.

### Explicit divergences

- **NOT a generic monitoring system** — S3 doesn't try to be Prometheus or DataDog. It's a thin SQLite table + cron + brief delivery. Production observability stays where it lives (Grafana, journalctl). S3 watches _Jarvis-internal logical state_, not infrastructure.
- **NOT real-time** — S3 cadence is minutes-to-days, not seconds. The signals it watches are themselves slow (sycophancy rate over 30 days, cache_read_ratio over 7 days, override-rate over 20 executions). Real-time alerting on slow signals is just noise.
- **NOT auto-remediating by default** — S3 ALERTS. Auto-remediation is the consumer's choice (V8.3 controller wires drift → capability demote; most signals just surface to operator).

## §4 — Architecture overview

```
[ S1 cache instrumentation ]    [ S2 sycophancy probe ]    [ V8.2 confidence outcome ]
[ V8.3 override-rate ]          [ S5 skill_health ]        [ S4 cost_ledger v2 ]
        │                                │                            │
        └────────────────────────────────┴────────────────────────────┘
                                         │
                                         ▼
                          [ drift_signals registry ]  ← signal name + baseline_query + tolerance + cadence
                                         │
                                         ▼
                          [ S3 evaluator (cron) ]  ← runs each signal's query, compares to baseline
                                         │
                                         ▼
                          [ drift_alerts table ]  ← persistent alert history with deviation_kind
                                         │
                                         ▼
                          [ delivery: V8.1 morning brief section ]
                                         │   (P0 surfaces ALSO via push notification)
                                         ▼
                          [ operator: acknowledge / suppress / escalate ]
```

Five components:

1. **`drift_signals` registry** — declares what's watched
2. **Evaluator** — cron runs each signal's baseline_query, compares to expected
3. **`drift_alerts` table** — persistent history of triggered alerts
4. **Delivery hook** — pipes active alerts into V8.1 morning brief
5. **Operator UI** — acknowledge / suppress / escalate primitives

## §5 — Drift signals (the watchlist)

The seed registry. Each row is a signal that S3 watches.

### Schema

```sql
CREATE TABLE drift_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_name TEXT NOT NULL UNIQUE,
  signal_kind TEXT NOT NULL,                  -- broad category for grouping
  source_substrate TEXT NOT NULL,             -- which substrate emits the underlying data
  baseline_query TEXT NOT NULL,               -- SQL or named procedure ID
  baseline_value_json TEXT NOT NULL,          -- expected value or range
  tolerance_json TEXT NOT NULL,               -- {kind: 'absolute'|'pct'|'enum_match', value: ...}
  cadence TEXT NOT NULL CHECK (cadence IN
    ('hourly','every_4h','nightly','weekly','on_event')),
  alert_priority TEXT NOT NULL CHECK (alert_priority IN ('P0','P1','P2')),
  enabled INTEGER NOT NULL DEFAULT 1,
  established_at TEXT NOT NULL,
  established_by TEXT NOT NULL,               -- 'operator' or session ID
  notes TEXT,
  last_evaluated_at TEXT,
  last_observed_value_json TEXT,
  last_alert_id INTEGER REFERENCES drift_alerts(id)
);
CREATE INDEX idx_drift_signals_cadence ON drift_signals(cadence) WHERE enabled = 1;
CREATE INDEX idx_drift_signals_priority ON drift_signals(alert_priority) WHERE enabled = 1;
```

### Seed signals (12 at v1)

| Signal name                         | Substrate | Cadence  | Priority | Tolerance                                   |
| ----------------------------------- | --------- | -------- | -------- | ------------------------------------------- |
| `s1_tool_cache_read_ratio`          | S1        | nightly  | P1       | per-tool target − 10pp = alert              |
| `s1_lint_warnings_in_prod`          | S1        | nightly  | P0       | any non-zero = alert                        |
| `s2_sycophancy_concede_rate`        | S2        | weekly   | P1       | > 0.05 over 30 days = alert                 |
| `s2_critic_unfixable_rate`          | S2        | weekly   | P1       | > 0.10 over 7 days = alert                  |
| `v8_2_citation_resolver_rate`       | V8.2      | nightly  | P1       | < 0.95 over 7 days = alert                  |
| `v8_2_color_promote_correlation`    | V8.2      | weekly   | P2       | green:red < 1.2× over 30 days = alert       |
| `v8_3_override_rate_per_capability` | V8.3      | on_event | P0       | > 0.05 = controller-demote (action wired)   |
| `v8_3_reversal_failure_count`       | V8.3      | hourly   | P0       | any = alert + auto-freeze that capability   |
| `v8_3_odd_violation_rate`           | V8.3      | nightly  | P1       | > 0.20 over 7 days = alert                  |
| `s5_skill_failure_rate`             | S5        | nightly  | P1       | > 0.15 over 7 days per-skill = alert        |
| `cost_per_brief_drift`              | S4        | nightly  | P1       | > baseline + 30% over 7 days = alert        |
| `schema_migration_drift`            | infra     | weekly   | P2       | declared schema vs runtime != match = alert |

The seed list is curated; new signals get added via operator-approved migration (NOT casually). S3's value is staying focused.

### Tolerance kinds

```typescript
type Tolerance =
  | {
      kind: "absolute_threshold";
      op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
      value: number;
    }
  | { kind: "pct_drift_from_baseline"; pct: number } // e.g. 0.30 = 30% drift
  | { kind: "enum_match"; expected: string[] } // observed must match one
  | { kind: "absent"; window_minutes: number } // signal didn't fire in window
  | { kind: "window_breach"; min?: number; max?: number };
```

Tolerance evaluation is mechanical: read `baseline_query`, get observed value, compare against `baseline_value_json` per `tolerance_json` rule. Boolean output: tripped or not.

## §6 — Baseline registry (what's "expected")

Every signal needs a baseline. Two ways to establish:

### Manual baseline

Operator declares: "the cache_read_ratio target for `morning_brief` is 0.85." Stored as `baseline_value_json: {"target": 0.85}` with `established_by: 'operator', established_at: '2026-05-01T...'`.

### Computed baseline

Signal can be auto-baselined from a learning window: "observed cost-per-brief averaged over first 30 days post-V8.2-launch, ±1 stddev = baseline." Stored same way with `established_by: 'auto', notes: 'learned 2026-06-01..2026-06-30, n=30'`.

### Baseline staleness

Every baseline has `established_at`. After 90 days, the registry surfaces a "baseline aging" reminder for operator: "is this baseline still appropriate?" Not an alert (no drift detected); a hygiene nudge.

### Schema

```sql
-- The baseline_value_json column on drift_signals IS the baseline.
-- A history table tracks evolution:

CREATE TABLE baseline_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_name TEXT NOT NULL REFERENCES drift_signals(signal_name),
  baseline_value_json TEXT NOT NULL,
  established_at TEXT NOT NULL,
  established_by TEXT NOT NULL,
  retired_at TEXT,
  retired_reason TEXT
);
```

When a baseline updates, the prior row gets `retired_at` + `retired_reason`. Audit trail is intact.

## §7 — Detection cadence + triggers

S3 evaluator runs on cron, with per-signal cadence:

| Cadence    | When                                     | Why                                                                        |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `hourly`   | top of hour                              | infrastructure signals (heartbeats, reversal failures) — fast feedback     |
| `every_4h` | 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 | semi-fast signals (cost-spike detection, error-rate)                       |
| `nightly`  | 03:00 (low-traffic)                      | most operational signals (cache health, citation rate, skill failures)     |
| `weekly`   | Sunday 04:00                             | slow-rolling signals (sycophancy, color-promote correlation, schema drift) |
| `on_event` | triggered by another component           | V8.3 override → controller, V8.3 reversal failure → freeze                 |

### Evaluator pseudocode

```typescript
async function evaluateSignal(signal: DriftSignal): Promise<DriftAlert | null> {
  if (!signal.enabled) return null;

  let observed: any;
  try {
    observed = await runBaselineQuery(signal.baseline_query);
  } catch (err) {
    // Query failure is itself a signal — log and treat as P2 alert
    return await emitAlert(
      signal,
      { kind: "query_failure", error: err.message },
      "absent",
    );
  }

  await db.run(
    `UPDATE drift_signals SET last_evaluated_at=?, last_observed_value_json=? WHERE id=?`,
    [now(), JSON.stringify(observed), signal.id],
  );

  const tripped = evaluateTolerance(
    observed,
    signal.baseline_value_json,
    signal.tolerance_json,
  );
  if (!tripped) return null;

  const deviationKind = computeDeviationKind(
    observed,
    signal.baseline_value_json,
    signal.tolerance_json,
  );
  return await emitAlert(signal, observed, deviationKind);
}
```

### Cron registration

S3 hooks into existing node-cron infrastructure (`src/lib/cron/`). One scheduler entry per cadence, walking enabled signals filtered by cadence.

## §8 — Alert format + delivery

### Schema

```sql
CREATE TABLE drift_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES drift_signals(id),
  triggered_at TEXT NOT NULL,
  observed_value_json TEXT NOT NULL,
  baseline_value_json TEXT NOT NULL,
  deviation_kind TEXT NOT NULL CHECK (deviation_kind IN
    ('above','below','absent','changed','query_failure','correlated_burst')),
  severity TEXT NOT NULL CHECK (severity IN ('P0','P1','P2')),
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending','delivered','suppressed','expired')),
  delivered_in_brief_id INTEGER,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolution_kind TEXT CHECK (resolution_kind IN
    ('auto_resolved','operator_acknowledged','escalated','false_positive','superseded')),
  resolution_at TEXT,
  resolution_notes TEXT,
  bundle_id INTEGER REFERENCES drift_alerts(id)  -- correlated alerts grouped
);
CREATE INDEX idx_drift_alerts_active ON drift_alerts(triggered_at)
  WHERE resolution_at IS NULL;
CREATE INDEX idx_drift_alerts_signal ON drift_alerts(signal_id);
```

### Delivery into V8.1 morning brief

Active P0/P1 alerts are appended to V8.1's morning brief in a dedicated section. P2 alerts are aggregated into a weekly digest (in next Sunday's brief).

```typescript
type DriftAlertSection = {
  active_p0: DriftAlert[]; // surfaces always, immediately
  active_p1: DriftAlert[]; // surfaces in next morning brief
  weekly_digest: DriftAlert[]; // P2s aggregated
};
```

### P0 push notification

P0 alerts ALSO surface via push notification (not waiting for next morning brief). The push notification format:

```
[S3 P0] Reversal failure on capability `edit_task` at 14:32. Capability auto-frozen at L1 pending investigation. Decision ID 0042. Run `audit_decisions WHERE id=42` for context.
```

P0 is rare by construction (currently 3 of 12 seed signals): infrastructure-level. P1 is the operational norm (8 of 12). P2 is informational (1 of 12 seed).

### Correlated bursts

If 3+ alerts trigger within a 5-minute window across different signals, S3 creates a `bundle_id` linking them and emits ONE consolidated alert: "P1 correlated burst: cache_read_ratio dropped + cost_per_brief spiked + sycophancy_rate spiked simultaneously. Likely root cause: prompt structure regression. Most-recent prompt commit: <hash>."

This handles the "3-5 cascading bug chain" pattern (`feedback_layered_bug_chains.md`) — one root cause manifests as multiple downstream signals.

### Suppression

Operator can suppress an alert with reason:

```typescript
suppressAlert(alertId: number, reason: string, until: string)
```

Suppression sets `resolution_kind='false_positive'` IF reason starts with `"false positive: "`, else `'operator_acknowledged'`. Suppressed alerts don't re-trigger until `until` timestamp passes OR signal observed value moves out of suppression range.

## §9 — Cross-substrate alignment

| Substrate | Provides to S3                                                                                | Consumes from S3                                          |
| --------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **S1**    | per-tool cache_read_ratio + lint warnings via `v_tool_cache_health`                           | nothing (S3 just watches)                                 |
| **S2**    | sycophancy probe results, CRITIC verdict distribution                                         | nothing                                                   |
| **S4**    | cost_ledger v2 universal events (every inference path)                                        | nothing                                                   |
| **S5**    | skill_failures table for failure-rate signal                                                  | nothing                                                   |
| **V8.1**  | morning brief delivery slot (alert section); reflection_followups for self-scheduled rechecks | active alerts list for inclusion                          |
| **V8.2**  | citation resolver stats, color-promote correlation                                            | nothing                                                   |
| **V8.3**  | override-rate signal (drives controller); reversal failure events                             | controller decisions on demote (S3 also writes the alert) |
| **infra** | schema version, .env config snapshots                                                         | nothing                                                   |

S3 is mostly downstream. The exception is V8.3 controller — S3's override-rate signal fires the autonomy demote (which itself generates a decision_event, audit-trail intact).

## §10 — Phasing (~5 days)

Mostly registry + cron + view. No big risk surface.

### Phase 1 — Schema + seed registry (~1 day)

- Migration: 3 new tables (`drift_signals`, `drift_alerts`, `baseline_history`)
- Seed 12 signal rows
- Idempotent migration test
- Test: registry query returns 12 enabled signals

### Phase 2 — Evaluator + cron registration (~1.5 days)

- `src/lib/s3/evaluator.ts` — runs baseline_query, evaluates tolerance, emits alert
- `src/lib/s3/scheduler.ts` — registers cron jobs per cadence
- Tolerance evaluator with 5 kinds
- Test: synthetic baseline + observed → expected trip/no-trip outcomes

### Phase 3 — Delivery hook into V8.1 brief (~1 day)

- V8.1 morning-brief generator queries active alerts
- Alert section formatter (P0/P1/weekly digest)
- Test: synthetic alerts render correctly in brief

### Phase 4 — P0 push notification + suppression (~0.5 day)

- Push delivery hook (existing telegram/whatsapp adapter)
- `suppressAlert` API
- Test: P0 alert triggers push; suppressed alert doesn't surface

### Phase 5 — Correlated burst detection (~0.5 day)

- Bundle algorithm: 3+ alerts within 5 minutes → bundle_id
- Most-recent-commit lookup hook
- Test: synthetic 3-alert burst creates bundle

### Phase 6 — Baseline aging reminder (~0.5 day)

- Weekly job: signals with baseline > 90 days old → operator hygiene nudge in brief
- Test: synthetic aged baseline triggers reminder

### Total: ~5 days

S3 is bilateral-maturity-friendly because it doesn't change behavior, only surface. Operator can shadow-run for weeks, tune tolerance, then activate alert-with-action wiring (V8.3 controller demote) at their pace.

## §11 — Activation gate & measurement

### Activation queries

```sql
-- Schema in place
SELECT name FROM sqlite_master WHERE name IN
  ('drift_signals','drift_alerts','baseline_history');
-- Expected: 3 rows

-- 12 seed signals enabled
SELECT COUNT(*) FROM drift_signals WHERE enabled = 1;
-- Expected: ≥ 12

-- Each signal evaluated within its cadence window
SELECT signal_name, last_evaluated_at, cadence FROM drift_signals
WHERE enabled = 1 AND last_evaluated_at IS NOT NULL;
-- Expected: 12 rows, each last_evaluated_at within cadence range

-- Alert emission working
SELECT COUNT(*) FROM drift_alerts WHERE triggered_at > datetime('now', '-7 days');
-- Expected: ≥ 0 (no alerts is fine; system is just quiet)

-- 7-day shadow run: no false-positive bursts
-- Manual review: are alerts surfacing things that ARE actually drift?
```

### Operational metrics

- **Signal coverage**: % of seed signals with last_evaluated_at within cadence
- **Alert true-positive rate**: operator acknowledged vs. suppressed-as-false-positive
- **P0 to P1 ratio**: should skew P1 (P0 truly rare)
- **Median alert lifetime**: triggered → resolved
- **Bundle detection rate**: bursts caught / total alerts in 5-min windows
- **Baseline staleness**: count of signals with baseline > 90 days

### Watchpoints

- **>30% false-positive rate** — tolerance bands too tight; revise
- **Sustained 0 alerts for 60+ days** — either system is genuinely calm OR signals are too loose. Validate tolerances.
- **P0 push without operator acknowledgment >24h** — escalation needed; alert-of-alert
- **Bundle false-positive >50%** — burst window too wide; tune from 5min down

## §12 — Open questions

1. **Tolerance auto-tuning**. Should S3 propose tolerance adjustments based on observed false-positive history? Lean conservative: operator-adjusted only (per `feedback_audit_discipline.md` discipline of explicit calibration).

2. **Cross-signal correlation depth**. Bundles are 5-minute windows; richer correlation (causal graph between signals) is post-V8.0 work.

3. **Signal versioning**. When a baseline_query is rewritten, do prior alerts retain old query? Currently yes (alert stores observed_value_json snapshot); no schema change needed.

4. **P3 silent-watch**. Should there be a P3 priority for signals operator wants tracked but never alerted on? Use case: "I want history to look back later." Current answer: just enable signal at P2; operator reviews weekly digest.

5. **Operator-defined ad-hoc signals**. Can operator create a one-off signal via CLI without migration? Currently no (every signal is migration-tracked); revisit if operator workflow demands it.

6. **Multi-operator alert routing**. Single-operator assumption matches V8 vision. Flag for V9.

7. **Alert delivery during operator unavailability**. Currently alerts queue indefinitely. Should P0 push retry / escalate to alternate channel? Lean: queue is fine; missing one P0 has cost but adding retry-storm logic is its own failure mode.

8. **Baseline regression after capability promotion**. When V8.3 promotes a capability, the override-rate baseline shifts. Auto-rebaseline or operator-triggered? Lean operator-triggered (per V8.3 §10 hysteresis discipline).

## §13 — Cross-references

### Reference memories + feedback

- `feedback_metrics_extrapolation.md` — n-floor + sample-list discipline (hard constraint on baseline_query)
- `feedback_audit_discipline.md` — 2-round protocol applies to alerts; bundle pattern
- `feedback_layered_bug_chains.md` — correlated-burst handles cascading-bug pattern
- `feedback_session_2026_04_25_memory_refactor.md` — established_at pattern for staleness

### Specs

- `docs/V8-VISION.md` — V8 master vision (S3 substrate item §3)
- `docs/planning/v8-substrate-s1-spec.md` — provides cache_read_ratio signal
- `docs/planning/v8-substrate-s2-spec.md` — provides sycophancy + CRITIC signals
- `docs/planning/v8-substrate-s4-spec.md` — provides cost_ledger v2 universal data
- `docs/planning/v8-substrate-s5-spec.md` — provides skill_failures signal
- `docs/planning/v8-capability-1-spec.md` — V8.1 morning brief is delivery channel
- `docs/planning/v8-capability-2-spec.md` — V8.2 provides citation resolver + color-promote signals
- `docs/planning/v8-capability-3-spec.md` — V8.3 override-rate is action-wired signal
- `docs/planning/v8-bibliography-synthesis.md` — bibliography meta-index

### Code (post-Phase 1)

- `src/lib/s3/evaluator.ts` — signal evaluation
- `src/lib/s3/scheduler.ts` — cron registration
- `src/lib/s3/tolerance.ts` — 5-kind tolerance evaluator
- `src/lib/s3/delivery.ts` — V8.1 brief integration + push hook
- `src/lib/s3/correlated-burst.ts` — bundle detection
- `src/lib/s3/registry.ts` — signal registry CRUD

### Migrations

- `migrations/NN_s3_drift_signals.sql`
- `migrations/NN_s3_drift_alerts.sql`
- `migrations/NN_s3_baseline_history.sql`
- `migrations/NN_s3_seed_signals.sql`

## §14 — One-page summary

**What S3 is**: a thin registry + cron + delivery layer that watches 12 declared signals across all V8 substrates and surfaces drift before it becomes silent failure.

**What it changes**:

1. We have a **declared watchlist** instead of post-hoc forensics.
2. **Tolerance + cadence + priority** are explicit per signal; new substrate work declares signals as part of its definition-of-done.
3. **Correlated bursts** catch 3-5-deep cascading-bug chains as ONE alert with root-cause hint, not 5 ad-hoc tickets.
4. **V8.3 controller** (and any future auto-remediation) is wired through S3 as a consumer, not an ad-hoc cron.
5. **Baseline aging** prevents stale tolerances from rotting silently.

**What it costs**: ~5 days, three small tables, zero core inference path mutation.

**What activates it**: schema migration applied + 12 seed signals enabled + 7-day shadow run with all signals evaluated within cadence + operator review of first round of P1 alerts to validate tolerance.

**Why it matters**: the 2026-04 incident pattern was "regression in production for days because no one had instrumentation pointed at the right thing." S3 inverts that: instrumentation is declared up-front, watchlist evolves with substrate, alerts go to one place. The bibliography assembled lessons; S3 makes the lessons watchable.
