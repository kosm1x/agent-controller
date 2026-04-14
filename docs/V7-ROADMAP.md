# v7 Roadmap — Financial Intelligence + Feature Verticals

> Last updated: 2026-04-13 — **v7 pre-launch. v7.3 Phase 1 SEO/GEO shipped session 62. v7.8 Phase 1 autoreason lifts shipped session 63 (today). Rest planned across 3 tracks totaling ~25-27 sessions. Financial Stack critical path (v7.0) is the thesis and remains unstarted; v7.6-v7.8 infrastructure unblockers ship first.**

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Planned** — Scoped and sequenced
- **Conditional** — Gated on a future decision or prerequisite
- **Blocked** — Dependencies unresolved

---

## Execution Tiers

| Tier                  | Sessions  | Priority         | Rationale                                                                               |
| --------------------- | --------- | ---------------- | --------------------------------------------------------------------------------------- |
| A — Financial Stack   | F1–F10    | v7.0 thesis      | Detect, analyze, and alert on financial signals with paper-trading credibility          |
| B — Feature Verticals | v7.1–v7.5 | Layered on top   | Charts, knowledge graph, digital marketing (SEO+ads), video production, skill evolution |
| C — Infrastructure    | v7.6–v7.8 | Unblockers first | Workspace API coverage, MCP query surface, autoreason lifts from paper mining           |

**Ordering principle:** Tier C ships first because it unblocks downstream Tier A+B work. Tier A is the v7.0 thesis and ships on the critical path. Tier B verticals slot around Tier A where dependencies allow. Autoreason Phase 2 is a fixed-date decision (2026-04-20) independent of position.

---

## Execution Phases

| Phase | Scope                                  | Versions                              | Est. sessions |
| ----- | -------------------------------------- | ------------------------------------- | ------------- |
| α     | Infrastructure unblockers              | v7.6, v7.7, v7.8 P2                   | 2.5           |
| β     | Financial Stack critical path (v7.0)   | F1–F10                                | 11 (7-8 par.) |
| γ     | Feature verticals (v7.1–v7.5)          | v7.1, v7.2, v7.3 P2/P3/P4, v7.4, v7.5 | 12            |
| δ     | Autoreason post-decision (conditional) | v7.8 P3                               | 2             |

---

## v7.8 Phase 1 — Autoreason Lifts (CoT judges + k=2 + gap telemetry) — **Done**

> Session 63 (2026-04-13). Mined from NousResearch/autoreason paper. Deployed live; 2015→2026 tests.

| Item                                                                                                                           | Source                         | Status   |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | -------- |
| CoT rubric in reflector system prompt — structured step-by-step reasoning before JSON verdict                                  | autoreason §2, Appendix A.5    | **Done** |
| CoT rubric in per-goal self-assessor prompt — same pattern, per-criterion walk                                                 | autoreason §2                  | **Done** |
| `parseLLMJson` brace-scanning fallback — extracts last balanced `{...}` from CoT-prefixed output with string-literal awareness | autoreason adoption            | **Done** |
| k=2 stability rule for Prometheus `checkReplan` — soft votes require 2 consecutive before replan, hard votes fire immediately  | autoreason Table 23            | **Done** |
| `ReplanVote` severity discriminator — soft (tool failure rate, tool-calls-per-goal) vs hard (blocked-no-ready)                 | —                              | **Done** |
| Generation-evaluation gap telemetry — `reflector_gap_log` table + `src/db/reflector-gap.ts` helper, write-only                 | autoreason §7.10 central claim | **Done** |
| Tests: 11 new (JSON extractor × 5, reflector CoT + telemetry × 4, executor CoT × 1, k=2 orchestrator × 2, hard-stop × 1)       | —                              | **Done** |
| `error_max_turns` partial-text preservation in `claude-sdk.ts` — streaming text capture + DONE_WITH_CONCERNS annotation        | session 63 diagnose            | **Done** |

---

## v7.8 Phase 2 — Autoreason Tournament Feasibility Decision — **Planned** (fixed date 2026-04-20)

> Scheduled nudge `eb3e4b14` fires 9 AM CDMX on 2026-04-20 via Telegram. Decision rules in `project_autoreason_phase2_decision.md`.

| Item                                                                                                           | Source | Status      |
| -------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| Query `reflector_gap_log` over 7-day window — avg_gap, max_gap, wide_gap_count, llm_fallback_count             | —      | **Planned** |
| Apply decision rules: `avg_gap < 0.10` → close; `wide_gap_count > 10%` → targeted pilot; `>25%` → global pilot | —      | **Planned** |
| Verify k=2 stability rule actually fired (events `replan_deferred`); if zero, investigate before concluding    | —      | **Planned** |
| Update memory + decide whether v7.8 Phase 3 proceeds                                                           | —      | **Planned** |

---

## v7.8 Phase 3 — Autoreason Targeted Tournament Pilot — **Conditional**

> Only if 2026-04-20 data shows `wide_gap_count > 10%` on specific task classes. Not a global tournament — scoped to the classes with measurable gap.

| Item                                                                                                       | Source          | Status          |
| ---------------------------------------------------------------------------------------------------------- | --------------- | --------------- |
| Identify task classes with widest gap (briefings, proposals, research syntheses)                           | Phase 2 data    | **Conditional** |
| Build 3-candidate tournament (incumbent / adversarial revision / synthesis) for those classes only         | autoreason §2   | **Conditional** |
| Fresh-agent judge panel (3 judges, Borda aggregation, incumbent-wins-ties)                                 | autoreason §2.1 | **Conditional** |
| A/B compare tournament mode against current single-reflector path for 7 days, measure quality + cost delta | —               | **Conditional** |

---

## v7.6 — Workspace Expansion (gws CLI dispatch tool) — **Done**

> Infrastructure unblocker. Pre-plan: `project_v76_workspace_expansion.md`. Shipped 2026-04-14 (session 66), ~3 hours. First Tier C session complete.

| Item                                                                                                                                                                                          | Source                         | Status       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------ |
| Install `gws` v0.22.5 prebuilt linux-x86_64 binary (SHA256 verified) → `/usr/local/bin/gws`                                                                                                   | googleworkspace/cli            | **Done**     |
| Token plumbing — inject cached access token from `getAccessToken()` via `GOOGLE_WORKSPACE_CLI_TOKEN` env per exec, refresh before call                                                        | `src/google/auth.ts`           | **Done**     |
| New dispatch tool `google_workspace_cli({service, resource, method, params?, json?, page_all?, timeout_ms?})` — deferred, zod schema                                                          | v7.6 plan                      | **Done**     |
| Scope gating — added to `GOOGLE_TOOLS` array; google regex broadened to catch chat/tasks/forms/meet/classroom/keep/people/etc.                                                                | `src/messaging/scope.ts`       | **Done**     |
| Registered in `BuiltinToolSource` behind `GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN` env gate                                                                            | `src/tools/sources/builtin.ts` | **Done**     |
| Added to `WRITE_TOOLS` in fast-runner — classified write-capable because `method` accepts create/update/patch/delete                                                                          | `src/runners/fast-runner.ts`   | **Done**     |
| Error normalization — exit codes → `{ok, error, exitCode}`; token redaction on stderr/stdout                                                                                                  | —                              | **Done**     |
| NDJSON pagination parser + argv builder (dot-split nested resources); 2 MiB stdout cap + 30s default timeout                                                                                  | —                              | **Done**     |
| Tool description ~600 tokens with 4 canonical examples (chat/tasks/people/forms) + `--help` introspection pattern                                                                             | ACI principles                 | **Done**     |
| Tests: 12 mocked cases via `vi.hoisted()` — success/error/pagination/token-injection/timeout/unconfigured/refresh-fail/parse-fail/token-redaction/empty-field/empty-resource/argv-correctness | feedback_vitest_mocking        | **Done**     |
| **Hardening add-on**: closed `screenshot_element` SSRF gap (added `validateOutboundUrl()` call before `page.goto()`) + 2 new tests (file://, localhost)                                       | V7 Known Issues                | **Done**     |
| Live smoke test: real `tasks.tasklists.list` call via compiled `BuiltinToolSource` against Google Tasks API — returned "My Tasks" tasklist                                                    | —                              | **Done**     |
| DEFERRED to v7.6.1 follow-up: full `@playwright/mcp` ToolSource wrapper (larger architectural change, separate session)                                                                       | V7 Known Issues                | **Deferred** |
| Steal: timezone-from-Calendar-Settings-API pattern → `google-calendar.ts` (independent lift)                                                                                                  | gws architecture               | **Deferred** |

---

## v7.7 — Jarvis MCP Server (read-only) — **Done**

> Infrastructure unblocker. Pre-plan: `project_v77_jarvis_mcp_server.md`. Shipped 2026-04-14 (session 67), ~3 hours. Second Tier C session complete. Phase α items 1 and 2 both done; autoreason Phase 2 decision (2026-04-20) is the remaining Phase α item.

| Item                                                                                                                                                            | Source                             | Status   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------- |
| `@modelcontextprotocol/sdk` native Hono transport via `WebStandardStreamableHTTPServerTransport.handleRequest(c.req.raw)` — stateless                           | MCP SDK docs                       | **Done** |
| Bearer-token auth + `mcp_tokens` table (SHA-256 hashed) with CHECK-constrained `scope='read_only'`                                                              | `src/api/mcp-server/auth.ts`       | **Done** |
| Sliding-window rate limiter (100 req/min per token) installed after auth middleware                                                                             | `src/api/mcp-server/rate-limit.ts` | **Done** |
| Audit logging: every request writes `events` row with `category='mcp_call'`, `type=request_received/completed/failed`                                           | `src/api/mcp-server/audit.ts`      | **Done** |
| Tool: `jarvis_status` — live pid, uptime, memMB, task counts by status, memory backend + health                                                                 | —                                  | **Done** |
| Tool: `jarvis_task_list` — filters by status, since, limit (max 100)                                                                                            | —                                  | **Done** |
| Tool: `jarvis_task_detail` — full record + subtasks for a task_id                                                                                               | —                                  | **Done** |
| Tool: `jarvis_memory_query` — delegates to `MemoryService.recall()` with bank/tags/limit                                                                        | —                                  | **Done** |
| Tool: `jarvis_schedule_list` — active scheduled tasks + cron + delivery + last_run_at                                                                           | —                                  | **Done** |
| Tool: `jarvis_recent_events` — events in last N hours with category/type filters (max 500 rows, 168h window)                                                    | —                                  | **Done** |
| Tool: `jarvis_reflector_gap_stats` — autoreason gap telemetry aggregation + decisionHint for 2026-04-20 Phase 2 review                                          | v7.8 P1                            | **Done** |
| Tool: `jarvis_feedback_search` — substring grep over memory `feedback_*.md` files with snippet + match count                                                    | —                                  | **Done** |
| CLI: `./mc-ctl mcp-token <create\|list\|revoke>` — bearer generation via openssl, SHA-256 hashed store, token shown exactly once                                | `mc-ctl`                           | **Done** |
| Conditional mount gated on `JARVIS_MCP_ENABLED=true` (deployed via systemd drop-in `/etc/systemd/system/mission-control.service.d/mcp.conf`)                    | `src/api/index.ts`                 | **Done** |
| Tests: auth × 6, rate-limit × 4, feedback-grep × 7, tools × 12 = **29 new tests**                                                                               | —                                  | **Done** |
| Live smoke test: real curl to `/mcp/health` + `tools/list` + `jarvis_status` + `jarvis_reflector_gap_stats` + `jarvis_task_list` + rate-limit 429 after 100 req | —                                  | **Done** |

---

## v7.0 F1 — Data Layer (Alpha Vantage + Yahoo Fallback) — **Planned**

> Critical path start. 1.5 sessions. Technical reference below.

| Item                                                                                             | Source       | Status      |
| ------------------------------------------------------------------------------------------------ | ------------ | ----------- |
| 6-table schema: market_data, watchlist, backtest_results, trade_theses, api_call_budget, signals | V7 spec      | **Planned** |
| Alpha Vantage premium adapter — adjusted daily, FX, macro, news sentiment                        | V7 spec      | **Planned** |
| Yahoo Finance fallback adapter                                                                   | V7 spec      | **Planned** |
| Data validation layer (H2) — sanity checks, missing-bar detection, corrupted-row rejection       | V7 hardening | **Planned** |
| Timezone normalization (H3) — all timestamps to NY market time, DST-aware                        | V7 hardening | **Planned** |
| api_call_budget tracking + per-service rate limits                                               | V7 spec      | **Planned** |
| Gold via GLD ETF proxy                                                                           | V7 spec      | **Planned** |

---

## v7.0 F2 — Indicator Engine — **Planned**

> 1 session. Depends on F1.

| Item                                                                                      | Source       | Status      |
| ----------------------------------------------------------------------------------------- | ------------ | ----------- |
| Pure-math indicators: SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR, ROC, Williams %R         | V7 spec      | **Planned** |
| Golden-file tests (H1) — validate each indicator against Alpha Vantage server-side values | V7 hardening | **Planned** |

---

## v7.0 F4 — Watchlist + Market Tools — **Planned**

> 1 session. Parallel to F2. Depends on F1.

| Item                                                 | Source  | Status      |
| ---------------------------------------------------- | ------- | ----------- |
| Watchlist management (add/remove/list/tag)           | V7 spec | **Planned** |
| `market_quote` tool — current snapshot               | V7 spec | **Planned** |
| `market_history` tool — historical bars with filters | V7 spec | **Planned** |

---

## v7.0 F5 — Macro Regime Detection — **Planned**

> 0.5 sessions. Parallel to F2/F4. TypeScript fetch only, no Python sidecar.

| Item                                                                             | Source  | Status      |
| -------------------------------------------------------------------------------- | ------- | ----------- |
| Alpha Vantage macro pulls — fed funds, treasury, CPI, unemployment, payroll, GDP | V7 spec | **Planned** |
| FRED REST API — VIX, ICSA, M2                                                    | V7 spec | **Planned** |
| Regime classifier — bull/bear/volatile/calm based on composite macro + VIX       | V7 spec | **Planned** |

---

## v7.0 F3 — Signal Detector — **Planned**

> 1 session. Depends on F2 + F4.

| Item                                                                                                           | Source  | Status      |
| -------------------------------------------------------------------------------------------------------------- | ------- | ----------- |
| Signal detector: MA crossover, RSI extremes, MACD crossover, Bollinger breakout, volume spike, price threshold | V7 spec | **Planned** |
| Composite signal logic (combine N indicators)                                                                  | V7 spec | **Planned** |
| `market_signals` tool                                                                                          | V7 spec | **Planned** |
| Transmission chain field — signal → decision → outcome linkage                                                 | V7 spec | **Planned** |

---

## v7.0 F6 — Prediction Markets + Whale Tracker — **Planned**

> 1.5 sessions. No F-series dependencies, can run in parallel with F3.

| Item                                                                 | Source  | Status      |
| -------------------------------------------------------------------- | ------- | ----------- |
| Polymarket API adapter — live market odds, volume, resolution        | V7 spec | **Planned** |
| Kalshi API adapter — regulated US prediction markets                 | V7 spec | **Planned** |
| Whale tracker — Polymarket trade history + SEC EDGAR insider filings | V7 spec | **Planned** |

---

## v7.0 F6.5 — Sentiment Signals — **Planned**

> 0.5 sessions. No dependencies, parallel.

| Item                                               | Source  | Status      |
| -------------------------------------------------- | ------- | ----------- |
| Fear & Greed Index (alternative.me API)            | V7 spec | **Planned** |
| Crypto funding rates (long/short leverage balance) | V7 spec | **Planned** |
| Liquidation heatmaps (forced selling cascades)     | V7 spec | **Planned** |
| Stablecoin flows (money entering/leaving crypto)   | V7 spec | **Planned** |

---

## v7.0 F7 — Alpha Combination Engine — **Planned**

> 2 sessions. Depends on F3 + F5 + F6 + F6.5. See `V7-ALPHA-COMBINATION-EQUATIONS.md` for the 11-step spec.

| Item                                                                                              | Source  | Status      |
| ------------------------------------------------------------------------------------------------- | ------- | ----------- |
| 11-step combination pipeline — ingredient scoring → layer weights → aggregation → decision output | V7 spec | **Planned** |
| Signal evolution tracking — how signal quality changes over time                                  | V7 spec | **Planned** |
| ISQ (Ingredient Signal Quality) dimensions                                                        | V7 spec | **Planned** |
| Per-layer freshness gates                                                                         | V7 spec | **Planned** |
| Weight versioning                                                                                 | V7 spec | **Planned** |
| Minimum signal threshold                                                                          | V7 spec | **Planned** |

---

## v7.0 F7.5 — Strategy Backtester — **Planned**

> 1 session. Depends on F7.

| Item                                                                                               | Source  | Status      |
| -------------------------------------------------------------------------------------------------- | ------- | ----------- |
| Walk-forward validation — train months 1-6, test month 7, roll forward                             | V7 spec | **Planned** |
| Stress test scenarios (2008, 2020, rate shock, credit crisis, liquidity dry-up)                    | V7 spec | **Planned** |
| `backtest_results` table — per-strategy win rate, Sharpe, max drawdown, regime-conditional metrics | V7 spec | **Planned** |

---

## v7.0 F8 — Paper Trading (pm-trader MCP) — **Planned**

> 1.5 sessions. Depends on F7.5.

| Item                                                                               | Source  | Status      |
| ---------------------------------------------------------------------------------- | ------- | ----------- |
| pm-trader MCP server integration (29 tools, stdio)                                 | V7 spec | **Planned** |
| `trade_theses` table — thesis → trade → outcome commitment tracking                | V7 spec | **Planned** |
| Transaction cost model (H5) — slippage, spread, commission                         | V7 spec | **Planned** |
| Shadow portfolio — validates before user-facing alerts                             | V7 spec | **Planned** |
| Replication scoring — am I trading like the winners? (Polymarket whale comparison) | V7 spec | **Planned** |

---

## v7.0 F9 — Morning/EOD Scan Rituals — **Planned**

> 1 session. Depends on F8 + F4. Last on the critical path — needs track record from paper trading.

| Item                                                                              | Source  | Status      |
| --------------------------------------------------------------------------------- | ------- | ----------- |
| Morning scan ritual — pre-market signals + macro regime + overnight news          | V7 spec | **Planned** |
| EOD scan ritual — close-price signals + day's trade performance + next-day setup  | V7 spec | **Planned** |
| Market calendar (H4) — NYSE/NASDAQ holidays, half-days, early close               | V7 spec | **Planned** |
| Dynamic alert budget — per-day token/cost cap, degrades gracefully when exhausted | V7 spec | **Planned** |

---

## v7.0 F10 — Real-Time Crypto WebSocket — **Planned** (optional)

> 1 session. Parallel from F3. Optional — defer if not needed at v7.0 launch.

| Item                                                            | Source  | Status      |
| --------------------------------------------------------------- | ------- | ----------- |
| Binance WebSocket adapter — tick-level BTC/ETH/SOL/etc.         | V7 spec | **Planned** |
| Real-time signal dispatch (bypass polling for crypto watchlist) | V7 spec | **Planned** |

---

## v7.1 — Chart Rendering + Vision Chart Patterns — **Planned**

> 1.5 sessions. Depends on F3 (needs signal data to render). Reference: `reference_quantagent.md`.

| Item                                                                                               | Source     | Status      |
| -------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| TradingView lightweight-charts + Puppeteer → PNG pipeline                                          | V7 spec    | **Planned** |
| Candlestick + indicator overlays + signal markers                                                  | V7 spec    | **Planned** |
| Vision chart pattern recognition — 4-agent pipeline (head-and-shoulders, triangles, wedges, flags) | quantagent | **Planned** |
| Register as 6th signal layer in the alpha combination engine                                       | V7 spec    | **Planned** |

---

## v7.2 — Knowledge Graph (Graphify MCP) — **Planned**

> 1.5 sessions. No v7 dependencies, can run anytime. Reference: `reference_graphify.md`.

| Item                                                                                    | Source         | Status      |
| --------------------------------------------------------------------------------------- | -------------- | ----------- |
| Graphify MCP integration — code + docs + media knowledge graph                          | graphify       | **Planned** |
| CRM entity graph — prospects, deals, conversations, decision-makers                     | graphify + CRM | **Planned** |
| Codebase graph — source files, functions, call chains, test coverage                    | graphify       | **Planned** |
| Cross-source queries — "which prospects connect to which deals via which conversations" | graphify       | **Planned** |

---

## v7.3 Phase 1 — SEO/GEO Tool Suite — **Done**

> Session 62 (2026-04-12). Adapted from nowork-studio/toprank. 5 tools, ~2750 LOC, zero new deps.

| Item                                                                                                              | Source     | Status   |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| `seo_page_audit` — rubric-scored URL audit (parses Jina markdown for title/meta/headings/schema/images/content)   | toprank    | **Done** |
| `seo_keyword_research` — SERP via webSearchTool + LLM extraction + intent/GEO classification + Jaccard clustering | toprank    | **Done** |
| `seo_meta_generate` — 3-variant LLM generation for title/meta/OG/Twitter with char-limit validation               | toprank    | **Done** |
| `seo_schema_generate` — JSON-LD templates for Article/FAQPage/HowTo/Product/LocalBusiness/BreadcrumbList          | schema.org | **Done** |
| `seo_content_brief` — E-E-A-T outline generator with GEO tactics                                                  | toprank    | **Done** |
| `seo_audits` table — persisted audit history                                                                      | —          | **Done** |
| `seo` scope group — wired into classifier                                                                         | scope.ts   | **Done** |
| Reference libraries (intent taxonomy, GEO signals, meta formulas, schema templates, E-E-A-T framework)            | —          | **Done** |

---

## v7.3 Phase 2 — SEO Telemetry (PageSpeed Insights + Search Console) — **Planned**

> 1 session. Depends on v7.6 (uses gws OAuth/Discovery pattern for Search Console).

| Item                                                                              | Source  | Status      |
| --------------------------------------------------------------------------------- | ------- | ----------- |
| PageSpeed Insights adapter — Core Web Vitals, Lighthouse scores, mobile/desktop   | PSI API | **Planned** |
| Google Search Console adapter — clicks, impressions, CTR, position per query/page | GSC API | **Planned** |
| Reuse v7.6 gws pattern if GSC surfaces via Discovery; native adapter if not       | v7.6    | **Planned** |
| `seo_telemetry` tool — query-level performance + alerting on regressions          | —       | **Planned** |

---

## v7.3 Phase 3 — AI Overview Monitoring — **Planned**

> 1 session. Depends on F1 schedule infrastructure. The GEO differentiator toprank lacks.

| Item                                                                                       | Source | Status      |
| ------------------------------------------------------------------------------------------ | ------ | ----------- |
| Scheduled job — runs tracked queries via SERP API, detects AI overview presence            | —      | **Planned** |
| AI overview attribution tracking — which sources cited, rank position, over-time evolution | —      | **Planned** |
| `ai_overview_tracking` table — time-series of query → presence + sources                   | —      | **Planned** |
| Alert on attribution loss or competitor displacement                                       | —      | **Planned** |

---

## v7.3 Phase 4 — Digital Marketing Buyer (claude-ads + Meta/Google Ads) — **Planned**

> 3 sessions. No F-series dependencies, independent. Reference: `reference_claude_ads.md`.

| Item                                                                            | Source     | Status      |
| ------------------------------------------------------------------------------- | ---------- | ----------- |
| Audit scoring framework (225 checks, 7 platforms) from claude-ads               | claude-ads | **Planned** |
| Brand DNA + creative framework system                                           | claude-ads | **Planned** |
| Meta Ads API client — campaign CRUD, audience targeting, creative upload        | Meta Graph | **Planned** |
| Google Ads API client — campaign CRUD, keywords, bid strategies                 | Google Ads | **Planned** |
| Bid management — budget allocation, dayparting, auto-pause                      | —          | **Planned** |
| CRM attribution — ad click → lead → opportunity → close linkage via agentic-crm | CRM        | **Planned** |

---

## v7.4 — Video Production — **Planned**

> 2 sessions. Depends on v7.3 Phase 4 (feeds marketing content). Reference: `reference_open_higgsfield.md`.

| Item                                                         | Source          | Status      |
| ------------------------------------------------------------ | --------------- | ----------- |
| AI asset generation pipeline (higgsfield 200+ model catalog) | open-higgsfield | **Planned** |
| Storyboard pipeline — script → scene list → asset requests   | —               | **Planned** |
| Lip sync for talking-head generation                         | open-higgsfield | **Planned** |
| Cinema prompts library                                       | open-higgsfield | **Planned** |

---

## v7.5 — Skill Evolution Engine (GEPA + SkillClaw) — **Planned**

> 2 sessions. Depends on F9 (needs production trace data). References: `reference_gepa.md`, `reference_skillclaw.md`, `feedback_phantom_evolution_engine.md`.
>
> **MANDATORY PRE-PLAN TASK (NO SKIP):** Before any v7.5 implementation starts, run the full upstream sweep per `memory/feedback_v75_upstream_sweep_directive.md`. Budget: ~4 hours as its own half-day session. Scope: 48+ `reference_*.md` files with 10 core skill-evolution references read in depth (GEPA, SkillClaw, Hyperagents, Hermes, ACE, Memoria, claude-mem, mempalace, Superpowers, context-engineering). The sweep findings shape v7.5 scope — without it the skill-evolution engine is built against stale reference material from months earlier. Launch with parallel `Agent subagent_type=Explore` calls for the 10 core repos. Do NOT start coding v7.5 until every reference file has a "last reviewed" date within the current week AND Tier 1 findings are folded into the scope table below.

| Item                                                                                                       | Source                                     | Status      |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| **Pre-plan: bulk upstream sweep (48 refs, ~4h)**                                                           | `feedback_v75_upstream_sweep_directive.md` | **Blocker** |
| Reflective mutation from execution traces — extract corrections, propose minimal config deltas             | GEPA + Phantom evolution                   | **Planned** |
| ASI (Ablation Signal Intensity) diagnostics — which parts of the prompt are load-bearing                   | GEPA                                       | **Planned** |
| Pareto domain specialization — separate skill variants per task class                                      | GEPA                                       | **Planned** |
| Failure source classification (skill / agent / env) — SkillClaw pattern                                    | SkillClaw                                  | **Planned** |
| Session trajectory structuring — logged corrections promoted to golden suite                               | SkillClaw + Phantom                        | **Planned** |
| Conservative editing principles — append-first, minimal replace, no remove of safety keywords              | Phantom constitution                       | **Planned** |
| Monotonic validation — 5-gate taxonomy (constitution/regression/size/drift/safety) with fail-closed safety | Phantom evolution                          | **Planned** |
| Triple-judge minority veto for safety-critical gates                                                       | Phantom judges                             | **Planned** |
| Daily cost cap + heuristic fallback when budget exhausted                                                  | Phantom engine                             | **Planned** |
| Upgrade overnight tuning loop to use the evolution engine                                                  | V7 spec                                    | **Planned** |

---

## Dependency Graph

```
INFRASTRUCTURE UNBLOCKERS (Tier C — phase α, first)
  v7.6 Workspace (gws) ──┐
  v7.7 Jarvis MCP ───────┤
  v7.8 P2 decision ──────┘
                         │
FINANCIAL STACK (Tier A — phase β, critical path)
  F1 (data layer) ──┬── F2 (indicators) ────┐
                    ├── F4 (watchlist) ─────┤
                    ├── F5 (macro) ─────────┤
                    │                       F3 (signal detector)
                    │                              │
                    F6 (prediction markets) ──────┤
                    F6.5 (sentiment) ─────────────┤
                                                   │
                                            F7 (alpha combination)
                                                   │
                                            F7.5 (backtester)
                                                   │
                                            F8 (paper trading)
                                                   │
                                        F9 (scan rituals)
                                                   │
                                            F10 (crypto WS, parallel from F3)

FEATURE VERTICALS (Tier B — phase γ, layered on top)
  v7.2 Graphify ────────────── independent
  v7.1 Charts + vision ──────── after F3
  v7.3 P2 SEO telemetry ─────── after v7.6
  v7.3 P3 AI overview monitor ─ after F1 schedule infra
  v7.3 P4 Ads buyer ──────────── independent
  v7.4 Video production ──────── after v7.3 P4
  v7.5 GEPA + SkillClaw ──────── after F9 (needs trace data)

AUTOREASON (Tier C continued — phase δ, conditional)
  v7.8 P3 tournament pilot ───── only if 2026-04-20 data says yes
```

---

## Execution Invariants

1. Tier C (infrastructure) ships FIRST to unblock downstream work
2. F-series is the v7.0 thesis — no feature vertical substitutes for shipping the Financial Stack
3. Autoreason Phase 2 decision is FIXED DATE (2026-04-20) regardless of position
4. New tools default to `deferred: true` (v6.0 hardening invariant carries forward)
5. Pre-plans are drafted at session start, not upfront (avoids stale speculation)
6. Jarvis CANNOT push to `main` — branches + PRs only (v6.0 invariant carries forward)
7. Jarvis CANNOT modify the immutable core — SG3 still enforced (v6.0 invariant)
8. Every new table additive (IF NOT EXISTS) — never reset mc.db without explicit approval

---

## Deferred / Deliberately Skipped

| Capability                                     | Why deferred                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| TimesFM forecasting (Python sidecar)           | Post-v7.0 launch — no sidecar in v7 by design                                |
| Multi-account support for gws                  | Single-operator only in v7.6                                                 |
| Write tools on Jarvis MCP server               | v7.7 is read-only; writes stay on existing channels                          |
| Dynamic MCP tool creation at runtime           | Incompatible with deferral/scope/hallucination guard stack                   |
| Full Phantom self-evolution in production      | Self-mutation too risky for load-bearing Telegram/WhatsApp prompts           |
| Docker-socket-mount autonomous containers      | Hard security blocker on shared VPS                                          |
| SocratiCode integration                        | Repo scale (≤500K LOC) below where hybrid BM25+dense beats grep meaningfully |
| Dochkina self-organizing agents                | Paper validates existing Prometheus sequential-hybrid; no action needed      |
| Tournament architecture (unless autoreason P2) | Paper's Sonnet 4.6 lift not statistically significant; wait for our data     |
| Mock-first testing on critical paths           | Integration tests preferred (v5 hardening carries forward)                   |

---

## Metrics (target at v7.0 launch)

| Metric                        | v6.4 (current) | v7.0 target                 | v7-full target |
| ----------------------------- | -------------- | --------------------------- | -------------- |
| Tests                         | 2026           | ~2300                       | ~2800          |
| Source files                  | 255+           | ~290                        | ~340           |
| Tools                         | 179            | ~195                        | ~230           |
| Tables (SQLite)               | ~45            | ~51 (+6 F1)                 | ~58            |
| Rituals                       | 11             | 13 (+morning/EOD)           | 14             |
| Scheduled tasks infra         | existing       | dynamic budget              | dynamic budget |
| Alpha Vantage premium         | set            | in use                      | in use         |
| Signal layers                 | 0              | 5 (F3+F5+F6+F6.5+composite) | 6 (+vision)    |
| Paper trading track record    | none           | 30+ days                    | 90+ days       |
| MCP server tools exposed      | 0              | 8 (v7.7)                    | 8+             |
| Google API coverage via gws   | 0              | 25+ services                | 25+            |
| Reflector gap logged sessions | 0              | ~100                        | ~1000          |

---

## Total Effort

| Version           | Theme                                          | Sessions | Status            |
| ----------------- | ---------------------------------------------- | -------- | ----------------- |
| v7.8 P1           | Autoreason lifts (CoT+k=2+gap telemetry)       | 1        | **Done**          |
| v7.3 P1           | SEO/GEO tool suite                             | 1        | **Done**          |
| v7.6              | Workspace expansion (gws)                      | 1        | **Planned**       |
| v7.7              | Jarvis MCP server                              | 1        | **Planned**       |
| v7.8 P2           | Autoreason tournament decision (fixed date)    | 0.5      | **Planned**       |
| v7.0 F1           | Data layer (AV + Yahoo)                        | 1.5      | **Planned**       |
| v7.0 F2           | Indicator engine                               | 1        | **Planned**       |
| v7.0 F4           | Watchlist + market tools                       | 1        | **Planned**       |
| v7.0 F5           | Macro regime detection                         | 0.5      | **Planned**       |
| v7.0 F3           | Signal detector                                | 1        | **Planned**       |
| v7.0 F6           | Prediction markets + whale tracker             | 1.5      | **Planned**       |
| v7.0 F6.5         | Sentiment signals                              | 0.5      | **Planned**       |
| v7.0 F7           | Alpha combination engine                       | 2        | **Planned**       |
| v7.0 F7.5         | Strategy backtester                            | 1        | **Planned**       |
| v7.0 F8           | Paper trading (pm-trader)                      | 1.5      | **Planned**       |
| v7.0 F9           | Scan rituals + calendar                        | 1        | **Planned**       |
| v7.0 F10          | Real-time crypto WebSocket                     | 1        | **Planned** (opt) |
| v7.1              | Charts + vision chart patterns                 | 1.5      | **Planned**       |
| v7.2              | Knowledge graph (Graphify)                     | 1.5      | **Planned**       |
| v7.3 P2           | SEO telemetry (PageSpeed + GSC)                | 1        | **Planned**       |
| v7.3 P3           | AI overview monitoring                         | 1        | **Planned**       |
| v7.3 P4           | Digital marketing buyer (claude-ads + Ads API) | 3        | **Planned**       |
| v7.4              | Video production                               | 2        | **Planned**       |
| v7.5              | Skill evolution (GEPA + SkillClaw)             | 2        | **Planned**       |
| v7.8 P3           | Autoreason tournament pilot (conditional)      | 2        | **Conditional**   |
| **Total shipped** | 2 sessions                                     | **2**    |                   |
| **Total planned** | 26 sessions critical path, ~20-22 parallelized | **~27**  |                   |

---

## Readiness Criteria

See [V7-READINESS-CRITERIA.md](./V7-READINESS-CRITERIA.md) for go/no-go criteria per tier.

---

## Appendix: F-Series Technical Reference

> The remaining sections describe the Financial Stack architecture, data model, tool surfaces, indicator/signal APIs, paper trading, backtester, macro regime, rituals, delivery format, and production hardening. Content is stable from the original V7-FINANCIAL-STACK.md draft — this is the implementation reference when Tier A (F-series) sessions begin.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Layer 4: Delivery                     │
│  WhatsApp / Telegram / Email / Scheduled Reports         │
│  (existing: messaging router, rituals, proactive scanner)│
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                 Layer 3: Visualization (v7.1)            │
│  TradingView lightweight-charts + Puppeteer → PNG        │
│  Candlestick + indicator overlays + signal markers       │
│  (DEFERRED — text signals first, charts when proven)     │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│              Layer 2b: Paper Trading (F8)                │
│  pm-trader MCP server (29 tools, stdio)                  │
│  Jarvis practices: thesis → trade → track → prove        │
│  Track record builds credibility before alerting user    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│              Layer 2a: Signal Detection                  │
│                                                          │
│  Indicator Engine (pure math, no deps):                  │
│  ├── SMA, EMA (simple/exponential moving average)        │
│  ├── RSI (relative strength index, 14-period default)    │
│  ├── MACD (12/26/9 EMA crossover + histogram)            │
│  ├── Bollinger Bands (20-period, 2σ)                     │
│  ├── VWAP (volume-weighted average price)                 │
│  ├── ATR (average true range — volatility)               │
│  └── Volume anomaly (z-score from rolling baseline)      │
│                                                          │
│  Signal Detector:                                        │
│  ├── MA crossover (golden cross / death cross)           │
│  ├── RSI extremes (oversold < 30, overbought > 70)       │
│  ├── MACD signal line crossover                          │
│  ├── Bollinger Band breakout (price outside bands)       │
│  ├── Volume spike (> 2σ above 20-day average)            │
│  ├── Price threshold alerts (user-defined)               │
│  └── Custom composite signals (combine any indicators)   │
│                                                          │
│  Sentiment Signals (from Vibe-Trading gap analysis):     │
│  ├── Fear & Greed Index (0-100, alternative.me API)      │
│  ├── Crypto funding rates (long/short leverage)          │
│  ├── Liquidation heatmaps (forced selling cascades)      │
│  └── Stablecoin flows (money entering/leaving crypto)    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│               Layer 1: Data Sources                      │
│                                                          │
│  Free / no-key APIs:                                     │
│  ├── Yahoo Finance (yfinance-style scraping)             │
│  ├── CoinGecko (crypto — already in Intel Depot)         │
│  ├── Frankfurter (forex — already in Intel Depot)        │
│  ├── Open-Meteo (commodities correlation — existing)     │
│  ├── Google Finance (basic quotes, no API key)           │
│  ├── Polymarket Gamma API (prediction market events)     │
│  ├── Kalshi REST API (binary outcome markets, 20 RPS)   │
│  └── Polymarket Data API (whale trade history, 7d)       │
│                                                          │
│  Smart money (whale tracking):                           │
│  ├── Auto-discover top traders by win rate + ROI          │
│  ├── Score across 6 dimensions (profit, timing, slip...)  │
│  ├── Track moves in real-time → signal layer 4            │
│  └── Jarvis learns: follow vs fade whale = training data │
│                                                          │
│  Macro data (dual source):                               │
│  ├── Alpha Vantage: fed funds, treasury yields,          │
│  │   CPI, unemployment, nonfarm payroll, GDP             │
│  ├── FRED REST API (3 series AV doesn't cover):          │
│  │   ├── VIXCLS (VIX — volatility/fear gauge)            │
│  │   ├── ICSA (initial claims — weekly leading)          │
│  │   └── M2SL (money supply — liquidity indicator)       │
│  └── TypeScript fetch — no Python sidecar                │
│                                                          │
│  Supplemental APIs:                                      │
│  ├── Binance WebSocket (real-time crypto, free)          │
│  ├── Alpha Vantage NEWS_SENTIMENT (per-ticker sentiment) │
│  └── Alpha Vantage server-side indicators (golden-file)  │
│                                                          │
│  Storage:                                                │
│  ├── SQLite table: market_data (ticker, date, OHLCV)     │
│  ├── Rolling retention: 1 year daily, 30 days intraday   │
│  └── Dedup: INSERT OR IGNORE on (ticker, timeframe, ts)  │
└─────────────────────────────────────────────────────────┘
```

## Data Model

### market_data table

```sql
CREATE TABLE IF NOT EXISTS market_data (
  id         INTEGER PRIMARY KEY,
  ticker     TEXT NOT NULL,           -- 'AAPL', 'BTC-USD', 'EUR/MXN'
  timeframe  TEXT NOT NULL,           -- '1d', '1h', '5m'
  ts         TEXT NOT NULL,           -- ISO datetime (UTC)
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     REAL DEFAULT 0,
  source     TEXT DEFAULT 'unknown',  -- 'alphavantage', 'yahoo', 'coingecko'
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticker, timeframe, ts)
);
CREATE INDEX IF NOT EXISTS idx_market_ticker_ts ON market_data(ticker, timeframe, ts);
```

### watchlist table

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY,
  ticker     TEXT NOT NULL UNIQUE,
  name       TEXT,                    -- 'Apple Inc', 'Bitcoin'
  asset_type TEXT DEFAULT 'stock',    -- 'stock', 'crypto', 'forex', 'commodity'
  alerts     TEXT DEFAULT '[]',       -- JSON: [{type:'rsi_oversold', threshold:30}]
  active     INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### backtest_results table

```sql
CREATE TABLE IF NOT EXISTS backtest_results (
  id            INTEGER PRIMARY KEY,
  strategy      TEXT NOT NULL,          -- 'rsi_reversion', 'ema_crossover', etc.
  regime        TEXT NOT NULL,          -- 'trending', 'ranging', 'volatile'
  ticker        TEXT NOT NULL,
  period_start  TEXT NOT NULL,          -- ISO date
  period_end    TEXT NOT NULL,
  win_rate      REAL NOT NULL,
  sharpe        REAL,
  max_drawdown  REAL,
  trade_count   INTEGER NOT NULL,
  stress_passed INTEGER DEFAULT 0,     -- how many of 5 stress scenarios survived
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backtest_strategy ON backtest_results(strategy, regime, ticker);
```

### trade_theses table

```sql
CREATE TABLE IF NOT EXISTS trade_theses (
  id              INTEGER PRIMARY KEY,
  ticker          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open', 'tracking', 'resolved', 'broken'
  thesis          TEXT NOT NULL,                 -- "BTC RSI oversold, macro stable, expect bounce"
  direction       TEXT NOT NULL,                 -- 'bullish', 'bearish'
  evidence        TEXT DEFAULT '[]',             -- JSON: [{signal, weight, timestamp}]
  transmission    TEXT DEFAULT '[]',             -- JSON: [{from, to, mechanism, confidence}]
  evolution       TEXT DEFAULT 'new',            -- 'new', 'strengthened', 'weakened', 'falsified'
  mega_alpha      REAL,                          -- combined signal at thesis creation
  entry_price     REAL,                          -- price when paper trade entered
  exit_price      REAL,                          -- price when resolved/broken
  outcome         TEXT,                          -- what actually happened
  lessons         TEXT,                          -- extracted post-resolution
  created_at      TEXT DEFAULT (datetime('now')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_theses_status ON trade_theses(status, ticker);
```

### api_call_budget table

```sql
CREATE TABLE IF NOT EXISTS api_call_budget (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,            -- 'alphavantage', 'fred', 'polymarket', 'yahoo'
  date       TEXT NOT NULL,            -- ISO date (UTC)
  calls      INTEGER NOT NULL DEFAULT 0,
  limit_day  INTEGER NOT NULL,         -- max calls/day for this source
  UNIQUE(source, date)
);
CREATE INDEX IF NOT EXISTS idx_api_budget_source ON api_call_budget(source, date);
```

## Tools (6 new, all deferred)

| Tool                | Purpose                                                                      | Scope Group |
| ------------------- | ---------------------------------------------------------------------------- | ----------- |
| `market_quote`      | Current price + daily change for a ticker                                    | `finance`   |
| `market_history`    | OHLCV history for a ticker + timeframe                                       | `finance`   |
| `market_indicators` | Compute SMA/EMA/RSI/MACD/Bollinger for a ticker                              | `finance`   |
| `market_signals`    | Detect active signals across watchlist                                       | `finance`   |
| `watchlist_manage`  | Add/remove/list watchlist tickers + alert configs                            | `finance`   |
| `market_scan`       | Scan multiple tickers for a specific condition                               | `finance`   |
| `macro_dashboard`   | Macro regime: yield curve, VIX, fed funds, employment, inflation (AV + FRED) | `finance`   |
| `prediction_market` | Polymarket/Kalshi top markets, probabilities, 24h shifts                     | `finance`   |

### Scope pattern

```typescript
// finance scope group
{
  pattern: /\b(mercado|market|acci[oó]n|stock|precio|price|ticker|bolsa|crypto|bitcoin|btc|eth|forex|divisas?|tipo\s+de\s+cambio|rsi|macd|bollinger|sma|ema|vwap|volumen|volume|overbought|oversold|sobrecompra|sobreventa|cruce\s+de\s+medias|golden\s+cross|death\s+cross|señal\s+(de\s+)?compra|señal\s+(de\s+)?venta|buy\s+signal|sell\s+signal|polymarket|kalshi|predicci[oó]n|prediction\s+market|probabilidad|apuesta|odds)\b/i,
  group: "finance",
}
```

## Indicator Engine API

```typescript
// src/finance/indicators.ts — pure functions, zero deps

// Moving averages
function sma(closes: number[], period: number): (number | null)[];
function ema(closes: number[], period: number): (number | null)[];

// Momentum
function rsi(closes: number[], period?: number): (number | null)[];
function macd(
  closes: number[],
  fast?: number,
  slow?: number,
  signal?: number,
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
};

// Volatility
function bollingerBands(
  closes: number[],
  period?: number,
  stdDev?: number,
): {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
};
function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period?: number,
): (number | null)[];

// Volume
function vwap(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
): (number | null)[];
function volumeZScore(volumes: number[], period?: number): (number | null)[];
```

## Signal Detector API

```typescript
// src/finance/signals.ts

interface Signal {
  ticker: string;
  type: string; // 'ma_crossover', 'rsi_oversold', 'volume_spike', etc.
  direction: "bullish" | "bearish" | "neutral";
  strength: number; // 0-1 confidence
  price: number;
  timestamp: string;
  description: string; // Human-readable: "BTC RSI at 28 (oversold)"
  indicators: Record<string, number>; // Supporting data
}

function detectSignals(
  ticker: string,
  data: OHLCV[],
  config?: SignalConfig,
): Signal[];

// Regime-aware signal weighting (from Polymarket Trading Bot pattern)
type MarketRegime = "trending" | "ranging" | "volatile";
function detectRegime(data: OHLCV[], period?: number): MarketRegime;

// Alpha Combination Engine (from RohOnChain / Fundamental Law of Active Management)
//
// NOT a voting system ("3 of 5 agree"). Instead: mathematically optimal weighting
// based on each signal's INDEPENDENT contribution after removing shared variance.
//
// IR = IC × √N  (Information Ratio = avg Information Coefficient × √independent signals)
// 50 weak signals at IC=0.05 → IR=0.354 (beats single signal at IC=0.10)
//
// The 11-step procedure:
// 1. Collect return series per signal
// 2. Serial demean (remove drift)
// 3. Calculate variance per signal
// 4. Normalize to common scale
// 5. Drop most recent observation (prevent look-ahead)
// 6. Cross-sectional demean (remove shared market-wide effects)
// 7. Drop final period (data hygiene)
// 8. Calculate forward expected return per signal
// 9. Regress to isolate INDEPENDENT contribution (critical step)
// 10. Weight = independent_edge / volatility (penalize noise)
// 11. Normalize weights to sum to 1

interface AlphaWeight {
  signalName: string;
  weight: number; // optimal weight from combination engine
  informationCoefficient: number; // IC: correlation of signal vs outcome
  independentContribution: number; // what this adds that no other signal covers
}

function combineAlpha(
  signals: Signal[],
  historicalReturns: SignalReturnSeries[],
  regime: MarketRegime,
): {
  megaAlpha: number; // combined probability/direction estimate
  weights: AlphaWeight[]; // per-signal optimal weights
  effectiveN: number; // actual independent signals (≤ total signals)
  informationRatio: number; // IR of the combined system
  edge: number; // gap between megaAlpha and market price
  actionable: boolean; // edge > minimum threshold
};

// Position sizing: empirical Kelly adjusted for estimation uncertainty
// f = f_kelly × (1 - CV_edge)  where CV_edge from Monte Carlo simulation
function kellySize(
  edge: number,
  odds: number,
  cvEdge: number, // coefficient of variation from simulation
): number;
```

### Shadow Portfolio (validation before alerting)

Before sending live alerts, simulate the last 30 days of signals and report hypothetical P&L. Builds credibility and catches broken signal logic before it reaches the user.

```typescript
// src/finance/shadow.ts
function backtest(
  signals: Signal[],
  priceHistory: OHLCV[],
): {
  totalReturn: number;
  winRate: number;
  sharpe: number;
  maxDrawdown: number;
  tradeCount: number;
};
```

### Replication Scoring (am I trading like the winners?)

After each paper trade batch, compare Jarvis's decisions against top whale decisions for the same markets. Measures whether Jarvis is converging toward smart money behavior.

```typescript
// src/finance/replication.ts (from Polybot pattern)
function replicationScore(
  jarvisTrades: PaperTrade[],
  whaleTrades: WhaleTrade[],
): {
  alignment: number; // 0-1 how closely Jarvis mirrors whale consensus
  directionMatch: number; // % of trades where Jarvis and whales agree on direction
  timingDelta: number; // avg seconds between Jarvis entry and whale entry
  trend: "converging" | "diverging" | "stable";
};
```

If alignment is high → Jarvis signals are tracking smart money (good).
If alignment is low but win rate is high → Jarvis found its own edge (also good).
If alignment is low AND win rate is low → retune signal weights.

## Macro Regime Detection (Alpha Vantage + FRED)

```typescript
// src/finance/macro.ts — TypeScript fetch, no Python sidecar

interface MacroRegime {
  regime: "expansion" | "tightening" | "recession_risk" | "recovery";
  yieldCurve: number; // 10Y-2Y spread (< 0 = inverted)
  fedRate: number; // fed funds rate current level
  vix: number; // VIX current level
  unemployment: number; // latest monthly
  inflationYoY: number; // CPI year-over-year %
  m2GrowthYoY: number; // M2 money supply year-over-year %
  initialClaims: number; // ICSA latest weekly
  signals: MacroSignal[];
}

interface MacroSignal {
  type: string; // 'yield_curve_inversion', 'vix_spike', 'employment_miss'
  severity: "watch" | "warning" | "alert";
  description: string;
}

// Regime rules:
// - yieldCurve < 0 + unemployment rising → recession_risk
// - fedRate rising + M2 declining → tightening
// - yieldCurve > 0 + unemployment falling + VIX < 20 → expansion
// - yieldCurve normalizing + unemployment peaking → recovery
```

**Data sources (dual):**

| Indicator           | Source        | Endpoint                         | Frequency |
| ------------------- | ------------- | -------------------------------- | --------- |
| Fed Funds Rate      | Alpha Vantage | `FEDERAL_FUNDS_RATE`             | Daily     |
| Treasury 2Y         | Alpha Vantage | `TREASURY_YIELD maturity=2year`  | Daily     |
| Treasury 10Y        | Alpha Vantage | `TREASURY_YIELD maturity=10year` | Daily     |
| Yield Curve         | Computed      | 10Y - 2Y from above              | Daily     |
| CPI                 | Alpha Vantage | `CPI`                            | Monthly   |
| Unemployment        | Alpha Vantage | `UNEMPLOYMENT`                   | Monthly   |
| Nonfarm Payroll     | Alpha Vantage | `NONFARM_PAYROLL`                | Monthly   |
| GDP                 | Alpha Vantage | `REAL_GDP`                       | Quarterly |
| **VIX**             | **FRED**      | `VIXCLS`                         | Daily     |
| **Initial Claims**  | **FRED**      | `ICSA`                           | Weekly    |
| **M2 Money Supply** | **FRED**      | `M2SL`                           | Monthly   |

**Integration:** All TypeScript `fetch()` — Alpha Vantage uses existing adapter, FRED uses `https://api.stlouisfed.org/fred/series/observations?series_id=X&api_key=Y&file_type=json`. Cached in SQLite (daily refresh for daily series, monthly for monthly). Macro regime injected into signal context so technical signals get regime-aware interpretation.

## Rituals

| Ritual              | Schedule                        | Delivery                       |
| ------------------- | ------------------------------- | ------------------------------ |
| Morning market scan | 7:30 AM MX (before market open) | Telegram + Email               |
| Mid-day check       | 1:00 PM MX                      | Telegram (if signals detected) |
| End-of-day summary  | 4:30 PM MX (after market close) | Telegram + Email               |
| Crypto 24/7 monitor | Every 4 hours                   | Telegram (if signals)          |

## Delivery Format (text-first)

```
📊 **Señales de Mercado — 10 Abr 2026, 7:30 AM**

🟢 **BTC-USD** $62,450 (-3.2%)
  RSI: 28 (sobreventa) | Bollinger: precio bajo banda inferior
  Señal: COMPRA — RSI extremo + soporte Bollinger

🔴 **AAPL** $187.30 (+1.8%)
  MACD: cruce bajista | SMA20 > SMA50 por $2.10
  Señal: PRECAUCIÓN — MACD diverge del trend

⚪ **EUR/MXN** $18.45 (-0.1%)
  Sin señales activas. Rango lateral.

_Watchlist: 12 tickers | 2 señales activas | Próximo scan: 1:00 PM_
```

## Paper Trading — Jarvis Learns to Trade (F8)

**Progression:** Detect → Hypothesize → Practice → Prove → Alert

Instead of just reporting signals, Jarvis paper trades them on Polymarket via the `pm-trader` MCP server (agent-next/polymarket-paper-trader). This builds a track record that proves signal quality before recommending actions to the user.

```
12 signals fire across 5 layers:
  RSI=28, Bollinger low, volume spike (technical)
  Yield curve stable, VIX=18 (macro)
  Polymarket BTC-UP at 0.62 (crowd)
  Top 3 whales bought in last hour (smart money)
  Fear index=22, funding rates negative (sentiment)

Alpha Combination Engine (11-step procedure):
  → Strips shared variance: RSI + Bollinger are correlated (same price data)
  → Effective independent signals: 7 of 12 (5 were redundant)
  → Weights: whale flow 0.23, funding rates 0.19, VIX 0.17, RSI 0.14, ...
  → Combined megaAlpha: 0.71 probability of bounce
  → Market price: 0.62 → Edge: +0.09
  → Kelly size (uncertainty-adjusted): $85 paper trade

  → Backtests strategy on last 30 days with walk-forward (F7.5)
  → Stress test: survives 4/5 historical crash scenarios
  → Paper trades on Polymarket (F8)
  → Scores vs whale consensus: 72% alignment (replication)
  → After 30+ trades: "62% win rate, 1.3 Sharpe, IR=0.35"
  → NOW alerts user with evidence
```

**Integration:** MCP server (`pm-trader mcp` via stdio). 29 tools: search_markets, buy, sell, portfolio, stats, backtest, etc. Same protocol as Lightpanda/Playwright — add to `mcp-servers.json`, tools auto-discovered.

**Delivery format with track record:**

```
📊 **Señal de Mercado — BTC-USD**

🟢 **MegaAlpha: 0.71** (mercado: 0.62) → Edge: +9%
  7 señales independientes de 12 totales (5 redundantes filtradas)
  Top pesos: whale flow 23%, funding 19%, VIX 17%, RSI 14%

📈 **Mi historial:**
  Trades: 47 | Win rate: 62% | Sharpe: 1.3 | IR: 0.35
  Smart money: 72% alineado | Estrés: sobrevive 4/5 crashes

_¿Procedo con paper trade? Responde "sí" para ejecutar_
```

## Strategy Backtester — Learn Before You Trade (F7.5)

Before paper trading, Jarvis backtests its thesis against historical data. Nine strategy templates from the prediction-market-backtesting playbook:

| Strategy                 | Logic                                    | Best Regime |
| ------------------------ | ---------------------------------------- | ----------- |
| Mean Reversion           | Buy when price < rolling_avg - threshold | Ranging     |
| EMA Crossover            | Buy when fast_ema >= slow_ema            | Trending    |
| Breakout                 | Buy when price > mean + n\*std           | Volatile    |
| RSI Reversion            | Buy when RSI < entry_threshold           | Ranging     |
| Panic Fade               | Buy panic selloffs below threshold       | Volatile    |
| VWAP Reversion           | Buy dislocation from trade-tick VWAP     | Ranging     |
| Final Period Momentum    | Buy late-game strength near expiry       | Any         |
| Late Favorite Limit Hold | Limit buy high-probability favorites     | Trending    |
| Threshold Momentum       | Buy absolute price threshold crossovers  | Trending    |

**Validation flow:**

```
Signal: "BTC RSI at 28, macro stable, fear index at 22"
  → Regime: RANGING
  → Backtest RSI Reversion + Mean Reversion + VWAP (ranging strategies)
  → Walk-forward validation (not naive backtest — train/test split rolls forward)
  → Stress test: "Would this strategy survive 2020 COVID crash?"
  → Results: RSI Reversion 65% win rate, survived 4/5 stress scenarios
  → Select: RSI Reversion (best for current regime + stress-resilient)
  → Paper trade with RSI Reversion entry/exit rules
  → Track: did the backtest-selected strategy outperform random?
```

**Walk-forward validation** (from Vibe-Trading): Train on months 1-6, test on month 7. Roll forward. This prevents overfitting — a strategy that only works "in backtest" gets filtered out.

**Stress testing** (from Vibe-Trading): Pre-built scenarios (2008, 2020, rate shock, credit crisis, liquidity dry-up). "This strategy has 65% win rate AND survives historical crashes" is fundamentally different from "65% win rate in calm markets."

Over time, Jarvis learns which strategy works for which regime — adapting its playbook based on evidence, not intuition.

## Implementation Order (F-series, archived)

> **Superseded 2026-04-13** by the "Master sequence" section at the top of this document, which consolidates F-series with v7.1–v7.8 into a single ordered plan. The table below remains as the authoritative F-series scope definition — durations and dependencies here are unchanged, only the rendering moved up. Do not edit this table in isolation; edit the master sequence and mirror here.

| Phase    | What                                                                                                                                                                                                                                                                                                                | Sessions | Deps                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------- |
| **F1**   | Schema (6 tables), Alpha Vantage adapter (premium: adjusted daily, FX, macro, news sentiment) + Yahoo fallback, data validation, timezone normalization, api_call_budget tracking, gold via GLD ETF                                                                                                                 | 1.5      | None                             |
| **F2**   | Indicator engine (SMA, EMA, RSI, MACD, Bollinger, VWAP, ATR, ROC, Williams %R) + golden-file tests (validated against AV server-side indicators)                                                                                                                                                                    | 1        | F1                               |
| **F4**   | Watchlist management + market_quote/history tools                                                                                                                                                                                                                                                                   | 1        | F1                               |
| **F3**   | Signal detector + market_signals tool + transmission chain field                                                                                                                                                                                                                                                    | 1        | F2 + F4                          |
| **F5**   | Macro regime detection — Alpha Vantage (fed funds, treasury, CPI, unemployment, payroll, GDP) + FRED REST API (VIX, ICSA, M2). TypeScript fetch, no Python sidecar                                                                                                                                                  | 0.5      | F1                               |
| **F6**   | Prediction markets (Polymarket/Kalshi) + whale tracker (Polymarket trade history + SEC EDGAR insider filings)                                                                                                                                                                                                       | 1.5      | None                             |
| **F6.5** | Sentiment signals (fear/greed, funding rates, liquidations)                                                                                                                                                                                                                                                         | 0.5      | None                             |
| **F7**   | Alpha Combination Engine (11-step) + signal evolution + ISQ dimensions + per-layer freshness + weight versioning + min signal threshold                                                                                                                                                                             | 2        | F3+F5+F6+F6.5                    |
| **F7.5** | Strategy backtester (walk-forward + stress test) → backtest_results table                                                                                                                                                                                                                                           | 1        | F7                               |
| **F8**   | Paper trading via pm-trader MCP + trade_theses commitment tracking + transaction costs                                                                                                                                                                                                                              | 1.5      | F7.5                             |
| **F9**   | Morning/EOD market scan rituals + market calendar + dynamic alert budget                                                                                                                                                                                                                                            | 1        | F8 + F4                          |
| **F10**  | Real-time crypto via Binance WebSocket (optional)                                                                                                                                                                                                                                                                   | 1        | F3                               |
| **v7.1** | Chart rendering (lightweight-charts + Puppeteer → PNG) + vision chart patterns (6th signal layer)                                                                                                                                                                                                                   | 1.5      | F3                               |
| **v7.2** | Knowledge graph layer (Graphify MCP — CRM + codebase + corpus)                                                                                                                                                                                                                                                      | 1.5      | None                             |
| **v7.3** | Digital marketing planner & buyer (claude-ads patterns + Meta/Google Ads API)                                                                                                                                                                                                                                       | 3        | None                             |
| **v7.4** | Video production enhancement (AI asset generation + storyboard pipeline + lip sync)                                                                                                                                                                                                                                 | 2        | v7.3                             |
| **v7.5** | Skill evolution engine (GEPA + SkillClaw patterns). Reflective mutation from execution traces, ASI diagnostics, Pareto domain specialization, failure source classification (skill/agent/env), session trajectory structuring, conservative editing principles, monotonic validation. Upgrade overnight tuning loop | 2        | F9 (needs production trace data) |

### Dependency Graph

```
F1 (data layer — AV premium + Yahoo fallback)
├── F2 (indicators) ──┐
├── F4 (watchlist) ────┤
├── F5 (macro — AV + FRED fetch) ─┤
│                      F3 (signal detector)
│                                  │
F6 (prediction markets) ──────────┤
F6.5 (sentiment) ─────────────────┤
                                   │
                            F7 (combination engine)
                                   │
                            F7.5 (backtester)
                                   │
                            F8 (paper trading)
                                   │
                      F9 (scan rituals — last, needs track record)

Parallel branches (after F3):
  F10 (crypto websocket)
  v7.1 (charts + vision)

Post-core (after F9 produces trace data):
  v7.5 (GEPA prompt evolution — reflective mutation + ASI + Pareto specialization)

Independent (no v7 deps):
  v7.2 (knowledge graph)
  v7.3 (digital marketing) ── v7.4 (video production)

Deferred to v7.x (post-launch):
  TimesFM forecasting (Python sidecar, 6th signal layer)
```

### Parallelization Opportunities

F5 is now 0.5 sessions (TypeScript fetch, no sidecar) and slots into F1 or runs alongside F2/F4. F6 and F6.5 have no dependencies on each other. The critical path is: **F1 → F2 → F4 → F3 → F7 → F7.5 → F8 → F9**. Everything else can slot around it.

## Production Hardening (built into phases, zero extra sessions)

### H1. Golden-File Indicator Tests (F2)

Every indicator gets a `*.golden.json` fixture — known input (100 days of real OHLCV), expected output verified against a reference source (TradingView or TA-Lib values). Tests compare to 6 decimal places. If the RSI math is wrong, tests catch it before signals are generated. This is the difference between "looks right" and "is right."

### H2. Data Validation Layer (F1)

`validateOHLCV()` runs on every ingested record before storage:

- Reject: price ≤ 0, high < low, volume negative, NaN/null
- Flag: >10% gap from previous close without corresponding volume spike (possible API glitch)
- Log: data quality score per source per day to `api_call_budget` table

Bad data never reaches the indicator engine.

### H3. Timezone & Market Convention (F1)

All timestamps stored in **UTC**. Each data adapter normalizes on ingestion via `normalizeTimestamp(raw, source) → UTC ISO`.

Jarvis uses **market-native timezones** for financial references and alerts — not Mexico City time:

- US stocks: ET (NYSE/NASDAQ). "Market opens at 9:30 AM ET"
- FOREX: 24/5, daily candle closes at 5 PM ET (NY close convention)
- Crypto: 24/7, candles close at midnight UTC
- Asia (Tokyo/Shanghai/HK): JST/CST/HKT. "Asia session opens Sunday 4 PM MX time"
- FRED macro: release dates in ET
- User sync: Mexico City time for rituals, morning briefings, personal scheduling

The user's local time is for Jarvis-to-human communication. Market references use each market's native convention.

### H4. Market Calendar (F9)

`isMarketOpen(assetType, datetime) → boolean`

- US stocks: NYSE holiday calendar (static, updated annually). Skip stock scans on holidays. Don't alert "no signals" when market was closed
- FOREX: 24/5 (Sunday 5 PM ET → Friday 5 PM ET). Closed weekends
- Crypto: always open
- Asia: TSE/SSE/HKEX calendars for sector-specific scans

Morning scan ritual checks calendar before firing. No wasted API calls on closed markets.

### H5. Paper Trading Transaction Costs (F8)

`transactionCost(assetType, ticker) → { spread, fee }`

| Asset              | Cost Model                                                 |
| ------------------ | ---------------------------------------------------------- |
| FOREX              | 1-3 pip spread (pair + session dependent)                  |
| US stocks          | $0.005/share (commission-free assumption) + $0.01 slippage |
| Crypto             | 0.1% taker fee                                             |
| Prediction markets | Built into odds spread                                     |

Paper P&L calculated **after** costs. A strategy that wins 55% with zero spread might win 48% with realistic costs — know this during paper phase, not after.

### H6. Weight Versioning (F7)

Add `weights TEXT` (JSON) to `trade_theses` — snapshot the full Alpha Combination weight vector at thesis creation. Post-mortem: "Why did Jarvis take that trade?" requires knowing what weights were active.

```sql
-- Add to trade_theses
weights TEXT,  -- JSON: {"whale_flow": 0.23, "funding": 0.19, "vix": 0.17, ...}
```

Also: `signal_weights_log` table for drift analysis over time.

```sql
CREATE TABLE IF NOT EXISTS signal_weights_log (
  id         INTEGER PRIMARY KEY,
  regime     TEXT NOT NULL,
  weights    TEXT NOT NULL,            -- JSON weight vector
  effective_n REAL,                    -- independent signals count
  ir         REAL,                     -- information ratio
  created_at TEXT DEFAULT (datetime('now'))
);
```

### H7. Per-Layer Freshness Thresholds (F7)

Replace blanket "<24h" with per-layer config:

```typescript
const FRESHNESS_THRESHOLDS = {
  technical: 60 * 60, // 1 hour (price data)
  macro: 7 * 24 * 60 * 60, // 7 days (FRED monthly releases are "fresh" longer)
  crowd: 2 * 60 * 60, // 2 hours (prediction markets move fast)
  smartMoney: 4 * 60 * 60, // 4 hours (whale activity)
  sentiment: 12 * 60 * 60, // 12 hours (fear/greed index updates daily)
};
```

MegaAlpha requires ≥3 layers within their respective freshness windows.

### H8. Dynamic Alert Budget (F9)

Replace static "2-3 signals/day" with regime-aware budget:

| Regime          | Max Alerts/Day | MegaAlpha Threshold              |
| --------------- | -------------- | -------------------------------- |
| Low volatility  | 1-2            | ≥ 0.65                           |
| Normal          | 2-3            | ≥ 0.60                           |
| High volatility | 4-5            | ≥ 0.70 (higher bar during noise) |

Regime detector feeds the alert budget. During crashes, more alerts are allowed but require stronger conviction. During calm, fewer alerts but lower bar — don't miss slow-developing opportunities.

## Constraints

- **Zero new npm deps** for indicators — pure TypeScript math
- **Alpha Vantage premium primary + Yahoo Finance fallback** — never single-source for market data. AV: adjusted daily OHLCV, FX, 50+ server-side indicators, macro economic data, news sentiment. 75 req/min, unlimited daily. Gold via GLD ETF (XAU/USD not supported by AV FX endpoint)
- **Free APIs supplement** — FRED REST API (VIX, ICSA, M2 — 3 series AV doesn't cover), Polymarket/Kalshi (predictions), CoinGecko (crypto), Frankfurter (EUR backup)
- **No Python sidecar** — all data fetching via TypeScript `fetch()`. FRED REST API returns JSON directly. TimesFM deferred to v7.x post-launch enhancement
- **SQLite storage** — 6 tables (market_data, watchlist, backtest_results, trade_theses, api_call_budget, signal_weights_log), additive schema (no DB reset)
- **Minimum signal threshold** — MegaAlpha only generated when ≥3 of 5 signal layers have fresh data (per-layer thresholds, not blanket 24h)
- **Market-native timezones** — Jarvis references markets in their native TZ (ET for US, UTC for crypto, JST for Tokyo). Mexico City for personal scheduling only
- **Text-first delivery** — charts are v7.1, not v7
- **Existing infrastructure** — rituals, proactive scanner, Intel Depot alert router all reusable
- **Scope group** — new `finance` group, deferred tools, keyword-gated
- **Whale tracking scoped** — Polymarket trade history (free, Gamma API) + SEC EDGAR insider filings (free, delayed). No paid whale services
- **Transaction costs in paper trading** — realistic spread/fee model per asset type. Paper P&L after costs
- **Golden-file indicator tests** — every indicator verified against reference to 6 decimal places
- **Realistic session estimate** — 14-15 sessions for F1-F9 (F5 dropped from 1.5 to 0.5 by eliminating Python sidecar). v6 history: 3x expansion is normal. Quality over speed

## Bookmarked Resources

- **TradingView lightweight-charts** — v7.1 chart rendering (50KB, Canvas, OHLC-native)
- **FRED REST API** — macro economic data (500K+ series, free, 120 calls/min). TypeScript fetch for VIX/ICSA/M2 only — other macro from Alpha Vantage
- **Camofox** — if stealth browsing needed for finance site scraping
- **CoinGecko adapter** — already in Intel Depot (src/intel/adapters/coingecko.ts)
- **Frankfurter adapter** — already in Intel Depot (src/intel/adapters/frankfurter.ts)
- **Polymarket Gamma API** — `https://gamma-api.polymarket.com/events` (market discovery, no key)
- **Kalshi REST API** — `https://api.kalshi.com/trade-api/v2` (20 RPS free tier)
- **prediction-market-backtesting** — 9 strategy playbook (mean reversion, EMA crossover, panic fade, VWAP reversion, breakout, RSI reversion, final period momentum, late favorite, threshold). Strategy backtester for F7.5 — Jarvis selects best strategy per regime from historical performance
- **Polymarket-Trading-Bot** — Regime detection (trending/ranging/volatile), multi-filter convergence (7 gates), shadow portfolio validation. Design patterns adopted into F7 composite signals
- **polymarket-paper-trader** — MCP server (29 tools, stdio). Jarvis practices trading with $10K simulated. Track record builds credibility before alerting user. Phase F8
- **polybot** — Replication scoring: compare Jarvis's paper trades vs whale decisions. Measures smart money alignment. Feedback loop for signal tuning
- **Vibe-Trading** (HKUDS) — Gap analysis revealed 3 missing pieces: (1) sentiment signals (fear/greed, funding rates, liquidation heatmaps), (2) stress testing (5 historical + 5 hypothetical crash scenarios), (3) walk-forward ML validation (prevents backtest overfitting). 68-skill reference library. MIT licensed
- **RohOnChain alpha combination thread** — Fundamental Law of Active Management (IR = IC × √N). 11-step procedure for mathematically optimal signal weighting. Replaces naive voting ("3 of 5 agree") with independence-weighted combination. The theoretical foundation for F7. Key insight: 50 weak signals at IC=0.05 beat one strong signal at IC=0.10
- **last30days-skill** (mvanhorn) — Pre-research planner, engagement scoring, cross-source clustering. Free sources: HN (Algolia), Reddit JSON, Bluesky. X via xAI API (~$3-5/mo). 14 platforms, MIT
- **PageIndex** (VectifyAI) — Summary-as-retrieval-key pattern for KB enrichment optimization when >500 entries. Vectorless RAG via LLM tree traversal
- **gbrain** (garrytan) — Compiled truth + timeline for Prometheus goal execution. Tiered goal budgeting. RRF fusion for multi-signal ranking without normalization
- **mcp-toolbox** (Google) — Vector-assist pgvector query generation pattern. Skip adoption (Go server, wrong role)

## Decisions (answered 2026-04-10)

### 1. Sectors: Biotech, Military/Intelligence, Energy

**Initial watchlist:**

| Sector                    | Tickers                                                                                        | Why                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Biotech**               | XBI (SPDR Biotech ETF), IBB (iShares Biotech), ARKG (ARK Genomic), MRNA, LLY, AMGN, VRTX, REGN | FDA approvals, pipeline catalysts, earnings surprises   |
| **Military/Intelligence** | ITA (iShares Defense ETF), LMT, RTX, NOC, GD, PLTR, BA, LHX                                    | Geopolitical tensions, defense budgets, contract awards |
| **Energy**                | XLE (Energy Select ETF), XOP (Oil & Gas Exploration), CVX, XOM, SLB, OXY, FSLR, ENPH           | Oil prices, OPEC decisions, energy transition           |

### 2. Priority: Leveraged FOREX + Gold

**F1 starts with forex/gold, not equities.** Data source: Yahoo Finance for daily OHLCV, Frankfurter (already in Intel Depot) for real-time rates.

| Pair/Instrument    | Why                                              |
| ------------------ | ------------------------------------------------ |
| EUR/USD            | Most liquid, macro-driven                        |
| GBP/USD            | BoE policy divergence                            |
| USD/JPY            | Carry trade barometer                            |
| USD/MXN            | Fede's home currency exposure                    |
| EUR/MXN            | Direct business relevance                        |
| XAU/USD (Gold)     | Safe haven, inflation hedge, central bank buying |
| DXY (Dollar Index) | Umbrella for all USD pairs                       |

**"Leveraged" note:** Jarvis detects signals and paper trades. Position sizing via Kelly accounts for leverage risk. Jarvis never recommends leverage amounts — that's the user's decision.

### 3. FRED API Key

Reminder set: sign up at https://fred.stlouisfed.org/docs/api/api_key.html before F5 session.

### 4. Trading Horizon: Mid-to-Long Term

**No scalping. No intraday noise.**

| Timeframe   | Data                          | Signal Type                                       |
| ----------- | ----------------------------- | ------------------------------------------------- |
| **Daily**   | OHLCV candles, 1 year history | SMA/EMA crossovers, RSI extremes, Bollinger bands |
| **Weekly**  | Aggregated from daily         | Trend direction, regime detection                 |
| **Monthly** | FRED macro data               | Macro regime shifts, yield curve, employment      |

**Alert cadence:** Max 2-3 signals per day across entire watchlist. Morning scan (7:30 AM MX) + end-of-day (4:30 PM MX). No mid-day noise unless a circuit-breaker-level event fires.

**Holding periods:** Days to weeks (forex), weeks to months (sectors). Not minutes or hours.

**Implication for indicators:** Optimize SMA/EMA periods for daily timeframe (20/50/200 day). RSI 14-period on daily. MACD 12/26/9 on daily. No 1-min or 5-min signals.

## Data Source Decision

**Alpha Vantage premium** selected as primary data source. Key set in `.env` as `ALPHAVANTAGE_API_KEY`. Verified 2026-04-11: adjusted daily, FX, macro, server-side indicators, news sentiment all working. 75 req/min, unlimited daily.

| Source               | Role                                                                                                                                                                          | Cost   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Alpha Vantage**    | Forex, stocks (adjusted OHLCV), gold (GLD ETF), macro (fed funds, treasury, CPI, unemployment, payroll, GDP), news sentiment, server-side indicators (golden-file validation) | $50/yr |
| **FRED REST API**    | VIX, initial claims (ICSA), M2 money supply — 3 series AV doesn't cover                                                                                                       | Free   |
| **Polymarket Gamma** | Prediction market probabilities                                                                                                                                               | Free   |
| **CoinGecko**        | Crypto (already in Intel Depot)                                                                                                                                               | Free   |
| **Frankfurter**      | EUR cross-rates backup (already in Intel Depot)                                                                                                                               | Free   |

**Total data layer cost: ~$500/year.**

### Alpha Vantage API Budget (verified 2026-04-11)

**Rate limit:** 75 req/min (sustained at 1/sec, burst-limited at ~5 rapid calls)

| Scenario                              | Instruments                       | Calls/scan                 | Time at 1/sec |
| ------------------------------------- | --------------------------------- | -------------------------- | ------------- |
| Morning OHLCV scan                    | 31 (5 FX + GLD + 24 stocks + DXY) | 31                         | ~31 sec       |
| + Server-side indicators (validation) | 31 × 6 indicators                 | +186                       | ~3.1 min      |
| + Macro refresh                       | 9 (6 AV + 3 FRED)                 | +9                         | ~9 sec        |
| + News sentiment                      | ~5 key tickers                    | +5                         | ~5 sec        |
| **Full morning scan**                 |                                   | **~45** (OHLCV+macro+news) | **~45 sec**   |

Daily capacity: 108,000 calls. Heaviest scenario uses <0.3%.

### Key findings (verified)

- **XAU/USD does NOT work via FX endpoint** — "Invalid API call". Use GLD (SPDR Gold ETF) instead
- **VWAP is intraday only** — irrelevant for daily timeframe, compute locally if needed
- **Server-side indicators** cover 50+ functions (SMA, EMA, RSI, MACD, BBANDS, ATR, etc.) — use for golden-file test validation, not as primary computation
- **Adjusted daily (premium)** includes dividend amount + split coefficient — critical for stock indicator accuracy

## Adopted Patterns from Repo Analysis (Session 58)

### From last30days-skill (mvanhorn/last30days-skill)

**Pre-research planner** — Before searching, an LLM resolves the topic into platform-specific targets (X handles, subreddits, GitHub repos, hashtags). Apply to Jarvis's `exa_search`/`web_search` and v7 intel tools. "Biotech sector sentiment" → specific company names, tickers, X handles, subreddits.

**Engagement-weighted scoring** — Rank results by real-world signals (upvotes, prediction market odds, repost counts) instead of keyword relevance. Maps directly to Alpha Combination Engine signal weighting.

**Cross-source clustering** — Entity overlap detection merges duplicate stories across platforms. Needed for multi-source intel fusion when combining HN + Reddit + X + Polymarket signals.

**New free data sources for v7:**

- Hacker News (Algolia API, zero cost) — tech/biotech sentiment
- Polymarket (Gamma API, zero cost) — already planned in F6
- Reddit public JSON (free for fetching by URL/subreddit)
- Bluesky (AT Protocol, free with app password)

**X/Twitter via xAI API** (~$3-5/mo) — only reliable path. Bird cookie hack is deprecated and fragile. Add as premium intel tier when budget allows.

### From PageIndex (VectifyAI/PageIndex)

**Summary-as-retrieval-key** — When KB exceeds 500 entries (expected in v7 with financial data), add a `summary` column to `kb_entries`. Use summaries for first-pass filtering in enrichment pipeline, fetch full content only when LLM needs it. Reduces the 5K-char enrichment cap pressure without new dependencies.

### From gbrain (garrytan/gbrain)

**Compiled truth + timeline on goal execution** — For Prometheus PER loop: each goal maintains a `compiledState` (current summary, rewritten on replan) + `timeline` (immutable trace of attempts/failures). Reflector reads compiled state instead of re-scanning full trace. Reduces context pressure during multi-iteration financial analysis tasks.

**Tiered goal budgeting** — Allocate API spend by goal importance. High-priority goals (signal detection for user-facing alerts) get more rounds than peripheral goals (data gathering). Apply to orchestrator config in v7 financial tasks where API budget matters.

**RRF (Reciprocal Rank Fusion)** — Merges rankings from different signal types without normalization (K=60). Complement to the 11-step Alpha Combination Engine for cases where signals have incomparable scales (technical price data vs. crowd probability vs. macro regime).

### From googleapis/mcp-toolbox

**Vector-assist query generation** — Auto-generates pgvector similarity SQL from tool config. Apply when v7 financial data queries against pgvector get complex (semantic search across market analysis notes).

### From Awesome-finance-skills (RKiding/Awesome-finance-skills)

**Transmission chain mapping** — Model causal flows on signals: "Gold crash → currency pressure → A-share export tailwind." Each signal gets a `transmission_chain` field — array of `{from, to, mechanism, confidence}`. The Alpha Combination Engine (F7) weights signals by independent contribution but doesn't model _how_ signals transmit through markets. This adds the "why" behind each signal, improving thesis formation.

**Signal evolution tracking** — Systematic lifecycle per signal: `Strengthened`, `Weakened`, or `Falsified` as new data arrives. Integrates with the trade_theses commitment tracking (from PMM pattern). Jarvis tracks whether a thesis is getting stronger or weaker before acting — not just point-in-time snapshots.

**ISQ framework (bookmark)** — 6-dimension decomposition of Information Coefficient: Sentiment, Confidence, Intensity, Expectation Gap, Timeliness, Transmission Clarity. Richer than raw IC as a single number. Apply when Alpha Combination Engine (F7) is built to give each signal a quality profile, not just a weight.

### From GEPA (gepa-ai/gepa)

**Reflective mutation from execution traces** — GEPA's core innovation: instead of random prompt mutation, feed full execution traces (tool errors, expected vs actual output, quality scores) to a reflection LLM that diagnoses _why_ something failed and proposes targeted fixes. 35x more sample-efficient than RL (100-500 evaluations vs 5,000-25,000+). Adopt into overnight tuning loop: the current `tune:run` pipeline mutates prompts semi-randomly; GEPA-style reflection would read test failure traces and propose targeted improvements. Implementation: `src/tuning/reflective-proposer.ts` — takes `{candidate, failedTests[], traces[]}`, returns improved candidate with rationale.

**Actionable Side Information (ASI)** — Structure error feedback as rich diagnostic context, not just error codes. Every tool error, quality assessment, and execution trace becomes input to the reflection LLM. Adopt across tool error handling: when a tool fails, capture `{toolName, args, error, expectedBehavior, contextAtFailure}` as a structured diagnostic record. Feed these into the reflective mutation proposer during overnight tuning. Implementation: extend `ExecutionResult` with `diagnostics: DiagnosticRecord[]` field.

**Pareto-aware prompt specialization** — Maintain a Pareto front of prompt variants: one might excel at CRM tasks while another at financial analysis. Instead of one generalist prompt, the overnight tuning loop evolves specialized variants per task domain. The classifier already routes by complexity; add a prompt-variant dimension. Implementation: `tune_variants` table gains `domain` column (general, finance, crm, coding), best variant selected per domain at runtime.

### From SkillClaw (arXiv:2604.08377, DreamX Team)

**Failure source classification** — Every failed interaction classified into one of three buckets: (1) skill deficiency (wrong/missing guidance → edit the skill), (2) agent problem (didn't read the skill, context overflow → don't bloat the skill), (3) environment problem (API flakiness → brief note, not retry tutorial). Prevents prompt bloat — the #1 risk when auto-evolving tool descriptions. Implementation: `classifyFailure()` in reflective proposer, feeds into GEPA mutation decisions.

**Session trajectory structuring** — Record full causal chain per interaction: `user message → agent reasoning → tool calls → tool results → response`, with skill/tool attribution and quality estimate. Group sessions by skill invoked — cross-user grouping creates natural ablation (same skill, different contexts reveals where it works vs fails). Implementation: extend `task_outcomes` with `trajectory: TrajectoryStep[]` field.

**Conservative editing principles** — From the paper's evolver prompts (directly usable): treat current skill as source of truth not rough draft; default to targeted edits not rewrites; distinguish skill vs agent vs environment problems; don't add generic best-practice advice (retry, rate-limiting) the agent should handle independently. Aligns with existing ACI design philosophy.

**Monotonic validation** — Candidate skill updates tested overnight against real tasks. Only improvements deployed. Skill pool never degrades. Implementation: extend overnight tuning `accept()` to require measurable improvement on held-out test set before merging variant.

### From persistent-mind-model (scottonanski/persistent-mind-model-v1.0)

**Commitment tracking for trade theses** — MemeGraph lifecycle (open → tracking → resolved/broken) maps to paper trading: thesis formed → trade entered → outcome tracked → thesis resolved or broken. Implementation: `trade_theses` table with status lifecycle, thesis text, evidence array, outcome, extracted lessons.

## Remaining Pre-Build Items

- [x] Alpha Vantage API key — premium tier, set in `.env`, verified 2026-04-11 (adjusted daily, FX, macro, indicators, news sentiment all working)
- [ ] FRED API key signup (before F5 — https://fred.stlouisfed.org/docs/api/api_key.html)
- [ ] 30-day v6 production validation (V7-READINESS-CRITERIA.md checklist — day 2/30, gate ~May 10)
