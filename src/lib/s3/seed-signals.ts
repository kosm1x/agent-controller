/**
 * v7.7 Spine 2 (S3 substrate) — 14 seed signals (13 from Spine 2 + 1 added
 * by Spine 6: `recall_coherence_suppression_rate`, the Conway Pattern 3
 * correspondence audit composed onto this substrate).
 *
 * The seed registry is the declaration: "these are the watchable invariants
 * v7.7+ cares about." Most signals' source substrates (S2 sycophancy, V8.2
 * citation, V8.3 override, S5 skill_failures) haven't shipped yet; per spec
 * §10 ("S3 is bilateral-maturity-friendly... operator can shadow-run for
 * weeks, tune tolerance"), those signals land `enabled: 0` with a `notes`
 * field documenting their activation trigger.
 *
 * Signals with real data sources land enabled by default (3 of 14 — R1-W2):
 *   - s1_tool_cache_read_ratio (partial S1 instrumentation in cost_ledger)
 *   - s2_critic_unfixable_rate (reports table from Spine 1 P1)
 *   - cost_per_brief_drift (cost_ledger has data since 2026-04-26 S4 v2)
 *
 * Disabled-pending signals:
 *   - mc_whatsapp_disconnects_total — DISABLED until rate-from-counter
 *     computation lands. The Prom counter is monotonic; treating cumulative
 *     value as "per-hour disconnects" produces a permanent P0 spam fountain
 *     once cumulative crosses the threshold (R1-C1). Re-enable when either
 *     (a) PromQL rate() access lands, or (b) evaluator stores prior-tick
 *     snapshot for delta computation.
 *   - schema_migration_drift — DISABLED until first weekly run captures a
 *     real production baseline; default 50 is a placeholder that would
 *     trip P2 on every dev/test :memory: DB (~30-45 tables). Operator
 *     enables after recording actual production count (R1-W3).
 *
 * Seed runs idempotently on every boot — `seedSignalsIdempotent` reads the
 * existing-names set once up front.
 */

import {
  insertSignalIfMissing,
  loadAllSignals,
  type NewDriftSignal,
} from "./registry.js";

const SEED_DATE = "2026-05-19T00:00:00.000Z"; // v7.7 Spine 2 ship date
const ESTABLISHED_BY = "v7.7-spine-2-seed";

/**
 * 14 seed signals — 13 per V7.7-GUIDE Spine 2 (12 from spec §5 + the
 * `mc_whatsapp_disconnects_total` add from V7.7-GUIDE Spine 2 note) + 1 from
 * v7.7 Spine 6 (`recall_coherence_suppression_rate`, Conway Pattern 3).
 *
 * The baseline_query column convention:
 *   - SQL strings run via getDatabase().prepare(...).get() — must return
 *     a single row; the evaluator extracts the first column's value.
 *   - For Prometheus-only signals (mc_whatsapp_disconnects_total), the
 *     "query" is a sentinel `prom:<metric_name>` parsed by the evaluator.
 *     This avoids requiring an HTTP call out of the evaluator for now.
 *   - For signals lacking a real data source, the query is `awaiting:<note>`
 *     and the signal lands enabled=0. Evaluator skips disabled signals,
 *     so these never fire.
 */
export const SEED_SIGNALS: readonly NewDriftSignal[] = [
  // 1 — S1 cache read ratio (S1 instrumentation partial; query returns null if no data)
  {
    signal_name: "s1_tool_cache_read_ratio",
    signal_kind: "cache_health",
    source_substrate: "S1",
    baseline_query:
      "SELECT CAST(SUM(cache_read_tokens) AS REAL) / NULLIF(SUM(prompt_tokens), 0) FROM cost_ledger WHERE created_at > datetime('now', '-1 day')",
    baseline_value_json: '{"value":0.85}', // PLACEHOLDER — recalibrate after 30d learning window (R1-W1)
    tolerance_json: '{"kind":"absolute_threshold","op":"lt","value":0.75}',
    cadence: "nightly",
    alert_priority: "P1",
    enabled: 1, // partial data is OK — query returns null when empty, evaluator treats as no-trip
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "PLACEHOLDER baseline 0.85; trips when 24h cache_read_ratio drops below 0.75. Recalibrate after 30d learning window per spec §6 manual-baseline path.",
  },
  // 2 — S1 lint warnings in prod (S1 not shipped; awaiting source)
  {
    signal_name: "s1_lint_warnings_in_prod",
    signal_kind: "code_health",
    source_substrate: "S1",
    baseline_query: "awaiting:S1-lint-instrumentation",
    baseline_value_json: '{"value":0}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0}',
    cadence: "nightly",
    alert_priority: "P0",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "Awaiting S1 lint instrumentation. Enable when S1 lands a prod-lint surface. Any non-zero count = P0 alert.",
  },
  // 3 — S2 sycophancy rate (S2 sycophancy probe not shipped; awaiting source)
  {
    signal_name: "s2_sycophancy_concede_rate",
    signal_kind: "quality_drift",
    source_substrate: "S2",
    baseline_query: "awaiting:S2-sycophancy-probe",
    baseline_value_json: '{"value":0.05}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.05}',
    cadence: "weekly",
    alert_priority: "P1",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "Awaiting S2 sycophancy probe. NOTE: 'S2' here means sycophancy-probe substrate from V8-VISION, NOT the self-audit-before-reporting substrate shipped in Spine 1.",
  },
  // 4 — S2 critic unfixable rate (Spine 1 P2a/P2b critic IS shipped; this query is real)
  {
    signal_name: "s2_critic_unfixable_rate",
    signal_kind: "quality_drift",
    source_substrate: "S2",
    baseline_query:
      "SELECT CAST(COUNT(*) FILTER (WHERE critic_verdict = 'fail_returned_anyway') AS REAL) / NULLIF(COUNT(*), 0) FROM reports WHERE produced_at > datetime('now', '-7 days')",
    baseline_value_json: '{"value":0.10}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.10}',
    cadence: "weekly",
    alert_priority: "P1",
    enabled: 1, // reports table exists from Spine 1 P1; data accumulates from P2a deploy
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "Reads from reports table (Spine 1 P1). Trips when >10% of last-7d reports are fail_returned_anyway. Indicates critic chronically rejecting; either prompt drift or LLM-producer-regression.",
  },
  // 5 — V8.2 citation resolver rate (V8.2 not shipped; awaiting)
  {
    signal_name: "v8_2_citation_resolver_rate",
    signal_kind: "capability_health",
    source_substrate: "V8.2",
    baseline_query: "awaiting:V8.2-citation-resolver",
    baseline_value_json: '{"value":0.95}',
    tolerance_json: '{"kind":"absolute_threshold","op":"lt","value":0.95}',
    cadence: "nightly",
    alert_priority: "P1",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes: "Awaiting V8.2 citation resolver. Trips when 7d rate <95%.",
  },
  // 6 — V8.2 color promote correlation (V8.2 not shipped)
  {
    signal_name: "v8_2_color_promote_correlation",
    signal_kind: "capability_health",
    source_substrate: "V8.2",
    baseline_query: "awaiting:V8.2-color-promote",
    baseline_value_json: '{"value":1.5}',
    tolerance_json: '{"kind":"absolute_threshold","op":"lt","value":1.2}',
    cadence: "weekly",
    alert_priority: "P2",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes: "Awaiting V8.2 color-promote instrumentation.",
  },
  // 7 — V8.3 override rate per capability (V8.3 not shipped; on_event signal)
  {
    signal_name: "v8_3_override_rate_per_capability",
    signal_kind: "capability_health",
    source_substrate: "V8.3",
    baseline_query: "awaiting:V8.3-override-events",
    baseline_value_json: '{"value":0.05}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.05}',
    cadence: "on_event",
    alert_priority: "P0",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "Awaiting V8.3. on_event cadence: NOT cron-scheduled, fired by V8.3 controller. >5% override → demote.",
  },
  // 8 — V8.3 reversal failure count (V8.3 not shipped)
  {
    signal_name: "v8_3_reversal_failure_count",
    signal_kind: "capability_health",
    source_substrate: "V8.3",
    baseline_query: "awaiting:V8.3-reversal-events",
    baseline_value_json: '{"value":0}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0}',
    cadence: "hourly",
    alert_priority: "P0",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes: "Awaiting V8.3. Any reversal failure → auto-freeze capability.",
  },
  // 9 — V8.3 odd violation rate (V8.3 not shipped)
  {
    signal_name: "v8_3_odd_violation_rate",
    signal_kind: "capability_health",
    source_substrate: "V8.3",
    baseline_query: "awaiting:V8.3-odd-events",
    baseline_value_json: '{"value":0.20}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.20}',
    cadence: "nightly",
    alert_priority: "P1",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes: "Awaiting V8.3. >20% odd-violation rate over 7d.",
  },
  // 10 — S5 skill failure rate (S5 not shipped; Spine 3 in v7.7)
  {
    signal_name: "s5_skill_failure_rate",
    signal_kind: "capability_health",
    source_substrate: "S5",
    baseline_query: "awaiting:S5-skill_failures-table",
    baseline_value_json: '{"value":0.15}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.15}',
    cadence: "nightly",
    alert_priority: "P1",
    enabled: 0,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes: "Awaiting S5 (v7.7 Spine 3). >15% per-skill 7d failure rate.",
  },
  // 11 — cost per brief drift (cost_ledger live; query is real)
  {
    signal_name: "cost_per_brief_drift",
    signal_kind: "cost_health",
    source_substrate: "S4",
    baseline_query:
      "SELECT AVG(cost_usd) FROM cost_ledger WHERE task_id LIKE 'morning-brief-%' AND created_at > datetime('now', '-7 days')",
    baseline_value_json: '{"value":0.10}',
    tolerance_json: '{"kind":"pct_drift_from_baseline","pct":0.30}',
    cadence: "nightly",
    alert_priority: "P1",
    enabled: 1,
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "Reads from cost_ledger. Baseline $0.10/brief is placeholder; update established_at after first 30d learning window.",
  },
  // 12 — schema migration drift (sqlite_master query is always available)
  {
    signal_name: "schema_migration_drift",
    signal_kind: "infra_health",
    source_substrate: "infra",
    // PRESERVE the real query so operator can flip enabled=1 once baseline captured
    baseline_query: "awaiting:operator-captured-prod-baseline",
    baseline_value_json: '{"value":50}',
    tolerance_json: '{"kind":"absolute_threshold","op":"lt","value":40}',
    cadence: "weekly",
    alert_priority: "P2",
    enabled: 0, // R1-W3: disabled until prod baseline captured (would trip on dev/test DBs)
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "DISABLED at seed time. Operator workflow to enable: (1) on a freshly-deployed production DB, run `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'`. (2) UPDATE drift_signals SET baseline_value_json = '{\"value\":<actual>}', baseline_query = 'SELECT COUNT(*) FROM sqlite_master WHERE type = \\'table\\'', enabled = 1 WHERE signal_name = 'schema_migration_drift'. Until then this signal would trip P2 on every dev/test :memory: DB.",
  },
  // 13 — WhatsApp disconnects (per V7.7-GUIDE Spine 2 add)
  {
    signal_name: "mc_whatsapp_disconnects_total",
    signal_kind: "infra_health",
    source_substrate: "infra",
    // PRESERVE the real query so it activates immediately when rate-computation lands
    baseline_query: "awaiting:rate-from-counter-evaluator",
    baseline_value_json: '{"value":3}',
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":10}',
    cadence: "hourly",
    alert_priority: "P0",
    enabled: 0, // R1-C1: disabled until rate-from-counter lands
    established_at: SEED_DATE,
    established_by: ESTABLISHED_BY,
    notes:
      "DISABLED at seed time. The underlying Prometheus counter is MONOTONIC (cumulative since process boot); treating its cumulative value as 'disconnects per hour' produces a permanent P0 spam fountain once cumulative crosses 10. Re-enable when EITHER (a) PromQL rate(mc_whatsapp_disconnects_total[1h]) access lands, OR (b) the S3 evaluator stores a prior-tick snapshot and computes delta-per-cadence. Tracked in next-sessions-queue as S3-C1. Activation query when fixed: baseline_query = 'prom:mc_whatsapp_disconnects_total' (rate-mode).",
  },
  // 14 — Conway Pattern 3 correspondence audit (v7.7 Spine 6). The weekly
  // "correspondence audit" IS this drift signal: a rising coherence-mode
  // suppression rate is exactly Conway's "coherence drift toward
  // confabulation" trap (V8-VISION §9). DISABLED-pending: recall_audit has
  // had no new rows since 2026-05-10 — recall routes through
  // SqliteMemoryBackend (HINDSIGHT_ENABLED=false), which does not call
  // logRecall. The baseline below is REAL (measured from 1460 historical
  // rows), not a placeholder.
  {
    signal_name: "recall_coherence_suppression_rate",
    signal_kind: "coherence_drift",
    source_substrate: "Conway-P3",
    // `awaiting:` sentinel per the Spine 2 invariant (a disabled signal must
    // not ship a real query). The real activation query is in `notes`.
    baseline_query: "awaiting:recall-audit-active",
    baseline_value_json: '{"value":0.0406}', // measured 2026-05-20 over 1460 historical rows (1449 excluded / 35654 candidates)
    tolerance_json: '{"kind":"absolute_threshold","op":"gt","value":0.08}',
    cadence: "weekly",
    alert_priority: "P2",
    enabled: 0,
    established_at: "2026-05-20T00:00:00.000Z",
    established_by: "v7.7-spine-6-seed",
    notes:
      "DISABLED-pending — recall_audit receives no new rows under the current Hindsight-demote routing (recall goes through SqliteMemoryBackend, which does not call logRecall/applyOutcomeBias; only HindsightMemoryBackend does). Baseline 0.0406 is real, measured from 1460 historical rows. Re-enable when recall_audit receives fresh rows: EITHER HINDSIGHT_ENABLED=true, OR a future spine wires logRecall into SqliteMemoryBackend. Trips P2 when the weekly coherence-mode suppression rate exceeds 0.08 (~2x baseline) — Conway's coherence-drift watchpoint. Tracked as S6-recall-audit-dormant. Activation query: \"SELECT CAST(SUM(excluded_count) AS REAL) / NULLIF(SUM(excluded_count + result_count), 0) FROM recall_audit WHERE created_at > datetime('now','-7 days') AND (mode = 'coherence' OR mode IS NULL)\".",
  },
] as const;

export function seedSignalsIdempotent(): {
  inserted: number;
  skipped: number;
} {
  // Read existing names ONCE up front — avoids N queries inside the loop.
  const existing = new Set(loadAllSignals().map((s) => s.signal_name));
  let inserted = 0;
  let skipped = 0;
  for (const s of SEED_SIGNALS) {
    if (existing.has(s.signal_name)) {
      skipped++;
      continue;
    }
    insertSignalIfMissing(s);
    inserted++;
  }
  return { inserted, skipped };
}
