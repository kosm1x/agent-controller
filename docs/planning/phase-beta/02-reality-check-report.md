# Phase β Reality-Check Report

> **Run date:** 2026-04-14 session 67 wrap+1
> **Agents:** 3 parallel Explore agents (market data, prediction markets, paper trading)
> **Purpose:** Verify every external dependency F1-F10 touches is still functional at the version we're building against, BEFORE committing to implementation.

---

## Summary table

| Dep                              | Phase  | Status | Cost             | v7 spec holds?                      | Action                                    |
| -------------------------------- | ------ | ------ | ---------------- | ----------------------------------- | ----------------------------------------- |
| Alpha Vantage Premium            | F1, F5 | 🟡     | **$49-$249/mo**  | Partial — premium is non-negotiable | Lock budget decision                      |
| Yahoo Finance fallback           | F1     | 🔴     | Free             | **NO — BROKEN**                     | **Replace with Polygon.io / IEX / stooq** |
| FRED API                         | F5     | 🟢     | Free             | Yes                                 | Proceed                                   |
| Polymarket API                   | F6     | 🟢     | Free             | Yes + upgraded (now DCM)            | Proceed — big win                         |
| Kalshi API                       | F6     | 🟢     | Free             | Yes + stronger                      | Proceed                                   |
| SEC EDGAR                        | F6     | 🟢     | Free             | Yes                                 | Proceed                                   |
| alternative.me Fear&Greed        | F6.5   | 🟡     | Free             | Partial — sentiment-alone lagging   | Pair with LunarCrush/Santiment            |
| CoinGlass (funding/liquidations) | F6.5   | 🟢     | Free tier + paid | Yes                                 | Proceed                                   |
| DefiLlama (stablecoin flows)     | F6.5   | 🟢     | Free             | Yes                                 | Proceed                                   |
| pm-trader MCP                    | F8     | 🟡     | Free             | Yes but with integration friction   | Adapt — Python subprocess via MCP stdio   |
| Binance WebSocket                | F10    | 🟢     | Free             | Yes                                 | Proceed (F10 is optional anyway)          |
| @modelcontextprotocol/sdk stdio  | F8     | 🟢     | —                | Yes                                 | Proceed                                   |

---

## Critical findings that change Phase β scope

### 1. Yahoo Finance fallback is dead — F1 scope MUST update

**What we assumed (v7 spec, Feb 2026):** Yahoo Finance via `yahoo-finance2` npm package as a zero-cost fallback when Alpha Vantage rate-limits or 5xx's.

**What we found:** The package is still maintained (v3.14.0 shipped March 2026, no CVEs), but Yahoo itself has been actively blocking scraping traffic since early 2026. Two open GitHub issues (#982 Jan, #985 Feb) report persistent 429 Too Many Requests from Yahoo endpoints. Yahoo provides no official API; `yahoo-finance2` relies on HTML scraping which carries zero TOS guarantees. Recent Cloudflare escalation makes this unsuitable for production.

**Decision required before F1:** Pick one of:

1. **Polygon.io free tier** — 5 req/min, 2-year historical, unofficial real-time via WebSocket free
2. **IEX Cloud paid** — $19-$49/mo, official, high reliability
3. **stooq.com** — unofficial but stable, historical only, no real-time
4. **Financial Modeling Prep** — 250 free req/day, fundamentals + indicators, lowest friction replacement
5. **Accept Alpha Vantage as the only source** — drop the fallback entirely, rely on AV Premium's SLA

**Recommendation:** **Financial Modeling Prep as F1 fallback**. Rationale: higher free quota than Polygon (250/day vs 5/min × 1440 = ~7200/day wait actually Polygon is higher… let me re-evaluate). Correction: Polygon 5/min = 7200/day is higher than FMP 250/day. **Recommendation flip: Polygon.io free tier** if we need real-time, **FMP** if we prefer fundamentals + macro on the same API as the primary.

**Impact:** F1 adapter code changes from `YahooFinanceAdapter` → `PolygonAdapter` or `FmpAdapter`. Schema unchanged (same shape). Golden-file tests need new fixture data matching the new source's response shape. **+0.2 sessions to F1 scope.**

---

### 2. Alpha Vantage Premium is a real operating cost — budget decision needed

**What we assumed:** "Alpha Vantage premium" was in the v7 spec without a price tag.

**What we found:** Premium pricing tiers:

- **$49.99/mo** — 75 req/min, no daily limit
- **$149.99/mo** — 300 req/min, no daily limit
- **$249.99/mo** — 1,200 req/min, no daily limit

Free tier is now 25 req/day — effectively useless for production. Macro endpoints (FEDERAL_FUNDS_RATE, TREASURY_YIELD, CPI, UNEMPLOYMENT, NONFARM_PAYROLL, REAL_GDP) all confirmed present. Time series (TIME_SERIES_DAILY_ADJUSTED, FX_DAILY) + NEWS_SENTIMENT all available. News sentiment confirmed on premium.

**Decision required:** Which tier? For a single-operator signal stack scanning a watchlist of 10-30 symbols + macro series, **$49.99/mo (75 req/min)** should be sufficient. Budget check: is this acceptable as v7.0's ongoing cost? Compare against Financial Modeling Prep's paid tier ($14-$69/mo) for lower cost with comparable coverage.

**Impact:** No code change, but an `api_call_budget` table column tracking AV consumption becomes load-bearing — we must not silently exceed the $49.99 tier's 75 req/min.

---

### 3. Polymarket is a BIG win — F6 can ship confidently

**What we assumed:** Polymarket API usable but with ongoing CFTC uncertainty from 2024-2025.

**What we found:** **Polymarket received CFTC Designated Contract Market (DCM) approval in November 2025**. US operations resumed January 2026. No longer geoblocked. The whale tracking use case (per-wallet trade history) is still queryable via public API. Some state-level restrictions apply (not all 50 states).

**Impact:** F6 scope is **strengthened, not weakened**. Prediction market integration can proceed against a legally-compliant, actively-operating platform. The regulatory risk that was a latent concern in the Feb 2026 spec is resolved.

---

### 4. pm-trader MCP exists and works — F8 scope needs a minor update

**What we assumed:** pm-trader MCP server with 29 tools, stdio transport.

**What we found (initial agent read):** Repo is `agent-next/polymarket-paper-trader`, v0.1.6 (March 2026 at time of first read), 234⭐, 26 tools claimed in README, actively maintained. **Python-based**, not TypeScript. Ships installable via `npx clawhub install polymarket-paper-trader` or direct pip install. SQLite (WAL mode) for state persistence. Supports buy → track → outcome thesis loop. Uses live Polymarket order books for realistic fills.

**Updated after hands-on dry-run (item B, see `07-pm-trader-dryrun.md`):** actual version is **v0.1.7** (shipped since the first read), actual tool count is **30** (4 more than the README: `get_tags`, `get_markets_by_tag`, `get_event`, `cancel_all_orders`). The repo is moving faster than README updates. Dry-run confirmed the MCP stdio protocol round-trip works end-to-end (spawn 2.5ms, initialize 661ms, tools/list 2.9ms, tools/call 68ms) and surfaced a real `--data-dir` propagation bug in the `mcp` subcommand — fixable via a `HOME` env var workaround.

**Impact:**

- v7 spec's "29 tools" claim was close — **actual is 30**, verified by the dry-run.
- Python vs TypeScript is a non-issue because MCP stdio transport means we spawn the server as a subprocess and communicate via JSON-RPC. The Python implementation is invisible to our TypeScript caller.
- **F8 scope holds**, estimate unchanged at 1.5 sessions — the dry-run confirmed the happy path plus surfaced one small integration quirk (HOME env var workaround, 5 LOC).

---

### 5. F6.5 sentiment needs a second source

**What we assumed:** alternative.me Fear & Greed Index as the single sentiment signal.

**What we found:** The index is alive and free, but 2026 readings have shown it's a lagging indicator — 46 consecutive days of "extreme fear" <25 in March 2026 while the market was choppy. The signal correlates with bottoms but doesn't give leading edge.

**Recommendation:** Pair alternative.me with one of:

- **LunarCrush** (paid) — social media sentiment aggregation
- **Santiment** (paid) — on-chain + social analytics
- **CoinMarketCap Fear & Greed** (free) — different methodology, gives a second reading

**Impact:** F6.5 scope grows slightly — instead of one adapter, we build two and blend. **+0.2 sessions to F6.5 (0.5 → 0.7 session).**

---

## Revised Phase β effort estimate

| Phase     | Original              | Revised                      | Delta                          |
| --------- | --------------------- | ---------------------------- | ------------------------------ |
| F1        | 1.5                   | **1.7**                      | +0.2 (Yahoo replacement)       |
| F2        | 1                     | 1                            | 0                              |
| F4        | 1                     | 1                            | 0                              |
| F5        | 0.5                   | 0.5                          | 0                              |
| F3        | 1                     | 1                            | 0                              |
| F6        | 1.5                   | 1.5                          | 0                              |
| F6.5      | 0.5                   | **0.7**                      | +0.2 (second sentiment source) |
| F7        | 2                     | 2                            | 0                              |
| F7.5      | 1                     | 1                            | 0                              |
| F8        | 1.5                   | 1.5                          | 0                              |
| F9        | 1                     | 1                            | 0                              |
| F10       | 1 (opt)               | 1 (opt)                      | 0                              |
| **Total** | **11 (7-8 parallel)** | **~11.4 (7.5-8.5 parallel)** | +0.4                           |

The reality check added 0.4 sessions to the estimate. Both adds are mechanical (new adapter module + new test fixture data). Neither requires a design change. **No scope cut is needed.**

---

## Monthly operating cost (new awareness)

| Line item                                       | Cost            | Optional?                             |
| ----------------------------------------------- | --------------- | ------------------------------------- |
| Alpha Vantage Premium (tier 1)                  | $49.99/mo       | No                                    |
| Polygon.io free tier (F1 fallback)              | $0              | Yes (or pay $29/mo for higher limits) |
| LunarCrush or Santiment (F6.5 second sentiment) | $20-$50/mo      | Yes (could defer)                     |
| **Baseline v7.0 operating cost**                | **~$50/mo**     | —                                     |
| **Plus optional enhancements**                  | **$70-$130/mo** | —                                     |

**Delta from v6.4 operating cost:** ~+$50/mo baseline for v7.0. Worth confirming with the operator before we lock this into the spec.

---

## What the reality check did NOT cover (known gaps)

- **v7.1 (charts)** — `lightweight-charts` + Puppeteer versions not checked. Defer until v7.1 pre-plan.
- **v7.2 (Graphify)** — Graphify MCP maintenance status not checked. Part of the v7.5 upstream sweep directive.
- **v7.3 P4 (ads)** — Meta Ads API + Google Ads API 2026 state not checked. Defer until v7.3 P4 pre-plan.
- **Operator-level business questions** — Does the operator want $50/mo ongoing cost? Does paper trading credibility actually need Polymarket, or would S&P 500 equity paper trading be enough? These are product decisions, not tech decisions.
