# v7.1 Chart-Rendering Dependencies Reality Check

> **Exploration item:** F (Tier 2 from `05-exploration-plan.md`)
> **Run date:** 2026-04-14 session 67 wrap+4
> **Method:** Explore agent read `docs/V7-ROADMAP.md` v7.1 section + `reference_quantagent.md` memory + live checks against tradingview/lightweight-charts, Puppeteer changelog, playwright docs, QuantAgent GitHub
> **Purpose:** Preemptive dep check for v7.1 (chart rendering + vision chart patterns) even though it's 9+ sessions away. Catch rebrand-style surprises (like the Polygon→Massive finding from item C) before v7.1 pre-plan lands.

---

## Headline findings

1. **🟢 lightweight-charts is GREEN.** v5.0, Apache 2.0, 16% bundle size reduction, last commit 2026-04-13. Candlestick + MA/BB/VWAP overlays as first-class series. No 2026 breaking changes. Ship as-is.

2. **🟡 Puppeteer is YELLOW — chronic memory-leak + zombie-process issues in long-running services.** Feb 2026 Medium article documents 17 orphaned Chromium processes after a single mid-render crash. GitHub issues (2017-2026) confirm this is chronic, not recent. Requires 2-3 days of hardening (process pool manager, cgroup limits, forcible respawn) OR a swap to Playwright.

3. **🟢 Playwright is GREEN and already in our deps.** `@playwright/mcp` is already installed (v7.6 uses it for browser tools). Playwright's `screenshot()` handles headless Chrome PNG generation identically to Puppeteer with better lifecycle management. **Recommend swap: Puppeteer → Playwright.**

4. **🟢 QuantAgent is GREEN with scope note.** Y-Research-SBU/QuantAgent repo active, 4-agent LLM trading pipeline (Indicator → Pattern vision → Trend vision → Decision), uses LangGraph + TA-Lib. Paper pins no single vision model — works with Claude 3.5 Sonnet vision, Gemini, or GPT-4V. Last meaningful commit ~Jan 2026 (sporadic maintenance, but core algorithm is stable).

5. **🔴 F7 integration is RED — impedance mismatch caught early.** The V7 roadmap says chart-pattern recognition "registers as 6th signal layer in the alpha combination engine." But F7's `R(i,s)` matrix (locked in the F7 addendum) expects **continuous forward returns**. Chart patterns produce **discrete categorical labels** (head-and-shoulders, triangle, wedge, flag). These don't fit inside the 11-step pipeline without redesigning the return matrix. Three conversion paths all introduce information loss or break Step 3 normalization. **Recommendation: patterns go OUTSIDE F7, synthesized post-pipeline via RRF (Reciprocal Rank Fusion).** Requires updating V7-ROADMAP line 292 wording. Zero code impact on F7.

6. **Net impact on v7.1 estimate: neutral.** Puppeteer→Playwright swap costs +0.2 sessions (rewrite + tests), eliminates -0.5 sessions of Puppeteer hardening. Dropping chart-patterns-inside-F7 has zero impact because the 11-step pipeline wasn't designed for them. F7.5 (backtester) gains the chart-pattern integration via RRF as a post-F7 decision-synthesis layer.

7. **The F7 impedance mismatch is the kind of finding the exploration plan was built to catch.** If v7.1 pre-plan had landed without this check, we'd have been half-wired into F7 with chart patterns not fitting, then either forced F7 redesign (blocking F7 timeline) or late-stage scope descope. Catching it now costs zero code — just a wording fix in the roadmap.

---

## 1. TradingView lightweight-charts — 🟢 GREEN

| Attribute                        | Status                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| Current version                  | v5.0 (released 2026)                                       |
| License                          | Apache 2.0 (unchanged)                                     |
| Bundle size                      | 35 kB (-16% from v4)                                       |
| Last commit                      | 2026-04-13 (active maintenance)                            |
| 2026 breaking changes            | None reported                                              |
| Candlestick + indicator overlays | First-class series (MA, BB, VWAP supported)                |
| Headless rendering               | Canvas-based, Puppeteer/Playwright can screenshot directly |
| Server-side DOM issues           | None specific to this library                              |

**Verdict:** Ship as-is. No rework. v5.0 is a clean upgrade path from whatever the v7 spec assumed.

**Fixture suggestion for v7.1 tests:** capture a sample PNG of SPY with 50-day MA overlay + volume histogram, stash at `__fixtures__/lightweight-charts-spy.png`. Golden-file test asserts bit-level equality or pHash similarity.

---

## 2. Puppeteer — 🟡 YELLOW (critical caveats for long-running services)

| Attribute              | Status                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Current version        | v22.0.0+                                                                                                                      |
| Node 20/22 support     | Confirmed                                                                                                                     |
| 2026 breaking change   | Headless mode bifurcated — default routes to "new headless", old headless now `chrome-headless-shell` via `headless: 'shell'` |
| Long-running stability | **Chronic memory-leak + zombie process issues**                                                                               |
| Mitigation cost        | 2-3 days of hardening work for production                                                                                     |

### The production blocker

A Feb 2026 Medium article ("Puppeteer Memory Leaks, Crashes, and Zombie Processes — 6 months of screenshots in production") documents:

- **Orphaned Chromium processes accumulate on Node crashes.** Author found **17 zombie processes** after a single mid-render crash.
- Unbounded RAM consumption in long-running systemd services.
- No built-in cleanup in Puppeteer itself.
- GitHub issues from 2017-2026 confirm this is chronic, not a recent regression.

**Required mitigations if we stick with Puppeteer:**

1. `--disable-dev-shm-usage` Chrome flag (prevents `/dev/shm` exhaustion on Linux)
2. Explicit `browser.close()` in try/finally around every screenshot call
3. Wrap in a worker-pool manager (e.g., `piscina`) with per-worker lifecycle limits
4. Forcible respawn on crash (systemctl auto-restart + cgroup limits)
5. Active process monitoring (count `chrome` processes, alert if > threshold)

**Total hardening cost:** 2-3 days ≈ +0.5 sessions.

### Why this matters now

v7.1 is 9+ sessions away, but the memory-leak issues don't show up until production has been running for weeks. If v7.1 ships with raw Puppeteer, we won't discover the problem until after v7.4 is in flight. At that point, debugging a long-running service leak while Phase γ is shipping features is the worst possible time.

---

## 3. Playwright as Puppeteer replacement — 🟢 GREEN

**Already in our dependency tree.** `@playwright/mcp` is installed for our v7.6 browser tools. Playwright's `page.screenshot()` handles headless Chrome PNG generation identically to Puppeteer.

| Attribute                      | Puppeteer         | Playwright                |
| ------------------------------ | ----------------- | ------------------------- |
| Headless Chrome PNG            | ✅                | ✅                        |
| Weekly npm downloads           | ~4M               | ~7M                       |
| Long-running process stability | 🟡 chronic issues | 🟢 cleaner lifecycle      |
| Multi-browser                  | Chrome only       | Chrome + Firefox + WebKit |
| Single-page speed              | Faster (~10%)     | Slightly slower           |
| Already in our deps?           | No                | ✅ yes                    |
| Process management             | Manual            | Built-in pool             |

**Trade-off:** Playwright is ~10% slower on single-page automation. For a chart rendering pipeline executing <1 chart per second, this is negligible. F7 daily scans might render 20-30 charts per session. At 500ms each (worst case), that's 15 seconds — inside the scan's budget.

### Recommendation: swap Puppeteer → Playwright for the v7.1 PNG pipeline

**Cost:** +0.2 sessions for the rewrite + testing.
**Savings:** -0.5 sessions of Puppeteer production hardening.
**Net:** -0.3 sessions for v7.1 AND a more reliable runtime.

**Integration path:** we already call `@playwright/mcp` tools from `fast-runner.ts` for browser automation. v7.1 adds a `src/finance/chart-render.ts` module that spawns a headed Playwright instance for chart generation, holds it across multiple renders in the same session, and tears down cleanly on process exit. No new dependency — just a new module using an existing lib.

**Reuses v7.6 work:** the session 66 v7.6 gws CLI dispatch + browser tooling established our Playwright spawn/lifecycle pattern. v7.1 reuses that pattern for chart rendering.

---

## 4. QuantAgent (vision chart patterns) — 🟢 GREEN with scope note

| Attribute               | Status                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| Repo                    | `Y-Research-SBU/QuantAgent`                                                                 |
| Status                  | Active (sporadic maintenance, ~Jan 2026 last meaningful commit)                             |
| Architecture            | 4-agent LLM pipeline: Indicator → Pattern (vision) → Trend (vision) → Decision              |
| Stack                   | LangGraph + TA-Lib                                                                          |
| Vision model dependency | Model-agnostic — paper explicitly notes GPT-4V / Claude 3.5 Sonnet / Gemini Vision all work |
| Pattern classifier      | Head-and-shoulders, triangles, wedges, flags + custom patterns trainable                    |
| 2026 breaking changes   | None reported                                                                               |

**The pattern classifier produces discrete labels:**

- "head-and-shoulders identified, confidence 0.7"
- "ascending triangle, breakout imminent"
- "no pattern detected"

**This is discrete categorical output.** It does NOT fit into F7's `R(i,s)` continuous-return matrix.

**Recommendation:** adopt the 4-agent pipeline as a standalone signal producer that writes to a **new table** (`chart_patterns`) with `symbol`, `pattern_label`, `confidence`, `detected_at`. F7.5 or a post-F7 decision synthesis layer reads this table alongside F7's `MegaAlpha(t)` output and combines them via RRF (Reciprocal Rank Fusion).

### Why RRF, not direct integration

RRF (Reciprocal Rank Fusion) is the standard technique for combining heterogeneous scoring systems. It doesn't require continuous values — it ranks each system's outputs and combines ranks with a `1/(k+rank)` weighting. This is exactly how hybrid search combines BM25 (keyword) + vector (semantic) rankings.

**RRF for F7 + chart patterns:**

- F7 produces a ranked list of symbols by `MegaAlpha(t)` magnitude
- Chart patterns produce a ranked list of symbols by pattern-confidence × pattern-forward-return-historical
- Final decision synthesis: `rank_score(symbol) = Σ 1/(k + rank_i(symbol))` for each system
- k is a hyperparameter (typically 60)

**Where the F7 addendum said this:** the F7 addendum explicitly leaves "combination of discrete vs continuous signals" as out-of-scope. F7 handles homogeneous continuous signals; RRF handles cross-system combination.

**Where v7.1 lands in this flow:** v7.1 produces the chart_patterns data (the vision pipeline) but does NOT implement the RRF fusion. RRF lives in F7.5 (backtester) or a post-v7.5 decision-synthesis session.

---

## 5. F7 integration — 🔴 RED (caught early, zero code impact)

### The impedance mismatch

The V7 roadmap line 292 reads:

> Register as 6th signal layer in the alpha combination engine

**This wording is incorrect.** The alpha combination engine (F7) is the 11-step pipeline that assumes:

- `R(i,s)` is a continuous forward realized return
- `σ(i)` is a finite-variance statistic (Step 3)
- Step 4 normalization `Y = X/σ` requires non-zero variance
- Step 9 regression operates on numerical values

Chart patterns break ALL four assumptions. They produce:

- Discrete labels (not returns)
- Zero variance in periods with no pattern detected (undefined σ)
- No numerical scale (can't normalize a categorical)
- No meaningful regression target (β is undefined for categorical)

### Three conversion paths (all rejected)

**Path A: Pattern → confidence probability as pseudo-return.** E.g., 0.7 if head-and-shoulders detected with high confidence, 0 otherwise. **Rejected:** conflates pattern-classification confidence with forward-return predictability. A high-confidence head-and-shoulders is not the same thing as a high-probability profitable trade. IC would be meaningless because confidence is a classifier output, not a return prediction.

**Path B: Pattern as binary (1 if fired, 0 otherwise), compute R from realized forward return.** **Rejected:** most signals don't fire in most periods. The binary pattern signal would have σ ≈ 0 in low-firing regimes, breaking Step 3. F7's variance-based weighting becomes unstable.

**Path C: Pattern as separate 6th layer POST-F7 via RRF.** **Accepted.** Chart patterns are a ranked signal (by confidence × historical profitability of that pattern class). F7 produces its own ranked signal. RRF combines them. Neither system is polluted by the other's input shape.

### Action: update V7-ROADMAP wording

Change `docs/V7-ROADMAP.md` line 292 from:

> Register as 6th signal layer in the alpha combination engine

to:

> Synthesize as 6th layer in post-F7 decision ranking via RRF (Reciprocal Rank Fusion) — chart patterns are discrete categorical signals that do not fit inside the F7 11-step continuous-return pipeline

**This is a docs-only fix. Zero code impact.** Can ship now as part of the v7.1 pre-plan notes, or defer until v7.1 pre-plan itself. Deferring is fine because v7.1 is 9+ sessions away.

---

## 6. Revised v7.1 session estimate

| Component                                    | Original | Revised                                            | Delta               |
| -------------------------------------------- | -------- | -------------------------------------------------- | ------------------- |
| lightweight-charts integration               | 0.5      | 0.5                                                | 0                   |
| Puppeteer PNG pipeline → **Playwright swap** | 0.5      | **0.2** (swap cost) + **-0.5** (avoided hardening) | **-0.3**            |
| QuantAgent 4-agent vision pipeline           | 0.5      | 0.5                                                | 0                   |
| F7 integration (INSIDE 11-step)              | 0        | N/A (removed from scope)                           | 0                   |
| chart_patterns table + RRF stub              | 0        | 0.3 (new)                                          | +0.3                |
| **v7.1 total**                               | **1.5**  | **1.5**                                            | **0** (net neutral) |

**v7.1 stays at 1.5 sessions.** The Playwright swap saves enough Puppeteer hardening time to cover the chart_patterns RRF stub for F7.5 integration. No scope creep, no budget overrun.

---

## 7. Cross-references to Phase β planning docs

| Topic                                | Cross-reference                                        |
| ------------------------------------ | ------------------------------------------------------ |
| F7 `R(i,s)` continuous return matrix | `10-f7-addendum.md` Part 1                             |
| F7 signal_weights schema             | `10-f7-addendum.md` Part 3                             |
| RRF as cross-system combination      | Not yet documented — new pattern                       |
| Playwright already in deps           | `docs/PROJECT-STATUS.md` v7.6 gws CLI dispatch session |
| chart_patterns table                 | New — not yet in F1 schema, adds in v7.1 pre-plan      |

---

## 8. What this exploration item did NOT cover

- **Vision model cost.** Running Claude 3.5 Sonnet vision or GPT-4V on every daily chart render has a $ cost. Not measured here. v7.1 pre-plan must estimate.
- **Pattern classification accuracy.** The QuantAgent paper reports accuracy metrics; we didn't re-verify or validate against our own data. v7.1 pre-plan should include a validation pass.
- **PNG rendering performance at F7 scan time.** 20-30 charts × 500ms each is acceptable, but that assumption wasn't measured. v7.1 pre-plan should bench against a real watchlist-sized run.
- **Alternative to QuantAgent.** Are there other vision-based pattern classifiers worth considering (e.g., something backed by a bigger lab)? Not checked. v7.1 pre-plan should scan.

These are all v7.1-pre-plan concerns, not Phase β blockers. Flagged here for the v7.1 implementer to pick up.

---

## Summary

**v7.1 is greenlit for its eventual session** with two concrete updates:

1. **Swap Puppeteer → Playwright** in the PNG pipeline. Already in deps, better lifecycle management, saves 0.3 sessions net.
2. **Chart patterns synthesize via RRF post-F7**, not inside the 11-step pipeline. V7-ROADMAP line 292 wording fix pending (docs-only).

Neither change affects Phase β. Both are v7.1 scope adjustments that prevent mid-implementation rework at pre-plan time.

**The F7 impedance mismatch is the highest-value finding of this exploration item.** If we'd hit it during v7.1 implementation, the only options would have been (a) redesign F7 to support discrete signals (1.5+ sessions retroactive rework), or (b) late-stage scope descope. Catching it now costs zero code — just a wording fix.

**Tier 2 item F complete. v7.1 pre-plan inherits a clean starting point when its session comes.**
