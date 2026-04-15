# Phase β Readiness Framework

> **Status:** DRAFT — awaiting reality-check agent findings
> **Last updated:** 2026-04-14 session 67 wrap+1
> **Purpose:** Define what "Jarvis is ready for Phase β" actually means, measurably, before any F-series code ships.

---

## Why a readiness gate

Phase β is the **v7.0 thesis** — "detect financial signals with paper-trading credibility." It's 11 sessions of critical-path work. If we start implementation against a system that isn't stable enough to carry it, we'll ship on a broken foundation and the thesis won't validate.

Phase α just completed with significant churn (session 67 alone: 15 commits, +211 tests, 4 criticals caught by audit). That's _velocity_, not _stability_. Before committing to F1, we verify the system is settled.

Skipping the gate and going straight to F1 is the fastest path that could ship. It's also the path where one unaudited production regression destroys two weeks of F-series work and we can't tell whether the fault was Phase β or the brittle foundation.

## The gate is NOT

- A checklist for "is every feature perfect"
- An excuse to polish indefinitely
- A bikeshedding opportunity
- A reason to add features before F1

The gate is a **pass/fail** check against five concrete dimensions. If all five pass, we start F1. If any fail, we know exactly what to fix before starting.

---

## The five dimensions

### 1. Test suite health

**Measure:** Full suite passes reliably (3 consecutive runs), zero type errors, zero lint failures. No flaky tests. Test coverage on the runners, inference adapter, and messaging pipeline is high enough that a regression in Phase β surfaces immediately.

**Pass criteria:**

- [ ] `npm test` passes 3/3 consecutive runs
- [ ] `npm run typecheck` returns zero errors
- [ ] No test marked `.skip`, `.todo`, or `@pending` in runner / inference / messaging paths
- [ ] `src/inference/`, `src/runners/`, `src/messaging/` have ≥80% line coverage (or documented exclusions)

**Current state (end session 67):** 2237 tests passing, zero type errors. Need to verify 3-run stability + coverage measurement — not currently tracked. **Likely PASS after a coverage audit.**

---

### 2. Production stability signal

**Measure:** Service has run without unscheduled restart or critical error for a defined window. Last 48h of journalctl logs have zero `FATAL` / `unhandledRejection` / `uncaughtException` entries. Circuit breakers and rate limiters have fired appropriately (no stuck-open, no stuck-closed).

**Pass criteria:**

- [ ] 48h continuous uptime without unscheduled restart
- [ ] Zero `FATAL` or unhandled exception entries in journalctl for 48h
- [ ] No reaction/retry loops detected in events table
- [ ] Inference provider degradation tracker is green (no provider stuck in circuit-breaker open state)
- [ ] Memory consolidation ritual has run successfully in the last 48h
- [ ] KB backup ritual has written a fresh backup in the last 24h

**Current state:** Service restarted 3 times today (session 67 builds: 3066906 → 3833740 → 4068497). 48h stability window has not opened yet. **PENDING — needs 48h quiet window before gate.**

---

### 3. Audit closure

**Measure:** Every qa-auditor finding from sessions 60-67 that was rated CRITICAL or MAJOR has been either (a) shipped as a fix, or (b) explicitly deferred with a dated tracking memory file and a deferral rationale.

**Pass criteria:**

- [ ] Zero open CRITICAL findings from any session 60-67 audit
- [ ] All MAJOR findings either closed or explicitly deferred in memory
- [ ] v7.9 audit follow-ups (M1 full, M2, M3, W2-W7) reviewed — decide fix-now or defer-to-v7.5
- [ ] Stale-artifact-prune ritual has fired at least once successfully on the live host (to verify the v7.7.4 fix works end-to-end, not just in tests)

**Current state:**

- v7.6.1/.2/.3 SSRF audits: all closed ✅
- v7.7.1 MCP hardening: all CRITICAL + MAJOR closed ✅
- v7.7.2 Layer 4b + Rumi: all closed ✅
- v7.7.4 stale-artifact-prune: all closed ✅, but **not yet fired on live host** (first tick at 00:17 UTC, ~45 min from wrap)
- v7.9 deferred follow-ups: M1 full, M2, M3, W2-W7 — **need explicit defer-or-fix decision**

**PENDING — needs v7.9 deferral decision + one successful live prune tick.**

---

### 4. Memory + context pipeline integrity

**Measure:** The memory layer that Phase β will depend on for lesson capture, enrichment, and long-term learning is not silently poisoning itself. The extractor feedback loop fix from c15a06b is verified working end-to-end on a real task.

**Pass criteria:**

- [ ] No new tool-narrative lessons written to pgvector in the last 72h (grep `kb_entries` for the NOISE_PATTERNS signatures)
- [ ] Enrichment cycle fires on real user messages and returns relevant results (not stale/contaminated)
- [ ] Memory consolidation has run in the last 48h without errors
- [ ] Reflector gap telemetry is accumulating rows (`reflector_gap_log` has >10 rows since 2026-04-12)
- [ ] Trust-tier decay is functioning (spot-check a fact from 3+ days ago with decayed salience)

**Current state:** Extractor fix shipped in c15a06b on 2026-04-14 morning. Needs 72h quiet observation window. **PENDING — 48h left in observation window at start of F1.**

---

### 5. External dependency reality check

**Measure:** Every external API / MCP / library that F1-F10 will touch has been verified accessible and functional at the version we're building against. Any API that's deprecated, rate-limited, regulatory-shifted, or dead has an alternative chosen BEFORE implementation starts.

**Pass criteria:**

- [ ] Alpha Vantage Premium — verified accessible, endpoints match spec, pricing confirmed
- [ ] Yahoo Finance fallback — verified accessible or replaced
- [ ] FRED API — verified accessible, VIX/ICSA/M2 endpoints live
- [ ] Polymarket API — verified accessible, not regulatory-blocked
- [ ] Kalshi API — verified accessible, cost confirmed
- [ ] SEC EDGAR — verified accessible, rate limits confirmed
- [ ] alternative.me Fear&Greed — verified or replaced
- [ ] pm-trader MCP — verified existing, maintained, SDK-compatible, or replaced with alternative
- [ ] Binance WebSocket — verified accessible from our VPS region (US/non-US), or replaced
- [ ] @modelcontextprotocol/sdk — confirmed stdio transport works with subprocess-spawned MCP servers
- [ ] lightweight-charts + Puppeteer (v7.1 prereq) — parking lot, not Phase β, but check before v7.1

**Current state:** Three Explore agents running now. Results pending. **IN PROGRESS — first pass of reality check underway.**

---

## Decision matrix

| Dimensions passing | Action                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **5/5**            | Start F1 pre-plan next session                                                                    |
| **4/5**            | Fix the failing dimension first, then start F1                                                    |
| **3/5**            | Stop. Reassess scope. Possibly descope F10 or reorder Phase β                                     |
| **≤2/5**           | Phase β is premature. Defer to v7.1/v7.2/v7.3 P4 (γ work) and return to β readiness after 2 weeks |

---

## Gate completion timeline

| Dimension                    | Earliest clear                                            | Blocker                            |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------- |
| 1. Test suite health         | Immediate (already 2237 passing)                          | Coverage measurement needs running |
| 2. Production stability      | 2026-04-16 ~23:30 UTC (48h from last restart)             | Wait                               |
| 3. Audit closure             | Immediate after v7.9 defer decision + one live prune tick | v7.9 decision + cron observation   |
| 4. Memory pipeline integrity | 2026-04-17 (72h since c15a06b)                            | Wait + verification query          |
| 5. External deps             | 2026-04-15 (after 3 Explore agents finish today)          | Wait for agents                    |

**Earliest all-dimensions-pass:** 2026-04-17 (~48 hours from now).

**Earliest plausible F1 session start:** 2026-04-17 evening or 2026-04-18 morning.

---

## What we do with the wait

The 48h readiness window is not idle. Three things happen in parallel:

1. **Reality-check agents run → findings fold into the external-deps dimension**
2. **F1 pre-plan gets drafted against the reality-check findings** (draft, not final — the plan gets revised based on what the agents discover)
3. **Phase β ordering validation** — does the F1→F2→F4→F5→F3→... graph still make sense given the reality-check findings? Are there parallelizable pairs we missed?

When the gate opens, we start F1 with a validated plan, not a speculative one. If the reality check finds a dead dependency (e.g., pm-trader is abandoned), we know _now_ and can descope or replace _before_ we've written 500 LOC against a dead API.

---

## What "Jarvis stands its ground" means operationally

Per the user's phrasing — this isn't just "tests pass." It's:

- **No regression is one push away from destroying two weeks of F-series work**
- **Every system F1-F10 touches has been verified functional at the version we're building against**
- **The audit discipline from session 67 is still tight — no silent ship-blockers waiting in the queue**
- **Memory is not poisoning itself**
- **Production has had a quiet window to prove the current build is stable**

All five must be true. Any one failure is a stop signal.
