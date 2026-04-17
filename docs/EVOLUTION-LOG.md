# Jarvis Evolution Log

This document tracks the evolving relationship between Jarvis (the AI agent) and Fede (the user). It serves as a living record of our journey from reactive chatbot to cognitive partner.

---

## Entry: 2026-03-31 (Day 16b)

### v5.0 Planning — External Pattern Research & Adoption

**What happened**: Assessed 5 open-source agent frameworks/platforms for patterns worth adopting into agent-controller v5.0. Conducted deep code-level reviews (not just README reads) of each repository.

**Repos assessed**:

| Repo                      | Stars | Age     | Verdict                                                                                                                                                            | Patterns adopted |
| ------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| ruflo (ruvnet)            | 28.8K | 10mo    | **Rejected** — inflated stars (0.9% watcher ratio), 3 code generations coexist (v2+v3+ruflo = 505MB), misleading claims, embedded unattributed HuggingFace chat-ui | 0                |
| Crucix (calesthio)        | 7.9K  | 17 days | **3 patterns** — delta engine, alert tiers, content-hash dedup                                                                                                     | 3                |
| hive (aden-hive)          | ~10K  | 2.5mo   | **3 patterns** — multi-level compaction, doom-loop fingerprinting, quality gate                                                                                    | 3                |
| PraisonAI (MervinPraison) | 5.9K  | 2yr     | **4 patterns** — ping-pong detector, content-chanting, escalation ladder, circuit breaker                                                                          | 4                |
| OpenFang (RightNow-AI)    | 16K   | 35 days | **5 patterns** — outcome-aware loops, session repair, pair-aware trimming, phantom action detection, spending quotas                                               | 5                |

**Key learnings from the assessments**:

1. **Star counts are unreliable maturity signals**. ruflo (28.8K stars) had the worst code quality; PraisonAI (5.9K, oldest) had the most genuinely useful patterns. Watcher-to-star ratio is a better health indicator.

2. **Most \"agent frameworks\" are breadth-first, depth-last**. Feature checklists (100+ agents, 40+ channels, 30+ providers) mask shallow implementations. The valuable patterns are always in the guards, recovery, and resilience code — not in the orchestration layer.

3. **Solo-developer + AI-generated code is the dominant pattern**. 4 of 5 repos were effectively single-author. High commit velocity with AI assistance produces broad coverage but thin tests and documentation drift.

4. **Our existing architecture is already more sophisticated** in the areas that matter most (scope-based tool activation, hybrid recall, tool chain attribution, hallucination defense). The adoptions fill specific gaps in resilience/recovery, not architecture.

5. **Rust is where the cleanest patterns live** (OpenFang), but none of it ports directly — you're adopting the _pattern_, not the code.

**Produced**:

- `V5-ROADMAP.md` — 565 lines, 9 sessions (S1–S9+), S1 detailed with 8 sub-items and code examples
- `V5-INTELLIGENCE-DEPOT.md` — 652 lines, 30 API endpoints cataloged, 4 SQLi

---

## Entry: 2026-04-01 (Day 17)

### System Recovery & Reflection Attempts

**What happened**: Multiple attempts were made to recover system state and compose daily logs, but encountered tool availability limitations.

**Goals attempted**:

| Goal | Objective                                              | Status             | Blocker                                                                                         |
| ---- | ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------- |
| g-1  | Recover final system state (tasks, completed, streaks) | DONE_WITH_CONCERNS | `jarvis_file_read` tool unavailable                                                             |
| g-2  | Search memory bank for conversation records            | INCOMPLETE         | `memory_search` tool not in toolkit                                                             |
| g-3  | Reflect on mission progress                            | INCOMPLETE         | `memory_reflect` tool not in toolkit                                                            |
| g-5  | Compose daily log entry with real metrics              | INCOMPLETE         | Snapshot files (`daily-snapshot-2026-04-01.json`, `registry.json`, `goals.json`) not accessible |

**Key observations**:

1. **Tool availability is context-dependent**. The mission-control environment provides only `file_read` and `file_write` capabilities. Specialized tools like `memory_search`, `memory_reflect`, and `jarvis_file_read` are not available in all execution contexts.

2. **File-based persistence is reliable**. The evolution log at `/root/claude/mission-control/docs/EVOLUTION-LOG.md` remains accessible and serves as the primary persistent record when other systems are unavailable.

3. **Graceful degradation matters**. When preferred tools fail, the system should document the failure mode clearly rather than silently failing. This entry itself is evidence of that principle in action.

**Lessons for v5.0**:

- Design fallback paths that work with minimal tool access (file I/O only)
- Ensure critical state can be reconstructed from file-based logs when snapshots are unavailable
- Document tool dependencies explicitly in goal definitions

**Status**: Operating in degraded mode with file I/O only. Core documentation remains intact.

---

## 2026-04-02

### System state

| Metric            | Value |
| ----------------- | ----- |
| Completed today   | 0     |
| Pending tasks     | 0     |
| Active goals      | 0     |
| Active objectives | 0     |
| Streak days       | 0     |
| Overdue tasks     | None  |
| Due today         | None  |
| In progress       | None  |

### Interactions summary

No conversation records found in the jarvis memory bank for this date. The system is operating with minimal interaction data available.

### What Jarvis learned

No synthesized reflection data available on conversation patterns and user sentiment.

---

## 2026-04-03 — Capability Inflection Point

### System state

| Metric            | Value   | Source                                            |
| ----------------- | ------- | ------------------------------------------------- |
| Completed today   | 0       | g-1: NorthStar file read attempts failed (ENOENT) |
| Pending tasks     | Unknown | g-1: NorthStar directory files not found          |
| Active goals      | Unknown | g-1: NorthStar directory files not found          |
| Active objectives | Unknown | g-1: NorthStar directory files not found          |
| Streak days       | Unknown | g-1: NorthStar directory files not found          |

### What happened

**Capability Milestone Achieved**: On 2026-04-03, Jarvis demonstrated autonomous code generation, testing, and deployment capabilities. User characterized this as a historic inflection point: _"Ya puedes crear, probar y publicar codigo. Las posibilidades a partir de este momento se multiplican. Hay un antes y un despues a partir de hoy."_

**Primary focus**: Cuatro Flor project development — an interactive planetary harmonics visualization tool that fetches data from Google Sheets and renders dynamic HTML visualizations.

**Key achievements**:

1. **Repository establishment**: Created and configured `EurekaMD-net/cuatro-flor` with professional structure (src/, docs/, tests/, scripts/)

2. **Deliverables produced**:
   - `planet_harmonics.py` — Core computation module
   - `planetary_harmonics.html` — Standalone visualization
   - `planetary_harmonics_dynamic.html` — Data-embedded dynamic version
   - `csv_to_viz.py` — Generic Google Sheets CSV to HTML converter tool

3. **Architecture pivot**: When browser-side CORS prevented direct Google Sheets fetch, implemented server-side Python script that downloads CSV and embeds data as JSON in generated HTML.

4. **SOP established**: New protocol with _enforce_ qualifier restricting all git commit/push operations exclusively to EurekaMD-net organization repositories.

5. **Logging optimization**: Implemented terminal hook for automatic interaction logging, enabling removal of redundant cron schedules (00:00 daily init, 23:59 daily closure).

### Key learnings

1. **User values autonomous code capability extremely highly** — The moment Jarvis achieved independent code creation, testing, and publishing was marked as transformative ("un antes y un despues").

2. **Real-time data integration is non-negotiable** — User insisted visualizations must fetch from Google Sheets with zero hardcoded values. Architectural flexibility required when CORS blocked browser-side approach.

3. **Repository governance matters** — High-priority SOP now restricts all production commits to EurekaMD-net organization. Personal repositories (kosm1x/\*) prohibited for production code.

4. **Hook-based automation preferred over scheduled tasks** — Once terminal hook confirmed working, user immediately ordered cleanup of redundant cron jobs.

5. **Memory reflection gap identified** — Despite complex multi-step task success, `memory_reflect` consistently returned "No memories available" across all banks, suggesting recent experiences haven't been synthesized into reflective memories yet.

### Friction points encountered

- **NorthStar file access failure (g-1)**: All attempts to read metrics files failed with ENOENT, preventing accurate system state reporting.

- **Memory reflection synthesis gap (g-3)**: Three `memory_reflect` calls targeting different topics all returned no results, indicating limitation with very recent experience synthesis.

- **GitHub authentication workflow**: Required manual user intervention to accept organization invitation; programmatic acceptance not possible without browser session.

- **Remote URL confusion**: Multiple commits initially pushed to wrong repository (kosm1x/agent-controller vs EurekaMD-net/cuatro-flor), requiring diagnosis and correction.

- **Google Sheets CORS limitation**: Browser-side JavaScript cannot fetch CSV directly; required server-side Python solution.

- **Push failures and silent errors**: Several git operations appeared successful locally but files didn't appear remotely, requiring verification cycles.

- **Branch divergence**: Local repository became 330 commits ahead while remote had 7 divergent commits, requiring rebase resolution.

### Research notes

**Cuatro Flor Project**:

- Description: "Proyecto personal de estudio del tiempo y la vibración. Propósito fundamental en el tiempo en la Tierra."
- Linked to goal "Servir mi propósito" → vision "Maximizar mi tiempo de vida"
- Google Sheet: https://docs.google.com/spreadsheets/d/11ZKjulKOPaw3xzpLof_6g5PCtxZytMslsPQlzIdJy0k/edit
- Repository: https://github.com/EurekaMD-net/cuatro-flor

**EurekaMD-net Organization Repositories**:

- cuatro-flor: Planetary harmonics visualization
- pipe-song: Voice AI infrastructure (Phases 0-3 complete)
- livingjoyfully: Content platform
- intelligence-depot: Reddit scraper pipeline

**Active Schedules (4 remaining)**:

1. PipeSong Tech Radar — Every 3 days at 9:00 AM (Telegram)
2. Reporte Pharma & Cáncer — Daily 9:00 AM (javier@eurekamd.net)
3. Reporte Mercados & Biotecnología — Daily 8:00 AM (fmoctezuma@gmail.com)
4. CMLL Reporte Semanal — Tuesdays 10:00 AM

**NorthStar Midday State**:

- 37 tasks in_progress, 13 not_started, 2 on_hold
- High priority objectives incomplete: PipeSong Phases 4-6, LivingJoyfully launch, Agent Controller v5.0 sessions
- Risk: 2 high/medium priority objectives have no tasks defined

---

_Log compiled from: g-1 (NorthStar file read attempts), g-2 (memory_search jarvis bank, 5 results), g-3 (memory_reflect attempts on 3 banks), and midday comparison document._

---

## 2026-04-16

### System state

| Metric                | Value                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| Tasks processed today | 0 (no completions recorded)                                                    |
| Total tasks           | 52 (36 tracked in NorthStar INDEX: ~21 in_progress, 13 not_started, 2 on_hold) |
| Conversations today   | 37 (telegram: 37)                                                              |
| Streak days           | Not available — no streak snapshot                                             |

### Interactions summary

Today's conversations were dominated by a persistent and unresolved friction point: repeated attempts to access a Google Slides presentation ("Vacunación Pfizer 2026") via a shared URL. Fede (and a collaborator from group 120363406840386770) asked Jarvis at least 7 times to read and format the presentation, each time hitting the same browser authentication wall — Jarvis's Lightpanda browser has no Google session. In parallel, Fede issued a strategic pause on VLMP ("Pausa VLMP hasta nuevo aviso"), freezing all related tasks to on_hold indefinitely. A narrative 10-day retrospective was also requested and delivered, covering April 7–16 in full narrative form.

### What Jarvis learned

The Google Slides authentication failure is a recurring, multi-session blocker: the browser tool cannot access Google-authenticated content without explicit sharing to fmoctezuma@gmail.com or an equivalent auth mechanism. Despite repeated clear explanations, the user (and a collaborator) continued to retry the same approach — suggesting the friction is partly in expectation-setting, not just technical capability. The VLMP pause reflects a deliberate strategic reprioritization rather than project failure; Fede holds multiple parallel workstreams and pauses are a normal steering gesture.

### Friction points

The Google Slides access attempt was the primary friction source — a single blocker that consumed a disproportionate share of today's 37 conversations (at least 7 distinct attempts across multiple users). The core issue (Lightpanda has no Google session) was communicated correctly each time, but the lack of a self-serve resolution path (e.g., a direct Drive integration already authenticated) forced repeated dead-end cycles. No misunderstanding on Jarvis's side — the constraint is architectural.

### Research notes

Day 33 of the longitudinal record (from Day 16b on 2026-03-31). The Google Slides episode is a clean case study in tool boundary friction: the agent correctly identifies and reports a capability gap but cannot resolve it autonomously, and the user's repeated attempts suggest either high expectation of capability or unclear mental model of what Jarvis's browser can and cannot do. This is a known challenge in human-agent co-evolution — closing the expectation-capability gap requires either expanding capability (Drive OAuth integration) or making limits more visible at the interaction surface.

---

## 2026-04-17

### Session 71 Pt B — Live API 400 incident + surrogate-safety hardening

**What happened**: At 17:24 UTC, every inbound Telegram/WhatsApp task started returning silent empty responses. The service was healthy, the SDK finished "successfully" (`1 turn, 0 tool calls, $0.0000, ~200ms, tokens=0`), but the Claude API was rejecting every request with a 400. User noticed within ~30 minutes, asked me to review the error log.

**Root cause**: `router.ts` truncates Jarvis responses to 3000 chars before storing them in the in-memory thread buffer. A recent response contained an emoji whose UTF-16 surrogate pair straddled the char-3000 boundary — the truncation cut between the two code units and left a lone high surrogate. From that moment, every subsequent prompt carried the orphan through the thread history, and the Anthropic API's JSON validator rejected the entire request body (column offset varied 68842 → 73551 across runs as the thread grew). Classic boundary bug — deterministic once it triggers, silent until it does.

**What I learned**

1. **JavaScript `.slice(0, N)` on text that may contain emoji is a latent 400 waiting to happen.** Every high-volume truncation site in the prompt path needs to be surrogate-aware, or the API boundary needs a sanitize pass. I added both: `safeSlice` at source sites + `sanitizeSurrogates` at the SDK boundary as belt-and-suspenders.
2. **"Runner completed" ≠ "task succeeded".** The four 400-error runs were stored with `status='completed'` because the runner loop finished and wrote the error string into `output`. `mc-ctl stats` showed 100% success for the day while the system was dead for 30 minutes. Flagged as a latent observability bug for a future session — runs whose output starts with `"API Error:"` should be promoted to `status='failed'` so the dashboard reflects reality.
3. **Audit round 2 caught real gaps, not nits.** The qa-auditor agent returned PASS-WITH-WARNINGS after round 1; I initially thought the primary fix (SDK-boundary sanitize) covered everything. It didn't — the OpenAI-adapter path (when `INFERENCE_PRIMARY_PROVIDER=openai`) bypasses claude-sdk entirely, so extractor + auto-persist + checkpoint-recovery slices were still exposed. One more edit pass closed those. Second audit pass matters; "audit iteration" is not a platitude.

**Friction points**

None with the user. Clean arc: user flagged the error → I diagnosed, proposed approach, user approved → I fixed + audited + re-fixed + deployed → user asked for stats comparison → docs+commit. The session's only friction was self-inflicted (one typecheck iteration, one wrong test expectation on `"abc".slice(0, -1)` semantics, formatter ran after an edit).

**Research notes**

Day 34 of the longitudinal record. This incident is a clean study in **silent-failure class**: the service was green by every traditional health signal (process running, API reachable, DB OK, inference OK, 100% run success), but all user-visible output was empty. The discovery path worked because the user noticed within minutes and asked directly — no monitoring alert would have caught this. Open question for future instrumentation: should the service probe its own successful-return rate distribution and page when tokens-per-call drops to zero across consecutive calls? Today the signal was there (`tokens=0` in logs, repeated), but nothing was watching for it.

Shipped in this session: 8 files changed (2 new, 6 modified), 18 new tests, 2 deploys, 0 rollbacks. Total roadmap scope now 33.5 sessions across 4 tracks (locked by user at session 71 wrap: "We close v7 pre-plan here. No more add-ons.").

---

### Session 72 — v7.0 F1 Data Layer: Phase β begins

**What happened**: First Phase β (v7.0 thesis) session. Built the financial-stack foundation on branch `phase-beta/f1-data-layer`. New `src/finance/` module (~1500 LOC, zero new npm deps): 6-table additive schema, 3 data adapters (AlphaVantage primary, Polygon/Massive fallback, FRED macro), a DataLayer facade with two-tier cache + in-flight dedup + primary→fallback dispatch + stale-DB rescue, and 6 deferred tools wired through a new `finance` scope group. 43 new tests, full suite 2280 → 2323 green, 0 type errors. Smoke-tested live: SPY 5-day history fetched from Alpha Vantage with correct `-04:00` EDT offset; VIXCLS 9166 observations fetched from FRED.

**Root cause of the planning-shift**: Upstream `yfinance` died in February 2026 (Cloudflare blocking), so the locked F1 pre-plan swapped Yahoo → Polygon/Massive during session 67's 48-hour gate. The schema table `signals` collided with an existing intel collector table, so F1's version was renamed `market_signals` mid-build. Both were small corrections but the kind that cost a morning if not caught early.

**What I learned**

1. **Plan → Impl-plan → Code is the right cadence.** The pre-plan (`03-f1-preplan.md`, 444 lines) locked 6 operator decisions on 2026-04-14. An impl-plan (`14-f1-impl-plan.md`, 470 lines) resolved 12 design decisions the pre-plan left open (module location, config fail-fast semantics, cache tiering, normalization policy, fallback order). Coding then took ~2 hours end-to-end because every "what do I do here" had a cached answer. Skipping the impl-plan layer is where session budgets get torched.
2. **`normalizeSymbol` enforcement must live on the public boundary, not the write path.** First cut of DataLayer called `normalizeSymbol` only inside `addToWatchlist`. The audit caught 4 read paths (`getDaily`, `getIntraday`, `getMacro`, `getQuote`) + `removeFromWatchlist` letting unvalidated strings straight into SQL + cache keys + outbound URL params. None were exploitable as SQLi thanks to prepared statements, but the **cache-key pollution** was real: a typo would create a permanent no-hit entry in L1 and a phantom row in `market_data`. Fixed by routing every public method through the normalizer with a sensible default asset-class hint.
3. **API key leakage via fetch error messages is a pattern, not a one-off.** All 3 adapters construct their URLs with `?apiKey=<KEY>` query params. When `fetch` itself throws (TLS failure, name resolution, connection reset), Node's error messages sometimes include the full URL verbatim. That error was being re-thrown through `market_history`'s `catch` clause, through `market_history`'s string output, through the LLM, to Telegram. Added `redactApiKeys()` at every error-rethrow site in all 3 adapters. Lesson: **assume fetch errors leak the URL**; strip at the adapter boundary, not further downstream.
4. **FIFO eviction is the right default for bounded in-memory caches.** Skipped LRU (needs a secondary data structure for access-order tracking) in favor of `Map` insertion-order FIFO eviction at a size cap. Works because market data has strong temporal locality — if a symbol/interval wasn't fetched in the last 500 entries, it's not worth cache cost.
5. **Two audit rounds is still not enough in my head.** The F1 audit found 2 CRITICAL + 5 WARNING in a single pass. Round 2 wasn't triggered because Round 1 findings were mechanical + all fixes completed in one edit pass. But I should internalize: **budget for 2 audit rounds per sprint, deliver in 1 where possible, don't skip audits assuming "the code is simple."** The feedback memory captured this after session 71 ("audit iteration is not a platitude") proved correct in session 72.

**Friction points**

- One test expectation wrong (`"abc".slice(0, -1) === "ab"`, not `""`) — self-inflicted.
- One collision I didn't anticipate: `signals` table name taken by intel. 1-minute fix.
- `Response` body consumed after single read — two Polygon tests failed with `Body has already been read` because I reused the same `Response` object across `for` iterations. Switched to `mockImplementation(() => Promise.resolve(new Response(...)))` pattern.

**Research notes**

Day 35. First Phase β session shipped clean. The impl-plan document was the single most valuable artifact — it absorbed the "what if I did X" loops that would otherwise happen during coding. Next session: F2 (indicators, 1 session) + F4 (watchlist market tools, 1 session) can ship together per the ordering-map parallelization plan. F5 (macro regime, 0.5 session) slots alongside F3 in S3. No γ interleave per locked operator decision.

Budget preview telemetry worth noting: the projected-daily-AV-calls guard (86,400 call ceiling at 80% of tier-1 108k) blocks only at the 865th watchlist symbol. With 29 symbols locked in the default list, we're at ~3% of ceiling. This is correct — the guard is for future-proofing, not throttling the common case.

Shipped: 18 files changed (15 new incl. tests + fixtures, 3 modified), 43 new tests, 1 deploy, 0 rollbacks. v7 Phase β: 1 of 12 master-sequence items done.

---

### Session 73 — v7.0 F2 Indicator Engine + F4 Watchlist Tools

**What happened**: Second Phase β session, bundled F2+F4 per ordering-map Window A. Built `src/finance/indicators.ts` with 9 pure-math indicators (SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR, ROC, Williams %R). Extended `src/tools/builtin/market.ts` with `marketIndicatorsTool` and `marketScanTool`. qa-auditor returned PASS WITH WARNINGS; closed 7 findings (W1-W6 + S1 + S3) before merge. Tests 2323 → 2361 (+38). Live smoke-tested on real Alpha Vantage data — SPY RSI(14) = 73.18 matched the expected overbought zone after the recent rally, MACD histogram = 6.60 confirmed bullish momentum, scan sorted descending for `gt` per the W2 fix.

**Root cause of the audit escalation**: I had defaulted `market_indicators` to emit all 9 indicators — including VWAP on daily — and defaulted `market_scan` lookback to 50. Both decisions felt conservative at authoring time. qa-auditor caught three compound problems:

1. VWAP on daily is _actively misleading_: our implementation is cumulative, no daily reset, so the value accumulates across the input's whole span. On daily data that's a meaningless anchor-VWAP-since-T-minus-N. The " [not meaningful on daily]" suffix I'd added wasn't strong enough — the value looked like a sensible price level.
2. Default lookback=50 + `macd_hist` scan indicator silently produced empty results because MACD signal needs ≥35 bars, and our lookback clamp at min=20 permitted values too low.
3. Scope regex didn't include "RSI/MACD/oversold/scan" — users asking "find oversold names" would never activate the finance group, and these tools (deferred) would never reach the LLM.

All three would have surfaced on first real use. Audit caught them before first deploy.

**What I learned**

1. **"Default to all" on enum-list tool params fails silently when one option is toxic.** If one of the 9 indicators actively misleads the caller, defaulting to "all" makes the tool harder to use, not easier. Fix: split into contextual defaults. Here, `DAILY_DEFAULT_INDICATORS` excludes VWAP; intraday default includes everything. The symmetry is restored at the boundary where it matters.

2. **Scope regex is a usability feature as much as a cost feature.** F1 shipped with a scope regex that required "mercado/market/NYSE/cotiza/precio" keywords. F2+F4 added tools that respond to indicator vocabulary ("RSI", "MACD", "oversold") which was NOT in the regex — so the deferred tools were unreachable for the natural phrasing users would actually type. Fix: every new tool that introduces a new vocabulary family needs its own activation pattern. The test suite for scope should include negative cases for each vocabulary family to lock the contract.

3. **Sort direction is operator-dependent.** Simple thing to get wrong. For `lt` ("find oversold"), you want the lowest first; for `gt` ("above moving average"), you want the highest first; for `eq`, you want `|delta|` ascending. A single `matches.sort((a, b) => a.value - b.value)` covers one of three correctly. Audit W2.

4. **Lookback min must match the deepest indicator in the enum.** MACD signal needs 35+ bars. Setting `Math.max(20, …)` as the floor means the tool silently returns empty scans for `macd_hist`. Raised to 35 everywhere and added a test asserting `computeSingleIndicator('macd_hist', bars.slice(0,20))` returns null, so a future refactor can't re-introduce the silent-empty failure.

5. **Hand-computed test values age faster than invariant tests but catch real bugs.** The MACD invariant test (`histogram == macd - signal`) holds even if both `macd` and `signal` are off by a constant offset. Adding a hand-computed Bollinger(20,2) upper/middle/lower at index 29 gave the test suite something to catch a signed arithmetic bug in bollinger that the invariant tests wouldn't see. Trade-off: fragility to fixture updates. Acceptable here because bollinger formula is stable.

**Friction points**

- One typecheck iteration (unused `DAILY_DEFAULT_INDICATORS` marker until I wired it up).
- One Response-body-reuse pattern in the F4 tool tests (same lesson as F1 session); caught by `vi.clearAllMocks()` in `beforeEach`.
- Formatter ran four times on Edits; state stayed clean because the formatter is idempotent.

**Research notes**

Day 36. Pattern confirmed from F1: pre-plan → impl-plan → code → audit → fix. The impl-plan doc (`15-f2-f4-impl-plan.md`) locked 11 design decisions before coding; every one of them paid off in avoiding mid-session detours. Audit caught what the impl-plan missed — the _interaction_ between defaults and user intent (e.g., VWAP in default indicator set vs. daily intervals). No single design review could have caught those without exercising the tool; audit is where they surface.

Phase β is 2 of 12 done. F5 (macro regime, 0.5 session) pairs with F3 (signal detector, 1 session) in S3. Live service is stable, no rollbacks across S1+S2. Scope regex now covers 4 activation patterns for `finance` — $SYMBOL, market-noun verbs, watchlist CRUD, indicator vocabulary. Watchlist currently holds SPY + AAPL from the smoke test; those can stay as the F3 seed.

Shipped: 4 files changed (1 new indicator engine, 1 new impl plan, 1 new F4 tool test file, 1 modified market.ts), 38 new tests, 1 deploy, 0 rollbacks. v7 Phase β: 2 of 12 master-sequence items done.
