# V8 Substrate S3 — Implementation Delta vs. Spec

> **Status**: Spine 2 close artifact (per V7.7-GUIDE operating rule 8).
> **Authored**: 2026-05-19 · **Spec**: `docs/planning/v8-substrate-s3-spec.md`
> **Bundles shipped**: B1 (`3fd085f`), B2 (`acc8ba1`), B3 (`<this commit>`).

Read this alongside the spec. The spec is _intent_; this is _delivered_. Where they diverge, this document explains _why_.

---

## §1 — High-level shape

| Aspect               | Spec said                                             | Shipped as                                                                                       |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Effort               | ~5 days across 6 phases                               | ~1 day across 3 bundles (single-day push)                                                        |
| Tables               | `drift_signals` + `drift_alerts` + `baseline_history` | Same 3 tables (B1)                                                                               |
| Seed signals         | 12 declared                                           | 13 (12 spec + `mc_whatsapp_disconnects_total` per V7.7-GUIDE)                                    |
| Evaluator            | Per-signal `evaluateSignal()` + 5-kind tolerance      | Same (B1), with `prom:<metric>` + `awaiting:` query dispatchers                                  |
| Cron cadence         | 4 cron + `on_event`                                   | 4 cron only (`on_event` deferred to V8.3)                                                        |
| Correlated burst     | 3+ alerts in 5min → bundle                            | Same (B1)                                                                                        |
| Delivery hook        | V8.1 morning brief alert section                      | Same (B2), with R1-C2 lesson from Spine 1 P2a applied (no `requiredTools` redirection)           |
| P0 push notification | "via existing telegram/whatsapp adapter"              | Via `router.broadcastToAll` with R1-C1 observability fix (callback)                              |
| Suppression API      | `suppressAlert(alertId, reason, until)`               | Same shape + HTTP route + reason-prefix case-tolerant (R1-W4 fold)                               |
| Baseline aging       | Weekly reminder >90d                                  | Sunday morning brief only (B3), separate "🟢 Higiene de baselines" heading (R1-W3 fold)          |
| Activation gate      | "env edit triggers visible alert within 60s"          | Partial — env-checker `drift.ts` is sibling (pre-existing), NOT folded into registry-driven path |

---

## §2 — Substrate state at Spine 2 close

Already shipped from earlier work:

- `mc-ctl audit-claim` (pre-v7.7, sibling to S2)
- `src/observability/drift.ts` env-invariant checker (commit `3089057` — sibling, NOT superseded; the 6 env invariants stay registered there)

Shipped in v7.7 Spine 2:

- 3 tables: `drift_signals`, `drift_alerts`, `baseline_history` (B1)
- `src/lib/s3/tolerance.ts` (B1) — 5-kind evaluator
- `src/lib/s3/evaluator.ts` (B1) — SQL + `prom:` + `awaiting:` dispatch
- `src/lib/s3/registry.ts` + `seed-signals.ts` (B1) — 13 signals
- `src/lib/s3/scheduler.ts` (B1+B2+B3) — cron cadences + burst dispatch + push dispatch
- `src/lib/s3/burst.ts` (B1) — correlated-burst detection
- `src/lib/s3/delivery.ts` (B2+B3) — morning-brief section + Sunday aging
- `src/lib/s3/push.ts` (B3) — P0 push composition + dispatch
- `src/lib/s3/suppression.ts` (B3) — `suppressAlert()`
- `src/lib/s3/aging.ts` (B3) — 90-day baseline reminder
- `src/api/routes/admin.ts` POST `/alerts/:id/suppress` (B3)
- `src/messaging/router.ts:broadcastToAll` enhanced with `onChannelFailure` callback (B3 R1-C1 fold)
- Prom counters: `mc_s3_evaluator_errors_total{cadence, kind}` (B2) + `mc_s3_push_errors_total{channel}` (B3)

---

## §3 — Decisions vs. spec §12 open questions

| Q                                                | Spec default                     | Outcome                                                                                                                    |
| ------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Q1 Tolerance auto-tuning                         | NO — operator-adjusted           | **Confirmed.** No auto-tune.                                                                                               |
| Q2 Correlation depth                             | 5-min window only                | **Confirmed.** Richer correlation post-V8.0.                                                                               |
| Q3 Signal versioning (baseline_query rewrites)   | Alerts retain old query snapshot | **Confirmed.** `drift_alerts.observed_value_json` is the snapshot.                                                         |
| Q4 P3 silent-watch priority                      | NO — use P2 weekly digest        | **Confirmed.** P2 is the lowest priority.                                                                                  |
| Q5 Operator-defined ad-hoc signals               | NO — migration-tracked           | **Confirmed.** Bundle 3's `suppressAlert` HTTP route is the only operator-write path; signal CRUD stays migration-tracked. |
| Q6 Multi-operator alert routing                  | Defer to V9                      | **Confirmed.** `broadcastToAll` is single-channel-per-platform.                                                            |
| Q7 Alert delivery during operator unavailability | Queue indefinitely               | **Confirmed.** Alerts repeat every brief until resolved or suppressed.                                                     |
| Q8 Baseline regression after V8.3 promotion      | Operator-triggered               | **Confirmed.** No auto-rebaseline.                                                                                         |

**None of the 8 changed shipping decisions.** Spec defaults held.

---

## §4 — Decisions NOT anticipated by spec

| Decision                                                                                  | Bundle | Rationale                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mc_whatsapp_disconnects_total` seed signal                                               | B1     | V7.7-GUIDE added; closes the counter-recovery gap pinned in `feedback_prometheus_counter_recovery_path`                                               |
| 10/13 signals seeded with `enabled: 0` + `awaiting:` sentinel                             | B1     | Bilateral-maturity-friendly per spec §10. Signals' source substrates haven't shipped (S2-sycophancy, V8.2, V8.3, S5).                                 |
| `mc_whatsapp_disconnects_total` DISABLED at seed (R1-C1 fold from B1 audit)               | B1     | Counter is monotonic; treating cumulative as rate would produce P0 spam. Re-enable when rate-from-counter lands.                                      |
| `schema_migration_drift` DISABLED at seed (R1-W3 fold from B1 audit)                      | B1     | Baseline `50` placeholder; would trip every dev/test `:memory:` DB. Operator captures prod baseline + flips enabled=1.                                |
| `drift_alerts.signal_id` has NO `REFERENCES drift_signals(id)` clause                     | B1     | SQLite FK changes require destructive migration; LEFT JOIN + COALESCE mitigation in B2's `delivery.ts`                                                |
| `prom:<metric>` query dispatcher in evaluator                                             | B1     | Lets the registry watch Prometheus counters without an HTTP roundtrip; reads via `prom-client` registry directly                                      |
| Spine 1 P2a R1-C2 morning_brief retry lesson                                              | B2     | `submit_report` NOT in `requiredTools` (would trigger duplicate gmail_send on skip). B2 carried forward the same constraint for the S3 alert section. |
| SQL `LIMIT cap+1` for alert section (R1-W2 fold from B2 audit)                            | B2     | Bounded fetch at alert storms (10k alerts → 31 rows fetched, render 30 + overflow footer)                                                             |
| LEFT JOIN + COALESCE placeholder for orphan alerts (R1-W3 fold from B2 audit)             | B2     | Operator-deleted signals don't silently drop their alerts; render with `<deleted signal N>`                                                           |
| `broadcastToAll` enhanced with `onChannelFailure` callback (R1-C1 fold from B3 audit)     | B3     | Counter observability required a hook into the per-channel `.catch` swallow path                                                                      |
| Aging-only Sunday brief uses `🟢 Higiene de baselines` heading (R1-W3 fold from B3 audit) | B3     | Maintenance reminders shouldn't share the alarm-bell heading with alerts                                                                              |
| `suppressAlert` reason-prefix case-insensitive (R1-W4 fold from B3 audit)                 | B3     | Operator typo tolerance — `"False positive: "` now routes correctly                                                                                   |

---

## §5 — Substrate-availability state (per-signal enable status)

| Signal                              | Enabled | Reason                                                                      |
| ----------------------------------- | ------- | --------------------------------------------------------------------------- |
| `s1_tool_cache_read_ratio`          | ✅      | cost_ledger has data; partial baseline accepted                             |
| `s2_critic_unfixable_rate`          | ✅      | reports table from Spine 1 P1 ships data                                    |
| `cost_per_brief_drift`              | ✅      | cost_ledger live; baseline placeholder (recalibrate 30d)                    |
| `s1_lint_warnings_in_prod`          | ❌      | Awaiting S1 lint instrumentation                                            |
| `s2_sycophancy_concede_rate`        | ❌      | Awaiting S2 sycophancy probe (V8 substrate, not Spine 1's S2)               |
| `v8_2_citation_resolver_rate`       | ❌      | Awaiting V8.2                                                               |
| `v8_2_color_promote_correlation`    | ❌      | Awaiting V8.2                                                               |
| `v8_3_override_rate_per_capability` | ❌      | Awaiting V8.3 (also `on_event` cadence — would need wiring beyond Bundle 1) |
| `v8_3_reversal_failure_count`       | ❌      | Awaiting V8.3                                                               |
| `v8_3_odd_violation_rate`           | ❌      | Awaiting V8.3                                                               |
| `s5_skill_failure_rate`             | ❌      | Awaiting S5 (v7.7 Spine 3)                                                  |
| `schema_migration_drift`            | ❌      | Awaiting operator-captured prod baseline (S3-W3-fk)                         |
| `mc_whatsapp_disconnects_total`     | ❌      | Awaiting rate-from-counter (S3-C1)                                          |

3 enabled, 10 disabled. Activation will progress as substrates ship.

---

## §6 — Activation gate measurement plan

Spec §11: "**7-day shadow run: no false-positive bursts**" + per-signal coverage.

### Status

- ✅ Schema in place
- ✅ 13 seed signals registered (3 enabled, 10 disabled with triggers)
- ⏳ Per-signal `last_evaluated_at` within cadence window: first measurement gate at 2026-05-27 (7-day shadow window from B1 ship date)
- ⏳ Alert true-positive rate: depends on real-data signals tripping
- ⏳ "Env edit triggers visible alert within 60s" — env-checker (`src/observability/drift.ts`) DOES satisfy this via `mc-ctl drift` + `GET /api/admin/drift`, but the env-checker is NOT in the registry-driven path. Folding it would be a separate small bundle.

### Telemetry

- `drift_signals.last_evaluated_at` per signal — proves cron ticks fire
- `drift_alerts` rows over time — proves evaluator emits when tolerance trips
- `mc_s3_evaluator_errors_total` counter — Grafana view of cron failures
- `mc_s3_push_errors_total` counter — Grafana view of push failures

---

## §7 — Cumulative scoreboard across Spine 2

| Bundle                                      | Commit          | Files   | LOC             | Tests added | Audit verdict                                                       |
| ------------------------------------------- | --------------- | ------- | --------------- | ----------- | ------------------------------------------------------------------- |
| B1 — schema + evaluator + burst + cron      | `3fd085f`       | 11 (+)  | +2225 / -8      | +65         | 1 C / 5 W / 4 I — 11 in-bundle folds + 1 queued                     |
| B2 — morning-brief delivery + S3-I2 counter | `acc8ba1`       | 12      | +874 / -14      | +92         | 0 C / 4 W / 3 I — 5 in-bundle folds + 3 queued                      |
| B3 — push + suppression + aging             | `<this commit>` | 13      | +1455 / ~22     | +43         | 1 C / 4 W / 5 I — 6 in-bundle folds + 4 queued                      |
| **TOTAL**                                   | 3 commits       | ~36 net | **+4554 / -44** | **+200**    | **2 C (both folded) / 13 W / 12 I — 22 in-bundle folds + 8 queued** |

**Open queue items from Spine 2** (8 total, all P3 hygiene with explicit triggers):

- B1-W4: per-cadence promise-mutex (trigger: V8.3 on_event lands)
- B2-S3-I1: verbatim-marker delimiters for alert section
- B2-S3-I3-tests: counter-increment tests via injected throws
- B2-S3-W3-fk: schema FK option (RESTRICT vs CASCADE)
- B3-S3-C1 (carry): rate-from-counter for `mc_whatsapp_disconnects_total`
- B3-S3-W3 (carry): operator captures prod baseline for `schema_migration_drift`
- B3-R1-I1: max-length validation on `reason` / `acknowledged_by` body fields
- B3-R1-I5: separate `acknowledged_at` vs `resolved_at` timestamps for v8.0 auto-unsuppress design

---

## §8 — Lessons that generalize

Three patterns from Spine 2's 3-bundle arc that should inform Spine 3+:

### Pattern 1 — Bilateral-maturity is realized via `enabled: 0` + sentinel queries

Spec §10 promised "S3 is bilateral-maturity-friendly... operator can shadow-run for weeks." Implementation realized this by SHIPPING the registry with most signals disabled + an `awaiting:<note>` sentinel as their baseline_query. Substrates flip them on as they ship. **Apply to**: Spine 3 (S5 skills) likely benefits from the same pattern — register skills as catalog entries before they're invocable.

### Pattern 2 — Counter unreachability is silent until proven by adversarial audit

Bundle 3's R1-C1 finding (push counter unreachable through `Promise.all` `.catch` swallow) is a textbook case of `feedback_prometheus_counter_recovery_path`. The instrumentation was in place; the wire was broken; tests passed because the mock rejected differently than production. **Apply to**: every Bundle that adds a counter must include a test that asserts the counter actually bumps on the failure-path the counter purports to measure — NOT just that the failure path returns correctly.

### Pattern 3 — Heading semantics matter when content tone varies

Bundle 3's R1-W3 caught the aging-only Sunday brief wrapping under the alarm-bell heading. The R1 audit framed this as urgency-content mismatch. **Apply to**: any future operator-facing surface that aggregates heterogeneous content (alerts + reminders + status) — ensure heading discipline matches the most-permissive content's tone, not the most-urgent's.

---

## §9 — Spine 2 status: CLOSED

V7.7-GUIDE Spine 2 row marked Closed in this commit. Spine 2 contributed:

- 1 substrate (S3) fully shipped per V8-VISION §10
- 3 commits across one day (B1 + B2 + B3)
- ~4554 LOC net, +200 tests
- 0 production regressions
- 0 user-facing capability changes (operator-facing alerts are S3's intended surface; admin route is operator-only)
- 1 new architectural pattern: `broadcastToAll` observability callback (transferable to any future fire-and-forget broadcast surface)

**v7.7 spine progress: 2/7 closed.** Recommended next: **Spine 3 (S5 — skills-as-stored-procedures, ~10d)**. Spine 3 is the longest single spine; Spines 4-6 layer on top of 1-3.
