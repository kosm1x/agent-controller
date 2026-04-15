# Phase β — Financial Stack v7.0 — Planning Document

> **Status:** PRE-IMPLEMENTATION DRAFT — NO CODE COMMITTED, NO SERVICES TOUCHED
> **Assembled:** 2026-04-14 session 67 wrap+1
> **Purpose:** Give the operator everything they need to decide whether to start Phase β, when to start it, and what the first 11 sessions actually look like against the current state of the world (not the Feb 2026 spec).

This document consolidates four planning artifacts:

1. **Readiness framework** — the five-dimension gate Jarvis must pass before F1 starts
2. **Reality-check report** — what 3 parallel Explore agents found about external deps
3. **F1 Data Layer pre-plan** — the full first-session plan
4. **Ordering + parallelization map** — compressed schedule and bottleneck analysis

The individual source files live alongside this one in `docs/planning/phase-beta/01-04-*.md`. This document is the integrated read.

---

## TL;DR for the operator

**Can we start F1 next session?** Not yet. Three of the five readiness gate dimensions are not clear. Earliest gate-clear: **2026-04-17 evening** (~48h from now).

**Does the v7.0 thesis still hold?** Yes, but **with revisions**:

- Yahoo Finance fallback is dead (actively blocked since Feb 2026) — must replace
- Alpha Vantage Premium is a real $50/mo operating cost — operator approval needed
- Polymarket became **stronger** (CFTC DCM approved Nov 2025) — good news
- pm-trader MCP exists and is maintained but is Python (stdio subprocess is fine)
- alternative.me Fear&Greed is lagging — pair with a second sentiment source

**What's the revised session count?** 11.4 sequential, or **~9 with parallelization**. Was 11 / 7-8. Added 0.4 sessions total (Yahoo replacement + sentiment pair).

**What does Phase β cost to run ongoing?** ~$50/mo baseline (Alpha Vantage Premium tier 1). Plus optional $20-$50/mo for second sentiment source (LunarCrush/Santiment).

**What needs to happen before F1 starts?**

1. ✅ Operator decisions LOCKED (2026-04-14) — see Part 6
2. ⏳ Readiness gate clears (48h wait + 4 verifications) — target 2026-04-17 evening
3. ⏳ F1 pre-plan reviewed one final time with locked decisions baked in
4. ⏳ Optional: exploration plan items (see `05-exploration-plan.md`) executed during the wait to derisk F7/F8/F1-fallback

**Biggest risk:** F1 is the bottleneck. If it slips, parallelization cascades break. We should NOT overpack F1 with adopt-on-the-way items. Keep it laser-focused.

---

## Part 1 — Readiness gate (5 dimensions)

Phase β is the v7.0 thesis — 9-11 sessions of critical-path work. If we start against an unstable foundation, a regression 2 weeks in can destroy everything built since. The gate is a **pass/fail** check on five concrete dimensions.

| #   | Dimension                 | Current state                                                         | Clears when                                       |
| --- | ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Test suite health         | ✅ 2237 pass, 0 type errors                                           | Verify 3 consecutive runs + coverage measurement  |
| 2   | Production stability      | ⏳ Restarted 3× today                                                 | 48h continuous uptime → **2026-04-16 ~23:30 UTC** |
| 3   | Audit closure             | ⏳ v7.7.4 not yet fired live; v7.9 follow-ups need defer/fix decision | One successful `:17` cron + v7.9 decision         |
| 4   | Memory pipeline integrity | ⏳ Extractor fix c15a06b needs 72h observation                        | **2026-04-17 evening**                            |
| 5   | External deps             | ✅ 3 agents completed today                                           | Reality-check report approved by operator         |

**Decision matrix:**

- 5/5 dimensions → start F1
- 4/5 → fix the failing dimension first
- 3/5 → stop, reassess scope, possibly descope F10 or reorder
- ≤2/5 → Phase β is premature, defer to γ work for 2 weeks

**Earliest all-pass:** 2026-04-17 evening. **Target F1 start:** 2026-04-17 evening or 2026-04-18 morning.

---

## Part 2 — Reality-check findings (12 dependencies)

Three parallel Explore agents verified the external deps F1-F10 will touch. Full report in `02-reality-check-report.md`. Summary:

| Dep                             | Phase  | Status | Cost            | Action                                |
| ------------------------------- | ------ | ------ | --------------- | ------------------------------------- |
| Alpha Vantage Premium           | F1, F5 | 🟡     | **$49-$249/mo** | Lock tier decision                    |
| Yahoo Finance fallback          | F1     | 🔴     | —               | **REPLACE** — blocked since Feb 2026  |
| FRED API                        | F5     | 🟢     | Free            | Proceed                               |
| Polymarket API                  | F6     | 🟢     | Free            | Proceed (CFTC DCM approved Nov 2025)  |
| Kalshi API                      | F6     | 🟢     | Free            | Proceed (0% fees, fractional trading) |
| SEC EDGAR                       | F6     | 🟢     | Free            | Proceed                               |
| alternative.me Fear&Greed       | F6.5   | 🟡     | Free            | Pair with LunarCrush/Santiment        |
| CoinGlass (funding/liq)         | F6.5   | 🟢     | Free tier       | Proceed                               |
| DefiLlama (stablecoin)          | F6.5   | 🟢     | Free            | Proceed                               |
| pm-trader MCP                   | F8     | 🟡     | Free            | Adapt — Python subprocess via stdio   |
| Binance WebSocket               | F10    | 🟢     | Free            | Proceed                               |
| @modelcontextprotocol/sdk stdio | F8     | 🟢     | —               | Proceed                               |

### Critical: Yahoo Finance fallback is dead

`yahoo-finance2` v3.14.0 is still maintained, but Yahoo itself has been actively blocking scraping traffic since early 2026. Two open GitHub issues (#982 Jan, #985 Feb) confirm persistent 429s. Recent Cloudflare escalation makes this unsuitable for production.

**Replacement options (ranked):**

1. **Polygon.io free tier** — 5 req/min, 2-year historical, real-time WebSocket. Best free option. **Recommended.**
2. Financial Modeling Prep free — 250 req/day, fundamentals focus
3. IEX Cloud paid — $19-$49/mo, official, highest reliability
4. stooq.com unofficial — historical only
5. No fallback — rely entirely on Alpha Vantage SLA

### Big win: Polymarket CFTC DCM approval

Polymarket received Designated Contract Market approval from the CFTC in November 2025. US operations resumed January 2026. The whale-tracking use case is still queryable. F6 can proceed against a legally-compliant, actively-operating platform — the regulatory uncertainty that lurked in the Feb 2026 spec is resolved.

### pm-trader MCP status

Repo: `agent-next/polymarket-paper-trader`. v0.1.6 (March 2026). 234⭐. **26 tools**, not 29 as v7 spec claimed. Python-based (not TypeScript). Ships installable via `npx clawhub install polymarket-paper-trader`. Uses SQLite WAL for state. Supports buy → track → outcome thesis loop. Uses live Polymarket order books for realistic fills.

Python vs TypeScript is NOT a blocker — MCP stdio transport means we spawn the server as a subprocess and the implementation language is invisible. F8 scope unchanged.

### Revised effort estimate

| Phase     | Original              | Revised                 | Delta                          |
| --------- | --------------------- | ----------------------- | ------------------------------ |
| F1        | 1.5                   | **1.7**                 | +0.2 (Yahoo replacement)       |
| F6.5      | 0.5                   | **0.7**                 | +0.2 (second sentiment source) |
| **Total** | **11 (7-8 parallel)** | **~11.4 (~9 parallel)** | +0.4                           |

---

## Part 3 — F1 Data Layer pre-plan

Full plan in `03-f1-preplan.md`. Summary:

### What F1 delivers

- **6-table schema:** `market_data`, `watchlist`, `backtest_results`, `trade_theses`, `api_call_budget`, `signals` — all additive, all pre-allocated for downstream F-sessions to fill in
- **3 adapters:** `AlphaVantageAdapter` (primary), `PolygonAdapter` (fallback), `FredAdapter` (macro)
- **DataLayer facade:** smart primary→fallback dispatch, concurrent request dedup, 24h in-memory cache, validation + TZ normalization pipeline
- **6 tools, all deferred:** `market_quote`, `market_history`, `market_watchlist_{add,remove,list}`, `market_budget_stats`
- **New `finance` scope group** with regex activation for natural-language market queries (Spanish + English)
- **~42 new tests** covering adapters, validation, timezone, dispatch, cache, watchlist CRUD
- **Schema applies live** via additive `CREATE TABLE IF NOT EXISTS` — no DB reset

### Decisions needed BEFORE F1 coding starts

1. **Alpha Vantage tier.** Recommend **$49.99/mo (75 req/min)**. Upgradeable if watchlist grows.
2. **F1 fallback source.** Recommend **Polygon.io free tier**. Highest free request ceiling; official API; zero scraping risk.
3. **Initial watchlist.** Default suggestion (20-30 symbols): SPY, QQQ, DIA, IWM, VXX, GLD, TLT, AAPL, MSFT, GOOGL, AMZN, META, NVDA, TSLA, JPM, BAC, XLF, XLE, XLK, XLV + FX: EURUSD, USDJPY, GBPUSD + macro: FEDFUNDS, CPI, NONFARM, VIXCLS, ICSA, M2.

### F1 test targets

- `alpha-vantage.test.ts` (8 tests) — mocked fetch, rate-limit retry, NEWS_SENTIMENT parsing, macro endpoint shape, cost_units tracking, error classification, timezone normalization
- `polygon.test.ts` (6 tests) — mocked fetch, 5 req/min counter, backoff, shape compat, fallback trigger
- `fred.test.ts` (4 tests) — mocked fetch, series lookup, date range, error handling
- `data-layer.test.ts` (10 tests) — dispatch, dedup, cache, watchlist CRUD
- `validation.test.ts` (8 tests) — price sanity, timestamp sanity, continuity, gap detection
- `timezone.test.ts` (6 tests) — AV conversion, Polygon conversion, FRED dates, DST transitions
- `registry.test.ts` (MODIFY) — assert new tools deferred

**Total: +42 tests, 2237 → ~2279.**

### F1 verification steps

1. Typecheck + tests
2. Schema live via `sqlite3 ./data/mc.db < ddl.sql` or automatic `initDatabase()` load
3. Adapter smoke via mc-ctl db query
4. Budget check via `api_call_budget` aggregate
5. Watchlist smoke — add/remove/list SPY, QQQ, AAPL, GOOGL, MSFT
6. Fallback smoke — temporarily invalidate AV key, confirm Polygon serves
7. Live WhatsApp test: "Jarvis, ¿cómo está SPY?" → `finance` scope → `market_quote` fires

### F1 implementation order (~7 hours, 1.7 sessions)

1. Schema DDL + apply (15 min)
2. Types + interfaces (15 min)
3. `timezone.ts` + tests (30 min) — foundation for everything else
4. `validation.ts` + tests (45 min)
5. `FredAdapter` + tests (30 min) — simplest first
6. `AlphaVantageAdapter` + tests (90 min) — biggest piece
7. `PolygonAdapter` + tests (60 min) — mirrors AV shape
8. `DataLayer` facade + tests (60 min)
9. 6 tools + scope wiring + registry test (45 min)
10. Smoke tests via mc-ctl (15 min)
11. Live WhatsApp test + fix brittle edges (30 min)
12. Commit + push (10 min)

---

## Part 4 — Ordering + parallelization

Full analysis in `04-ordering-map.md`. Key findings:

### Critical path (sequential spine)

**F1 → F2 → F3 → F7 → F7.5 → F8 → F9** = 9.2 sessions

Everything else must fit within or around this spine.

### Three parallelization windows

**Window A (post-F1):** F2 + F4 + F5 all read from F1's schema independently. Can run in parallel or bundle F2+F4 in one session. Saves ~1 session.

**Window B (post-F2/F4/F5):** F3 + F6 + F6.5 have no cross-dependencies. F6.5 is small enough to bundle with F3 or F6. Saves ~0.7 sessions.

**Window C (post-F6/F6.5):** F7 → F7.5 → F8 → F9 must be sequential. No compression.

**Window D (optional):** F10 crypto WS has zero dependencies. Slot anywhere or defer.

### Hermes Tier 1 adoption slot-in

While we're touching `src/inference/adapter.ts` in F1 anyway, fold in:

- Empty response recovery for reasoning models (~30 LOC)
- Rate-limit header capture (~50 LOC)

Before F3 (which uses Prometheus heavy runner), fold in:

- Compression floor + activity tracking (~100 LOC) — prevents premature mid-task stops

The other Hermes Tier 1 items (adaptive streaming backoff, `watch_patterns`) can slot anywhere.

### Compressed schedule

| Session | Content                                                            | Cumulative   |
| ------- | ------------------------------------------------------------------ | ------------ |
| S1      | **F1** Data Layer + Hermes adapter.ts adoptions                    | 1.7          |
| S2      | **F2** Indicators + **F4** Watchlist tools                         | 2.7          |
| S3      | **F5** Macro + **F3** Signal Detector + compression-floor adoption | 4.2          |
| S4      | **F6** Prediction Markets + **F6.5** Sentiment                     | 6.4          |
| S5-S6   | **F7** Alpha Combination (2 sessions, solo)                        | 8.4          |
| S7      | **F7.5** Backtester                                                | 9.4          |
| S8      | **F8** Paper Trading                                               | 10.9         |
| S9      | **F9** Scan Rituals + **F10** optional crypto WS                   | 11.9 or 10.9 |

**Calendar estimate:** 5-14 days depending on audit rework cycles.

### Bottlenecks

1. **F1** is THE bottleneck. Every parallelization assumption fails if F1 slips. Don't overpack it.
2. **F6** has 3-API complexity — give it its own session.
3. **F7** is the algorithmic core — 2 sessions alone, no bundling.
4. **F8** has hidden pm-trader friction — verify stdio subprocess works end-to-end on our VPS before committing.

### Staging decisions

- **F1 ships alone** on its own branch, full audit, merge before S2 starts
- **F2+F4** ship as a single commit
- **F6 ships alone** — three APIs, dedicated audit surface
- **F7 ships alone** — algorithmic core
- **F8 ships alone** — pm-trader integration friction
- **F9 ships alone** — ritual scheduling has calendar edge cases

Jarvis cannot push to main (SG1 invariant) — feature branches only, operator merges.

### Phase γ interleaving?

**No.** The thesis is β. Split attention hurts velocity and audit discipline. γ (v7.2 Graphify, v7.3 P2 SEO telemetry) runs after F9 exits the critical path.

---

## Part 5 — Risks + mitigations

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                       |
| --------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------ |
| F1 slips → parallelization cascade breaks                       | Medium     | High   | Keep F1 laser-focused; split into staged commits if needed                                       |
| Alpha Vantage tier 1 quota insufficient for 30-symbol watchlist | Low        | Medium | `api_call_budget` table enforces 80% ceiling; upgrade to tier 2 if needed                        |
| Polygon free tier 5 req/min insufficient for fallback bursts    | Low        | Low    | Pre-cache at 08:00 ET; fallback is rare-intraday only                                            |
| pm-trader Python subprocess fails on our systemd deploy         | Medium     | High   | Prototype F8 startup in a throwaway branch BEFORE committing the full session                    |
| F7 alpha combination algorithmic bugs                           | Medium     | High   | Dedicated 2-session window, heavy test coverage, golden-file results for each weight config      |
| F7.5 walk-forward off-by-one bugs                               | Medium     | Medium | Explicit tests for window boundaries; visual verification against hand-computed example          |
| 2026-04-20 autoreason decision fires mid-session                | Certain    | Low    | Budget 0.5 sess for review; it's automatic so it won't block                                     |
| Audit catches a ship-blocker in F-series                        | Likely     | Medium | Plan for 2-pass audits on every F-session (per feedback_audit_iteration); budget 20% time buffer |
| Operator rejects the $50/mo Alpha Vantage cost                  | Low        | High   | Fall back to FMP $14-$69/mo or free-only strategy (degrades F1 to weekly snapshots only)         |
| Yahoo replacement chosen wrong (e.g. Polygon rate-limits us)    | Medium     | Low    | F1 adapter layer is pluggable; swap fallback in 1-2h                                             |

---

## Part 6 — Operator decisions ✅ LOCKED (2026-04-14)

All six questions answered. F1 pre-plan is implementation-ready subject to the readiness gate clearing.

1. **Alpha Vantage tier:** ✅ **$49.99/mo** (tier 1, 75 req/min)
2. **F1 fallback source:** ✅ **Polygon.io free tier** (5 req/min, official API)
3. **Initial watchlist:** ✅ **default 29-symbol list** (20 equity/ETF + 3 FX + 6 macro). **Design requirement from operator:** changing the watchlist must be a trivial task for Jarvis via natural-language invocation — this is a first-class F1 acceptance criterion, not optional polish.
4. **Macro series scope:** ✅ **FRED + Alpha Vantage (both sources)** — AV for FEDFUNDS/TREASURY/CPI/UNEMPLOYMENT/NONFARM/REAL_GDP, FRED for VIXCLS/ICSA/M2SL.
5. **Second sentiment source (F6.5):** ✅ **CoinMarketCap Fear & Greed (free)** — two free sentiment sources paired (alternative.me + CMC). F6.5 stays at zero added operating cost. LunarCrush/Santiment deferred as a possible future upgrade.
6. **γ interleave during β:** ✅ **NO — finish β first.** S1-S9 contain only F-series work. γ begins in S10+ after F9 ships.

**Monthly operating cost for v7.0 (locked):** $49.99/mo baseline (Alpha Vantage Premium tier 1). No other paid deps at Phase β launch.

Full decision detail in `03-f1-preplan.md` → "Decisions LOCKED (operator 2026-04-14)".

---

## Part 7 — What happens next

### Current state (2026-04-14 session 67 wrap+2)

1. ✅ **All 6 operator decisions locked** — see Part 6 above
2. ⏳ **Readiness gate running** — 48h window, target clear 2026-04-17 evening
3. ⏳ **Exploration plan proposed** — `05-exploration-plan.md`, operator picks slice
4. **Session S1 (F1) starts** only after gate clears and F1 pre-plan is reviewed one final time with the locked decisions
5. **F1 audit pass** — qa-auditor review BEFORE merge to main
6. **F1 merges to main** only after audit pass
7. **Operator approves S2** — F2+F4 begin

### If operator wants changes:

- Changes to scope → revise F1 pre-plan, potentially revise ordering map
- Changes to readiness gate thresholds → revise gate framework
- Descope decision (skip F6, F10, etc.) → revise ordering map + total session count
- Delay Phase β entirely → park the planning docs, return when ready

### If a reality-check finding turns out wrong later:

- Re-run the specific Explore agent with a narrower query
- Update `02-reality-check-report.md` with new findings
- Revise F1 pre-plan if the dep in question was in F1's path
- Revise ordering map if the dep shift pushes a session later

---

## Part 8 — What's NOT in this plan

- **Phase γ (feature verticals).** Out of scope until β exits critical path. Graphify, charts, ads buyer, video, skill evolution all wait.
- **v7.5 skill evolution engine.** Blocked by the mandatory upstream-sweep directive. Will revisit after β.
- **v7.1 charts.** Depends on F3 signals, slots in after F3 but before F7.5.
- **Operator-level business decisions.** Does the operator actually want to trade? Does paper trading credibility require Polymarket specifically, or would S&P 500 equity be enough? These are product questions, not tech questions.
- **Post-v7.0 launch plans.** Multi-user, hosted, public API — all out of v7 scope entirely.

---

## Part 9 — File inventory

All planning artifacts live in `docs/planning/phase-beta/` — planning documents only, no source code changes:

```
docs/planning/phase-beta/
├── 01-readiness-framework.md     — the 5-dimension gate
├── 02-reality-check-report.md    — 3 agents' findings on 12 deps
├── 03-f1-preplan.md              — full F1 Data Layer session plan
├── 04-ordering-map.md            — parallelization + critical path
└── PHASE-BETA-PLAN.md            — this document (integrated read)
```

To move forward: operator reviews this document, answers Part 6 questions, and gives a green-light. At that point the F1 pre-plan gets finalized with the chosen decisions baked in, the readiness gate closes, and S1 starts.

Nothing in `src/` has been touched. No schema migrations have run. No services have been restarted. This commit is 100% planning documentation — reviewable via GitHub, mobile, or any markdown reader.
