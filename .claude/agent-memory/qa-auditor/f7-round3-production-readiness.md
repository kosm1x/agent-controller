---
name: F7 Alpha Combination — Round 3 production-readiness audit
description: Findings from the 3rd F7 audit pass (post-merge). Blast radius, observability, recovery, operator ergonomics focus.
type: project
---

F7 (commit d1db4c4) audited for production readiness on 2026-04-18. 2 prior rounds covered math + correctness.

## Round 3 findings (this pass)

### Warnings

1. **Zero observability in alpha tools** — no logger calls, no events inserts, no trace emission from alpha_run / alpha_latest / alpha_explain. When alpha_run fails in prod (F7CorrelatedSignalsError, F7ConfigError, DB errors), only evidence is the string returned to the LLM. No post-mortem audit trail; no Prometheus metrics. Prior sprints (F1-F6.5) generally emit events.

2. **as_of input unvalidated** — `alpha_run` accepts any string for as_of. `"banana"` → `new Date("bananaT12:00:00Z")` → Invalid Date → `toISOString()` throws RangeError → caught by generic catch → returns `"alpha_run: Invalid time value"`. Operator gets no hint that their format was wrong. Also: `resolveTradingPeriods` does lex string compare against YYYY-MM-DD bar timestamps — a malformed as_of can silently include all bars instead of filtering.

3. **exclude_reason schema comment stale** — schema.sql line 494 lists `'ic_le_zero','flat_variance','missing_data','singular'` but the TS enum also emits `'correlated'`. The DB column has no CHECK constraint, so the value writes successfully — but the comment misleads anyone reading the schema to build downstream consumers (F7.5, F8).

4. **alpha_explain row width = 112 chars** — rendered in monospace, this wraps awkwardly on Telegram mobile. The table is usable on desktop but not optimized for the primary UI. Columns are also separated by variable whitespace which makes CSV-style post-processing brittle. Low-severity operator ergonomics.

5. **No retention policy on signal_weights / signal_isq** — append-only with no prune. Realistic growth ~15 signals/run × 1 run/day = ~5500 rows/year (not 2M — original prompt math conflated signals-per-run with signal-rows-total). Scale concern is small but a retention stub (e.g., keep last 180 days like whale_trades) fits the existing pattern.

## Not issues (checked and cleared)

- Scope regex: tested against false-positive candidates. "alpha version", "alpha release", "alphabetize", "alpha male", "hola alpha" do NOT match. Requires explicit strong context. Clean.
- Parallel write safety: better-sqlite3 db.transaction() is synchronous + SQLite write lock. No torn reads possible.
- watchlist=0: ISQ coverage divides by watchlistSize with `> 0` guard → 0, not NaN.
- alpha_explain run_id access: it's all local SQLite; no cross-tenant surface. No security issue.
- Memory: Float64Array allocated per run, eligible for GC after return. No leak risk at observed sizes.
- randomUUID() collision: negligible.

## Verdict

PASS WITH WARNINGS — nothing that blocks F7.5 start. Observability is the highest-impact gap; if F7 silently misbehaves for a week before F8 trips on stale weights, the current DB is the only forensic surface.
