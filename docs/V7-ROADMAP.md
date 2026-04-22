# v7 Roadmap — Financial Intelligence + Feature Verticals

> Last updated: 2026-04-20 (session 87 — v7.14 `infographic_generate` shipped: editorial data-storytelling via `@antv/infographic@0.2.17` (MIT, pure-JS SSR through linkedom — no puppeteer, no Chromium, no G2/G6). 3-mode dispatch: `data` (structured, no LLM), raw DSL (short-circuit, no LLM), or NL → LLM → AntV DSL → render. 15-template curated recommendation set documented; full 276 validated at runtime via `getTemplates()`. Themes: light, dark (default, per `feedback_vlmp_ui_choice.md`), hand-drawn. Folded into existing `specialty` scope group. **Unusually clean integration, no scope pivot** — first γ sprint this day without a step-1-or-2 recon pivot (v7.2 / v7.10 / v7.12 all had one). 2 QA audit passes: round 1 caught 1 major (ES regex root mismatch — `infograph(?:ic|ía|ia)s?` forced a shared EN root `infograph` but ES uses `infograf`, so `infografía/infografias/infografías/infografia` all failed to match; fix was two separate alternations `infographics?|infograf[ií]as?`); round 2 clean PASS. Live smoke all 3 modes: raw DSL → 4KB SVG in 39ms; structured data → 5.2KB SVG in 25ms; NL → LLM (qwen 439 prompt / 74 completion / 3.2s) → 4KB SVG. CLAUDE.md dep count 13 → 14. Tool count 222 → 223. Deferrals to v7.14.1: PNG conversion via puppeteer, streaming render, retry-with-error-feedback, WhatsApp/Telegram delivery re-encoding validation. Previous: session 86 — v7.12 `diagram_generate` shipped (MVP): single deferred tool dispatching to `dot` (graphviz) or inline LLM (svg_html with Cocoon palette). Scope pivot during impl-plan step 2: mermaid-cli (mmdc) v11 AND v10.9.1 both hang with `ProtocolError: DOM.resolveNode timed out` on this VPS's puppeteer/Chromium (4+ min, 0 output on both versions). Mermaid deferred to v7.12.1 with trigger (mmdc fix OR Node-API replacement). D2 + PlantUML also deferred. Ships 2 formats: graphviz `dot -Tsvg` (<1s, deterministic auto-layout) + svg_html (LLM + Cocoon palette + JetBrains Mono, dark/light themes). New `diagram` scope group with EN+ES regex (diagrama/diagram/flowchart/flujograma/sequence diagram/digraph/etc.). 2 QA audit passes: round 1 clean (0 critical, 0 major, 6 warnings all mechanical cleanup — anchor `looksLikeDot` to start-of-string, clean up DOT temp via finally/unlinkSync, clean up tmpPath on rename-failure fallback, drop `/tmp` bare-equality branch, add boundary + rename-fallback tests); round 2 clean PASS verifying all 6 fixes + zero regressions. Live smoke: raw DOT → 1.8KB SVG in 36ms; NL → LLM (qwen 237→202 tokens) → DOT → dot → 4.4KB SVG in 6.2s. Third consecutive sprint (F8.1b, v7.2, v7.12) with step-1-or-2 recon pivot — now a recognized cadence, not exception. Previous: session 85 — v7.10 `file_convert` shipped: closes 5 format gaps (`.epub/.mobi` ebooks, `.odt/.rtf/.pages` office docs, HEIC/AVIF/JXL images, doc↔doc via pandoc, video frames via ffmpeg). Single new deferred tool dispatching via `execFile` no-shell to apt-installed binaries (calibre, libreoffice, pandoc, imagemagick, ffmpeg). Zero npm deps; ~2GB of apt binaries on the VPS. 2 QA audit passes closed 2 critical (symlink-bypass of input allow-list via statSync-follows-symlinks; `Infinity` timestamp reaching ffmpeg argv) + 2 major (UTILITY_TOOLS not covered by write-tools-sync test; ES `transforma` regex asymmetric with EN branch, over-corrected once then clitic-form broken) + 3 warnings (LibreOffice `--outdir` rename unification, silent-overwrite documentation, ES clitic regex W-R2-1). Live smoke: pandoc .md→.html 304B/152ms, imagemagick .png→.jpeg 336B/17ms, libreoffice .md→.docx→.pdf 31KB/2.4s (warm start), symlink /tmp/link→/etc/passwd correctly rejected. 2/13 γ items done. Previous: session 84 — v7.2 Graphify MCP shipped, **Phase γ opens**: TS-native integration of the `graphifyy==0.4.23` Python MCP server against an AST-built knowledge graph of `src/` (335 files → 1757 nodes, 4686 edges, 25 communities, 63% EXTRACTED / 37% INFERRED). 7 new deferred tools (`graphify-code__query_graph`, `_get_node`, `_get_neighbors`, `_get_community`, `_god_nodes`, `_graph_stats`, `_shortest_path`), 1 new scope group (`graph`, bilingual EN/ES with negative-lookahead on `graphic`/`graphene`/`paragraph`/`gráfica`). Isolated `./venv/graphify/` + pinned-version bootstrap script with CWD + version guards. 2 QA audit passes: round 1 closed 2 major (`god_nodes` literal didn't activate scope; no fresh-VPS bootstrap doc) + 4 warnings (weak test assertion, missing MCP manager test, unpinned internal API use, CWD assumption). Round 2 clean PASS. Live smoke: stdio MCP handshake end-to-end → graph_stats + god_nodes return semantically coherent results (`getDatabase()` top hub at 257 deg, matches codebase singleton pattern). Scope-shift-as-design-decision: pivoted from docs corpus to code at impl-plan step 4 after discovering `collect_files` doesn't handle markdown (requires skill-driven LLM semantic pass — deferred to v7.2.1). CRM graph + cross-source router + semantic-pass codebase graph all deferred to v7.2.1 with explicit triggers. **Phase γ S1 of 13 done.** Previous: session 83 — F8.1b PolymarketPaperAdapter shipped: TS-native Polymarket paper-trading adapter declining the pm-trader MCP (singleton-DB discipline + 660ms cold start + cross-language complexity). `PolymarketPaperAdapter implements VenueAdapter`, 3 new deferred tools (`pm_paper_rebalance` write + `pm_paper_portfolio` / `pm_paper_history` read), 3 new tables (`pm_paper_balance`, `pm_paper_portfolio`, `pm_paper_fills`), `Position` widened to `{kind:"equity"}|{kind:"polymarket"}` discriminated union with type guards. 2 QA audit passes closed 7 round-1 warnings (dust-filter blocked full-exits, no stale-abort gate, scope regex head-noun-first gap, test union access without narrowing) + 3 round-2 warnings (tool `allow_stale` parameter, aborted thesis metadata flag, NaN weight filter). Live smoke: $10K fresh cash → 1 BUY fill 186.54 sh @ 0.5361 (midpoint × 1+20bps) → thesis_id persisted → portfolio + history reflect correctly. Deferrals booked for F8.1b.2 (orderbook walking + NO-side shorting), F8.1c (F7.5 firewall integration + live pm-trader MCP + replication scoring). **Phase β-addendum 2/2 done; Phase γ opens.**

## Status Key

- **Done** — Implemented, tested, shipped
- **Active** — Currently in progress
- **Next** — Immediately next in queue
- **Planned** — Scoped and sequenced
- **Conditional** — Gated on a future decision or prerequisite
- **Blocked** — Dependencies unresolved

---

## Execution Phases (sequential)

| Phase | Scope                                           | Versions                                                            | Status                                                                  | Sessions             |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| α     | Infrastructure unblockers                       | v7.3 P1, v7.6, v7.7, v7.8 P1, v7.9                                  | **Done**                                                                | 5 shipped            |
| α.2   | Autoreason tournament decision (fixed date)     | v7.8 P2                                                             | **Done (Closed 2026-04-20 — avg_gap=0.029, Phase 3 declined)**          | 0.5 shipped          |
| β     | Financial Stack critical path (**v7.0 thesis**) | F1 → F2/F4/F5 → F3 → F6/F6.5 → v7.13 → F7 → F7.5 → F8 → F9          | **Done (12/12 original scope — F1-F6.5 + v7.13 + F7 + F7.5 + F8 + F9)** | ~11.5 seq / ~7–8 par |
| β-add | Polymarket coverage (post-F9, pre-γ)            | F8.1a (alpha) → F8.1b (adapter) → F8.1c (daily cadence)             | **Done** (3/3 shipped 2026-04-20 / 04-21)                               | 3.5                  |
| β-opt | Real-time crypto (parallel, optional)           | F10                                                                 | **Planned**                                                             | 1                    |
| γ     | Feature verticals (layered, no β interleave)    | v7.1, v7.2, v7.3 P2/P3/P4/P5, v7.4/v7.4.3, v7.5, v7.10–v7.12, v7.14 | **Deferred post-β-add**                                                 | ~14–15               |
| δ     | Live trading (requires 30+ days paper record)   | F11                                                                 | **Gated**                                                               | 2.5                  |
| ε     | Autoreason post-decision (conditional)          | v7.8 P3                                                             | **Declined 2026-04-20** (see Phase 2 outcome)                           | 0                    |

**Ordering invariants**

1. Tier C infrastructure already shipped — nothing to unblock β.
2. β is the v7.0 thesis. Nothing substitutes for shipping F1→F9.
3. **No γ interleave during β** (operator Decision 6, 2026-04-14). Phase γ starts after the β-addendum (F8.1a + F8.1b) closes, not immediately after F9.
4. v7.8 P2 is a date-triggered decision (2026-04-20 09:00 CDMX), independent of β position.
5. F11 is **not** inside β — it requires 30+ days of F8 paper-trading track record. Ships in Phase δ.
6. **β-addendum slot (F8.1a + F8.1b)** (operator Decision 7, 2026-04-20): Polymarket coverage executes AFTER F9 and BEFORE γ verticals. The equity pipeline gets its morning/EOD ritual first; then the prediction-market alpha layer + PolymarketPaperAdapter extend the same VenueAdapter architecture. This prevents β from "shipping" with a known structural gap (pm-trader MCP deferred) and keeps γ verticals as pure non-financial work.

---

## Master Sequence (upcoming)

| #   | Session        | Output                                                                                                                                                                                                                                                                                                               | Dep(s)              | Est. |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---- |
| 1   | S1 (**F1**)    | Data layer (Alpha Vantage + Polygon + FRED + 6 tables)                                                                                                                                                                                                                                                               | —                   | 1.7  |
| 2   | S2 (F2)        | Indicator engine (golden-file validated)                                                                                                                                                                                                                                                                             | F1                  | 1    |
| 3   | S3 (F4)        | Watchlist + market_quote/history tools                                                                                                                                                                                                                                                                               | F1                  | 1    |
| 4   | S4 (F5)        | Macro regime detection (AV + FRED)                                                                                                                                                                                                                                                                                   | F1                  | 0.5  |
| 5   | S5 (F3)        | Signal detector + market_signals                                                                                                                                                                                                                                                                                     | F2 + F4             | 1    |
| 6   | S6 (F6)        | Prediction markets + whale tracker                                                                                                                                                                                                                                                                                   | —                   | 1.5  |
| 7   | S7 (F6.5)      | Sentiment signals (F&G x2, funding, liq.)                                                                                                                                                                                                                                                                            | —                   | 0.7  |
| 8   | S8 (v7.13)     | Structured PDF ingestion (MinerU) — pre-F7 gate                                                                                                                                                                                                                                                                      | pgvector ✅         | 1.5  |
| 9   | S9 (F7) ✅     | Alpha combination engine — **shipped 2026-04-18**                                                                                                                                                                                                                                                                    | F3+F5+F6+F6.5+v7.13 | 2.5  |
| 10  | S10 (F7.5) ✅  | Strategy backtester (CPCV, PBO, DSR) — **shipped 2026-04-19**                                                                                                                                                                                                                                                        | F7 ✅               | 1    |
| 11  | S11 (F8) ✅    | Paper trading (VenueAdapter + PaperEquityAdapter) — **shipped 2026-04-20**                                                                                                                                                                                                                                           | F7.5 ✅             | 1.5  |
| 12  | S12 (F9) ✅    | Morning/EOD scan rituals + NYSE calendar + alert budget — **shipped 2026-04-20**                                                                                                                                                                                                                                     | F8 ✅ + F4          | 1    |
| 13  | S13 (F8.1a) ✅ | **Prediction-market alpha layer** — simplified 3-feature model (midpoint + sentiment tilt + optional whale flow) → Kelly-fraction weights → `pm_signal_weights`. **Shipped 2026-04-20.** Deferred F7.5 firewall integration to F8.1c.                                                                                | F6 + F6.5 + F7 ✅   | 1.5  |
| 14  | S14 (F8.1b) ✅ | **PolymarketPaperAdapter** — TS-native `VenueAdapter` (declines pm-trader MCP); midpoint × (1 ± 20bps) synthetic fills; `Position` widened to discriminated union; 3 tools + 3 tables. Orderbook walking + NO-side shorting deferred to F8.1b.2; F7.5 firewall + live MCP deferred to F8.1c. **Shipped 2026-04-20.** | F8.1a ✅ + F8 ✅    | 1    |

β subtotal: **~14.9 sessions sequential**, **~11 sessions with F2/F4/F5 + F6/F6.5 parallelized**.
β-addendum (S13–S14, F8.1a+b): **~2.5 sessions** — fires after F9, before Phase γ. Explicitly slotted per operator decision 2026-04-20: Polymarket coverage completes β before γ verticals begin.

F10 (crypto WS, optional) can slot in any time after F3 (≈1 session, parallel-capable).

---

# Phase α — Infrastructure Unblockers (Shipped)

> All α work is complete. These sections document shipped scope for history and reference; skim them only if you need implementation details. **Phase β (F1) is where execution continues.**

## v7.9 — Prometheus Sonnet Port — **Done**

> Shipped 2026-04-15 (session 70). Final α item before Phase β. Claude Sonnet 4.6 replaces qwen in Prometheus executor. Wrap-up in `feedback_v79_deferred_followups.md`.

| Item                                                                                          | Source    | Status       |
| --------------------------------------------------------------------------------------------- | --------- | ------------ |
| Prometheus executor model switched from qwen3-coder-plus → claude-sonnet-4-6                  | v7.9 plan | **Done**     |
| Token-usage propagation fix — ExecutionResult/GoalResult carry `tokenUsage` through all paths | —         | **Done**     |
| Reflector gap telemetry rebaselined on Sonnet output (gap distribution stable)                | —         | **Done**     |
| Rollback plan documented + Prometheus-watch-list for promotion gate                           | W4 defer  | **Done**     |
| Deferred follow-ups: 7 items (M1-M3, W2-W4, W7) with explicit defer rationale                 | QA audit  | **Deferred** |

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

## v7.8 Phase 2 — Autoreason Tournament Feasibility Decision — **Done (Closed)** — 2026-04-20

> **Outcome**: `avg_gap = 0.029` over 7-day window (threshold 0.10) → close thread. No tournament, no Phase 3. Decision doc: `docs/planning/phase-gamma/06-v7.8-p2-decision.md`. `reflector_gap_log` telemetry stays on as re-evaluation trigger.

| Item                                                                                                           | Source | Status                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| Query `reflector_gap_log` over 7-day window — avg_gap, max_gap, wide_gap_count, llm_fallback_count             | —      | **Done** (n=8, avg=0.029, wide=0, fallback=0)                  |
| Apply decision rules: `avg_gap < 0.10` → close; `wide_gap_count > 10%` → targeted pilot; `>25%` → global pilot | —      | **Done** (primary rule fired → close)                          |
| Verify k=2 stability rule actually fired (events `replan_deferred`); if zero, investigate before concluding    | —      | **Done** (0 events — all runs clean, no soft votes; not a bug) |
| Update memory + decide whether v7.8 Phase 3 proceeds                                                           | —      | **Done** (project memory flipped to DECIDED; Phase 3 declined) |
| Deactivate scheduled nudge `eb3e4b14`                                                                          | —      | **Done** (`active=0`)                                          |

---

## v7.8 Phase 3 — Autoreason Targeted Tournament Pilot — **Declined** (2026-04-20)

> Declined: Phase 2 data unambiguously met the close-thread rule (`avg_gap = 0.029`, `wide_gap_count = 0`). Tournament mode would be 6× compute per reflection for no demonstrated quality gain on our traffic. See `docs/planning/phase-gamma/06-v7.8-p2-decision.md` for re-evaluation triggers.

| Item                                                                                                       | Source          | Status       |
| ---------------------------------------------------------------------------------------------------------- | --------------- | ------------ |
| Identify task classes with widest gap (briefings, proposals, research syntheses)                           | Phase 2 data    | **Declined** |
| Build 3-candidate tournament (incumbent / adversarial revision / synthesis) for those classes only         | autoreason §2   | **Declined** |
| Fresh-agent judge panel (3 judges, Borda aggregation, incumbent-wins-ties)                                 | autoreason §2.1 | **Declined** |
| A/B compare tournament mode against current single-reflector path for 7 days, measure quality + cost delta | —               | **Declined** |

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

# Phase β — Financial Stack (v7.0 thesis) — NEXT

> Critical path. No γ interleave (Decision 6, 2026-04-14). Execute F1 → F2/F4/F5 (parallel) → F3 → F6/F6.5 → v7.13 → F7 → F7.5 → F8 → F9.
>
> Implementation-readiness: all 6 operator decisions locked (see `docs/planning/phase-beta/03-f1-preplan.md`). Credentials provisioned 2026-04-15 (Alpha Vantage, Polygon/Massive, FRED). Initial watchlist locked: 20 equities+ETFs + 3 FX + 6 macro series = 29 tracked symbols.

## v7.0 F1 — Data Layer (Alpha Vantage + Polygon + FRED) — **Done**

> Session 72 (2026-04-17). Critical path start. 1.7 sessions budgeted — shipped within budget. Pre-plan: `docs/planning/phase-beta/03-f1-preplan.md`. Impl plan: `docs/planning/phase-beta/14-f1-impl-plan.md`. Branch: `phase-beta/f1-data-layer`.

| Item                                                                                                      | Source         | Status                                 |
| --------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------- |
| 6-table schema: market_data, watchlist, backtest_results, trade_theses, api_call_budget, market_signals   | V7 spec        | **Done**                               |
| Alpha Vantage premium adapter — adjusted daily, intraday, FX, quote, macro, news sentiment                | V7 spec        | **Done**                               |
| Polygon.io/Massive fallback adapter — `api.massive.com` primary w/ `api.polygon.io` legacy alias via env  | F1 pre-plan D2 | **Done**                               |
| FRED adapter — VIX/ICSA/M2 (series AV doesn't expose)                                                     | F1 pre-plan D4 | **Done**                               |
| Data validation layer (H2) — price sanity, continuity ratio, volume anomaly warn-not-reject               | V7 hardening   | **Done**                               |
| Timezone normalization (H3) — NY ISO via `Intl.DateTimeFormat`, DST-safe for EDT↔EST transitions          | V7 hardening   | **Done**                               |
| api_call_budget tracking + 80% ceilings (AV 60/min, Polygon 4/min, FRED 100/min)                          | V7 spec        | **Done**                               |
| Boot-seed rate limiter from recent budget rows so restarts don't desync                                   | audit W2       | **Done**                               |
| L1 memory cache (FIFO-capped 500) + L2 market_data DB cache + in-flight dedup + stale-DB rescue           | design D-C     | **Done**                               |
| Primary→fallback dispatch with full budget logging on every attempt                                       | design D-E     | **Done**                               |
| `market_watchlist_{add,remove,list}` tools — D3 operator-friendly error surfaces                          | F1 pre-plan D3 | **Done**                               |
| `market_quote` / `market_history` / `market_budget_stats` tools                                           | V7 spec        | **Done**                               |
| `finance` scope group with 3 activation patterns ($SYMBOL + ES/EN verbs + watchlist CRUD)                 | F1 pre-plan D3 | **Done**                               |
| `normalizeSymbol` on all read/write paths + `redactApiKeys` at every adapter error-rethrow (audit C1/C2)  | audit C1/C2    | **Done**                               |
| 43 new tests (timezone 6 · validation 8 · FRED 4 · AV 8 · Polygon 6 · DataLayer 10 · write-tools-sync +1) | —              | **Done**                               |
| Smoke tests live: SPY 5 daily bars via AV w/ -04:00 EDT offset; VIXCLS 9166 FRED points                   | live           | **Done**                               |
| Live WhatsApp D3 acceptance test ("agrega TSLA a mi watchlist")                                           | F1 pre-plan D3 | **Deferred** (operator-run post-merge) |

---

## v7.0 F2 — Indicator Engine — **Done**

> Session 73 (2026-04-17), bundled with F4. Impl plan: `docs/planning/phase-beta/15-f2-f4-impl-plan.md`. Branch: `phase-beta/f2-f4-indicators-and-tools`.

| Item                                                                                                                 | Source       | Status                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------- |
| Pure-math indicators: SMA, EMA, RSI (Wilder), MACD (12/26/9), Bollinger (20,2 sample σ), VWAP, ATR, ROC, Williams %R | V7 spec      | **Done**                                                             |
| `latest()` utility — return last non-null value from indicator output                                                | F2 impl plan | **Done**                                                             |
| Null-leading semantics preserved (input-length = output-length)                                                      | design D-E   | **Done**                                                             |
| 28 tests — hand-computed happy paths + MACD/Bollinger invariants + golden-file cross-validation                      | design D-F   | **Done**                                                             |
| Hand-computed Bollinger(20,2) values verified at index 29 to 0.1 tolerance                                           | audit S1     | **Done**                                                             |
| RSI boundary behavior documented (avgLoss===0 && avgGain===0 → 50 neutral)                                           | audit S3     | **Done**                                                             |
| Golden-file tests — AV server-side validation                                                                        | V7 hardening | **Deferred** (acceptance-test concern; hermetic unit tests in place) |

---

## v7.0 F4 — Watchlist + Market Tools — **Done**

> Session 72 (F1) shipped watchlist CRUD + market_quote + market_history + market_budget_stats. Session 73 (F2+F4 bundle) added the indicator-consumer tools.

| Item                                                                                          | Source       | Status             |
| --------------------------------------------------------------------------------------------- | ------------ | ------------------ |
| Watchlist management (add/remove/list with tags + projected-budget guard)                     | V7 spec      | **Done** (S1 — F1) |
| `market_quote` tool — current snapshot via AV GLOBAL_QUOTE                                    | V7 spec      | **Done** (S1 — F1) |
| `market_history` tool — historical bars with interval + lookback filters                      | V7 spec      | **Done** (S1 — F1) |
| `market_budget_stats` tool — AV/Polygon/FRED consumption vs ceilings                          | V7 spec      | **Done** (S1 — F1) |
| `market_indicators` tool — compute 8/9 indicators on one symbol (VWAP auto-excluded on daily) | F4 impl plan | **Done** (S2)      |
| `market_scan` tool — scan watchlist by indicator threshold, operator-aware sort order         | F4 impl plan | **Done** (S2)      |
| Finance scope activation on indicator vocabulary (RSI, MACD, oversold, scan, etc. ES+EN)      | audit W1     | **Done** (S2)      |

---

## v7.0 F5 — Macro Regime Detection — **Done**

> Session 74 (2026-04-17), bundled with F3 per ordering-map Window B. Impl plan: `docs/planning/phase-beta/16-f5-f3-impl-plan.md`. Branch: `phase-beta/f5-f3-macro-and-signals`.

| Item                                                                                                               | Source   | Status   |
| ------------------------------------------------------------------------------------------------------------------ | -------- | -------- |
| Alpha Vantage macro pulls — FEDFUNDS, TREASURY_YIELD×2, CPI, UNEMPLOYMENT, NONFARM, REAL_GDP                       | V7 spec  | **Done** |
| FRED REST API — VIXCLS, ICSA, M2SL (dual source via existing F1 DataLayer.getMacro)                                | V7 spec  | **Done** |
| Regime classifier — expansion / tightening / recession_risk / recovery / mixed with hard/soft confidence           | V7 spec  | **Done** |
| Trend helpers: linearSlope, classifyTrend (rising/falling/flat/normalizing magnitude-scaled), yoyChange, staleness | impl     | **Done** |
| Severity-ranked conflict resolution (recession_risk > tightening > expansion > recovery) per audit W3              | audit W3 | **Done** |
| Yield-curve nearest-earlier-t2 lookup (handles daily/monthly cadence mismatch) per audit C1                        | audit C1 | **Done** |
| `macro_regime` tool with staleness warnings (≥6/8 empty series → WARNING header; ≥3 → NOTE)                        | audit W4 | **Done** |
| 16 new tests                                                                                                       | —        | **Done** |

---

## v7.0 F3 — Signal Detector — **Done**

> Session 74 (2026-04-17), bundled with F5.

| Item                                                                                                      | Source      | Status   |
| --------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| 6 detectors: ma_crossover, rsi_extreme, macd_crossover, bollinger_breakout, volume_spike, price_threshold | V7 spec     | **Done** |
| Fire-once semantics (sign change / zone entry / re-entry), not per-bar while-held                         | audit L     | **Done** |
| detectAllSignals aggregator returning chronologically sorted merged list                                  | impl        | **Done** |
| persistSignals with transactional INSERT + SELECT-then-INSERT dedup on (symbol,type,triggered_at)         | impl        | **Done** |
| `market_signals` tool — single-symbol or whole-watchlist scan, 50-symbol cap + 3-rate-limit early exit    | audit W5    | **Done** |
| market_signals scan persists firings to market_signals table for F7 alpha-combination consumption         | V7 spec     | **Done** |
| price_threshold direction follows cross direction (long/short, not neutral) per audit I4                  | audit I4    | **Done** |
| Transmission chain field — empty array at F3, F7/F8 populate                                              | V7 spec     | **Done** |
| Scope regex: 2 new activation patterns (macro vocab + signals vocab) ES+EN                                | audit W6+I1 | **Done** |
| auto-persist Rule 2b: `market_signals` output persisted for follow-up turns                               | impl        | **Done** |
| 22 signal-detector tests + 8 tool tests + 6 scope tests = 36 new                                          | —           | **Done** |

---

## v7.0 F6 — Prediction Markets + Whale Tracker — **Done**

> Session 75 (2026-04-17), bundled with F6.5 per ordering-map Window B. Impl plan: `docs/planning/phase-beta/17-f6-f6.5-impl-plan.md`. Branch: `phase-beta/f6-f6.5-external-signals`.

| Item                                                                                             | Source         | Status                                                                                                |
| ------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------- |
| Polymarket Gamma + CLOB read adapter — active markets, events, market-by-slug, recent trades     | V7 spec        | **Done**                                                                                              |
| `prediction_markets` tool — search/list/event-group with negRisk propagation                     | V7 spec        | **Done**                                                                                              |
| Whale tracker from Polymarket trade history — extractWhalesFromTrades with $5k default threshold | V7 spec        | **Done**                                                                                              |
| `whale_trades` tool — DB query default, optional fetch_live for specific market                  | impl           | **Done**                                                                                              |
| **Stage A — polymarket-cli read-side enrichments** (from `reference_polymarket_cli.md`):         | polymarket-cli | —                                                                                                     |
| Negative-risk market flag — is_neg_risk column + event-level propagation                         | polymarket-cli | **Done**                                                                                              |
| Gamma events API — event-level grouping (all markets for one election)                           | polymarket-cli | **Done**                                                                                              |
| Market-metadata surface — question, category, resolution_date, volume_usd, liquidity_usd stored  | polymarket-cli | **Done**                                                                                              |
| Builder-leaderboard API                                                                          | polymarket-cli | **Deferred** (lightweight read addition; F7 follow-up)                                                |
| Kalshi API adapter — regulated US prediction markets                                             | V7 spec        | **Deferred** (scope fence per impl plan; non-goal for v7.0 launch)                                    |
| SEC EDGAR insider filings (Form 4 XBRL)                                                          | V7 spec        | **Deferred** (separate integration effort; fold into F7 follow-up if whale-consensus signal needs it) |

---

## v7.0 F6.5 — Sentiment Signals — **Done**

> Session 75 (2026-04-17), bundled with F6.

| Item                                                                                                         | Source   | Status                                                                   |
| ------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| Fear & Greed Index (alternative.me API) — `fetchAltMeFearGreed`                                              | V7 spec  | **Done**                                                                 |
| CoinMarketCap F&G dual source — pro-key path + public data-api fallback, per Decision 5 (2026-04-14)         | F1 D5    | **Done**                                                                 |
| Crypto funding rates via Binance premiumIndex — 3 symbols (BTC/ETH/SOL USDT perps)                           | V7 spec  | **Done**                                                                 |
| Composite `sentiment_snapshot` tool — graceful per-source degradation, contrarian interpretation at extremes | impl     | **Done**                                                                 |
| `cmcProApiKey` config binding + `CMC_PRO_API_KEY` env — audit W1 closure                                     | audit W1 | **Done**                                                                 |
| sentimentSnapshotTool persists readings to `sentiment_readings` table on every call for F7 consumption       | audit W2 | **Done**                                                                 |
| Liquidation heatmaps — forced selling cascades                                                               | V7 spec  | **Deferred** (requires paid data source; F7 enhancement if value proven) |
| Stablecoin flows — money entering/leaving crypto                                                             | V7 spec  | **Deferred** (complex on-chain analytics; F7/F8 if needed)               |

---

## v7.0 F7 — Alpha Combination Engine — **Done**

> Session 77 (2026-04-18). 11-step FLAM pipeline with Fama-MacBeth scalar-β reading of Step 9 (N×(M−1) multivariate interpretation underdetermined at production dimensions — see impl plan §D-F). Schema additions: `signal_weights` + `signal_isq` tables (additive, no DB reset). Tools: `alpha_run` (write), `alpha_latest` + `alpha_explain` (read). Scope group `alpha`. Impl plan: `docs/planning/phase-beta/19-f7-impl-plan.md`. Branch: `phase-beta/f7-alpha-combination`.

| Item                                                                                                                                                                    | Source                | Status                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| 11-step FLAM pipeline — serial demean → variance (Bessel) → normalize → truncate → cross-sectional demean → momentum (d=20) → scalar-β OLS → weight → Σ\|w\|=1          | V7 spec               | **Done**                                                                 |
| `alpha-linalg.ts` primitives — scalar OLS no-intercept, correlation matrix, vector helpers (~150 LOC, zero new deps)                                                    | impl                  | **Done**                                                                 |
| `buildReturnMatrix()` — signal identity `{type}:{symbol}`, direction-adjusted R, missing-close flagging, >5% flagged → exclude pre-pipeline                             | impl + addendum P1    | **Done**                                                                 |
| ISQ (Ingredient Signal Quality) — 5 dimensions (efficiency/timeliness/coverage/stability/forward_ic), all clamped [0,1]                                                 | addendum P4           | **Done**                                                                 |
| Per-signal IC tracking with flagged-day skip (audit W8) + benefit-of-doubt for <30 firings                                                                              | addendum P8.4 + audit | **Done**                                                                 |
| Correlation guard (supersedes addendum Jacobi/Cholesky — not needed under scalar-β) — pair-max \|corr\|>0.95 iterative exclusion, 3-iter cap → F7CorrelatedSignalsError | impl + addendum P5    | **Done**                                                                 |
| Weight versioning — append-only `signal_weights` table with UNIQUE(run_id, signal_key) + idx                                                                            | addendum P3           | **Done**                                                                 |
| Tool surface (3 deferred tools): `alpha_run` / `alpha_latest` / `alpha_explain`                                                                                         | impl                  | **Done**                                                                 |
| Golden-file regression fixture (`f7-golden-3x10.json`) + generator script + regression test with 1e-6 tolerance                                                         | impl                  | **Done**                                                                 |
| 92 new tests (18 linalg + 16 matrix + 14 isq + 21 combination + 13 tool + 1 write-tools-sync subtest) — 2508 → 2603                                                     | impl + audit          | **Done**                                                                 |
| 2-pass QA audit (Round 1: 3 Critical + 8 Warning + 4 Standards + 7 Recommendations; Round 2: 3 Warnings, 0 Critical, 0 regressions)                                     | audit                 | **Done**                                                                 |
| Live smoke: `alpha_run` on real `market_signals` data → Σ\|w\|=1.000000 exact, 4 signals, 3ms duration, persisted                                                       | smoke                 | **Done**                                                                 |
| Triple-barrier labeling — TP/SL/time barriers w/ volatility-scaled thresholds; sample-weight-by-uniqueness; augments FinRL-X forward-log-return labels                  | de Prado (AFML ch.3)  | **Deferred** (F7.5 backtester concern; F7 v1 uses simpler return matrix) |
| Meta-labeling — secondary classifier predicts bet/pass on primary direction                                                                                             | de Prado (AFML ch.3)  | **Deferred** (F7.5 or post-launch)                                       |
| Purged k-fold CV with embargo — replaces FinRL-X's walk-forward-only validation                                                                                         | de Prado (AFML ch.7)  | **Deferred** (F7.5 backtester owns this)                                 |
| Kelly sizing — moves to F8 per addendum P8.3 (sizing ≠ combination; depends on mid-price + CV_edge Monte Carlo)                                                         | addendum P8.3         | **Deferred → F8**                                                        |
| Probability mode — schema column + `mode` parameter shipped; pipeline throws `NotImplementedError`. Unlocks when F6/F6.5.x persist probability time-series              | addendum P8.2         | **Deferred → F6.5.x**                                                    |
| Regime-conditional weights — `regime` column present, not branched on. Post-launch once ≥30 runs per regime class exist                                                 | addendum P7           | **Deferred** (post-launch)                                               |
| PCA singularity fallback — current guard uses correlation-matrix exclusion. Revisit in F7.5 if aborts become frequent                                                   | addendum P5           | **Deferred** (F7.5)                                                      |

---

## v7.0 F7.5 — Strategy Backtester — **Done**

> Shipped session 79 (2026-04-19). Impl plan: `docs/planning/phase-beta/20-f7.5-impl-plan.md`. Branch: `phase-beta/f75-backtester`. 2 QA audit passes. Live smoke on 10-symbol × 520-weekly-bar seed produced walk-forward Sharpe 0.26, cum return +32% / 10 yr, PBO 0.27, DSR_pvalue 0.20 — honestly ship-blocked by DSR firewall. 2.7s runtime.

| Item                                                                                                                          | Source                | Status                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------- |
| Walk-forward replay — windowM rolling, rebalance_bars=1 weekly, transaction-cost model                                        | V7 spec               | **Done**                                            |
| CPCV — N=6 groups × k=2 test → 15 folds; embargo=horizon weekly bars; default 24-trial grid                                   | de Prado (AFML ch.12) | **Done**                                            |
| PBO — Bailey/de Prado 2014 logit, rank<(N+1)/2 check (audit C1 round 1); ship-gate at > 0.50                                  | Bailey/de Prado 2014  | **Done**                                            |
| Deflated Sharpe Ratio (DSR) — eq. 14 with de-annualization via √periodsPerYear (audit C2 round 1); ship-gate at pvalue > 0.05 | Bailey/de Prado 2014  | **Done**                                            |
| 3 new tables (additive, live-applied): `backtest_runs`, `backtest_paths`, `backtest_overfit`                                  | —                     | **Done**                                            |
| 3 new tools — `backtest_run` (write), `backtest_latest` (read), `backtest_explain` (read); all deferred, new `backtest` scope | ACI pattern           | **Done**                                            |
| Ship-gate with NaN = blocked (audit C3 round 1)                                                                               | —                     | **Done**                                            |
| Stress test scenarios (2008, 2020, rate shock, credit crisis, liquidity dry-up)                                               | V7 spec               | **Deferred** (F7.5.1; needs ≥8 yr of ingested data) |
| Triple-barrier labeling, meta-labeling, regime-conditional PBO, Monte Carlo bootstrap, Kelly-sized P&L, order-book slippage   | de Prado (AFML ch.3)  | **Deferred** (F7.5.1 / F8 per plan §9 triggers)     |

---

## v7.0 F8 — Paper Trading (VenueAdapter + PaperEquityAdapter) — **Done**

> Shipped session 80 (2026-04-20). Impl plan: `docs/planning/phase-beta/21-f8-impl-plan.md`. Branch: `phase-beta/f8-paper-trading`. 2 QA audit passes.
>
> **Scope-shift from original §F8 spec**: pm-trader MCP (Polymarket-focused) deferred to F8.1 because the 2026-04-18 weekly-equity lock on F7/F7.5 means F7 now produces equity weights, not prediction-market positions. F8 v1 ships the VenueAdapter + Clock + PaperEquityAdapter architecture so future Polymarket / live adapters slot in without refactor. See plan §0 for rationale.
>
> **Live smoke** (ship_gate override, since F7.5 currently blocks on DSR=0.20): 4 fills landed against the seeded dataset (TLT/SPY/JPM/AAPL), 6 short-sell rejects (F7 produced negative weights, v1 rejects shorts per plan), portfolio mark-to-market consistent, thesis row persisted.

| Item                                                                                                                                                                                           | Source                         | Status                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `VenueAdapter` TS interface — shared Order/Fill/Position/Balance/MarketQuote domain model; `placeOrder/getPositions/getBalance/getFills/getMarketData`                                         | `reference_nautilus_trader.md` | **Done**                                                  |
| Clock abstraction — `WallClock` (paper default) + `FixedClock` (tests); strategies read `clock.now()`, never `new Date()`                                                                      | `reference_nautilus_trader.md` | **Done**                                                  |
| `PaperEquityAdapter` — first concrete VenueAdapter; AV-backed market data via `DataLayer.getWeekly`; synthetic fills at close × slippage; atomic cash + portfolio updates via `db.transaction` | impl                           | **Done**                                                  |
| Execution engine (`paper-executor.ts`) — weekly rebalance: read F7 weights → check F7.5 ship_gate → diff vs current → SELLS before BUYS → persist thesis → back-link fills by fill_id          | impl                           | **Done**                                                  |
| 3 new additive tables: `paper_balance`, `paper_portfolio`, `paper_fills`; reuse existing `trade_theses` with `symbol='PORTFOLIO'` sentinel                                                     | impl                           | **Done**                                                  |
| 3 new deferred tools — `paper_rebalance` (write), `paper_portfolio` (read), `paper_history` (read); new `paper` scope group with ES+EN regex                                                   | ACI pattern                    | **Done**                                                  |
| Ship-gate enforcement — refuses to trade when F7.5 `ship_blocked=1` unless `override_ship_gate=true`; override logged in thesis row                                                            | impl                           | **Done**                                                  |
| Stale-quote abort — refuses to rebalance when held positions have stale marks (>5 weeks); `override_stale=true` bypass with visible warning (audit W2/W-R2-2/W-R2-3)                           | audit r1+r2                    | **Done**                                                  |
| Transaction cost model — fixed 5 bps slippage per side + configurable commission; matches F7.5 backtest default to minimize divergence                                                         | impl                           | **Done**                                                  |
| Fractional-share support — 4dp precision so low-weight positions aren't rounded to zero                                                                                                        | impl                           | **Done**                                                  |
| Target cash buffer — derate target notional by 20 bps so buys still fit after slippage; MIN_REBALANCE_FRACTION=25 bps prevents buffer-dust churn                                               | impl                           | **Done**                                                  |
| pm-trader MCP server integration (Polymarket paper, 30 tools stdio)                                                                                                                            | V7 spec                        | **Moved to F8.1b** (queued after F9, operator Decision 7) |
| Replication scoring vs Polymarket whales                                                                                                                                                       | V7 spec                        | **Moved to F8.1b** (same sprint)                          |
| Research-to-live parity reconciliation test                                                                                                                                                    | `reference_nautilus_trader.md` | **Deferred** (F11; needs live adapter to compare)         |
| Shared execution event bus (fill/reject/market-data events)                                                                                                                                    | `reference_nautilus_trader.md` | **Deferred** (F8.2 if operator requests)                  |
| Multi-account A/B testing                                                                                                                                                                      | V7 spec                        | **Deferred** (F8.2; schema keeps `account` column)        |
| LIMIT / STOP order types, margin, short-sell, options, tax-lot tracking                                                                                                                        | —                              | **Deferred** (out of v7.0 scope)                          |

---

## v7.0 F8.1 — Polymarket Coverage (β-addendum) — **Done**

> 2.5 sessions total across two sprints (F8.1a + F8.1b). Fires AFTER F9 ships, BEFORE Phase γ starts (operator Decision 7, 2026-04-20). Extends the VenueAdapter architecture shipped in F8 to prediction markets so β closes with complete Polymarket coverage, not just equities.
>
> **Why post-F9, not between F8 and F9**: F9 is the operational top of the equity pipeline — once the morning/EOD ritual fires with a real equity portfolio, operators have a complete end-to-end flow they can exercise daily. F8.1 then extends that flow laterally (prediction markets as a second venue) without breaking the demonstrated equity path.
>
> **Why not deferred to γ**: pm-trader MCP was explicitly listed in the original V7-ROADMAP §F8 scope; shipping F8 without it leaves a known structural gap. Closing that gap is still "finance stack" work, semantically β, not γ (which is non-financial verticals).

### F8.1a — Prediction-Market Alpha Layer — **Done** (2026-04-20)

Shipped as a simplified v1 (3 features, not 11). Impl plan: `docs/planning/phase-beta/23-f8.1a-impl-plan.md`. Branch: `phase-beta/f81a-pm-alpha`. 2 QA audit passes. Live smoke on 20-market seed → 40 rows persisted, 26 active / 14 excluded (8 `extreme_price` + 6 `already_resolved`); zero exposure because seeded markets are non-crypto → sentiment tilt doesn't apply (honest signal, not a bug).

| Item                                                                                                                                                                                                              | Source                                 | Status                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pm-alpha.ts` — simplified 3-feature model (crowd midpoint + sentiment tilt (crypto-UP binary markets only) + optional whale flow z-scored + tanh-squashed); clip per-token + total-exposure; 8 exclusion reasons | V7 spec                                | **Done**                                                                                                 |
| `pm_signal_weights` table (additive, live-applied) — per-run per-token rows with features + edge + kelly_raw + weight + exclusion reason                                                                          | impl                                   | **Done**                                                                                                 |
| `pm_alpha_run` (write) + `pm_alpha_latest` (read) — 2 deferred tools; new `pm_alpha` scope group (ES+EN regex distinct from F7's `alpha`)                                                                         | ACI                                    | **Done**                                                                                                 |
| Kelly-fraction sizing for binary outcomes — `kelly_raw = edge / b` where `b = (1-p)/p`; clipped per-token + total-exposure; 20bps default per token, 30% default total                                            | Bailey/de Prado / V7 spec              | **Done**                                                                                                 |
| Seed precursor: existing `prediction_markets` + `sentiment_snapshot` tools populated 20 markets + 2 F&G readings. `whale_trades` remains 0 rows (polling deferred); signal wired but inactive                     | —                                      | **Done**                                                                                                 |
| F7.5 firewall integration (CPCV/PBO/DSR for `pm_alpha` strategy)                                                                                                                                                  | F7.5                                   | **Deferred** (F8.1c — F7.5 bar-return-shaped; PM needs event-level P&L; adaptation is a separate sprint) |
| FLAM-like 11-step pipeline with IC filter + correlation guard + ISQ dimensions                                                                                                                                    | F7 spec                                | **Deferred** (requires firing history; F8.2+ if operator requests after PM data accumulates)             |
| Token-universe resolver at tool boundary; Polymarket Gamma API live-fetch                                                                                                                                         | `reference_polymarket_paper_trader.md` | **Deferred** (F8.1b will add the live fetch path on the adapter side)                                    |

### F8.1c — PM-Native Cadence + NO-Side Shorting + Quote Refresh — **Done** (2026-04-21)

Shipped session 89. Impl plan: `docs/planning/phase-beta/25-f8.1c-impl-plan.md`. 2 QA audit passes.

**Operator constraint (2026-04-21)**: "Weekly is good enough for equities and macro variables, but not for PolyMarket." F8.1a + F8.1b inherited the F7 weekly-equity cadence; this sprint adds a PM-native daily cadence, NO-side shorting via negative α-weights (was exit-only in v1), and a parametrized staleness gate that uses 24h for daily cadence (5d default preserved for weekly).

| Item                                                                                                                                                                                                                                                                                     | Source         | Status                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cadence: "weekly"\|"daily"` threaded through `PmRebalanceOpts` → `insertPmPortfolioThesis` → `trade_theses.entry_signal='pm_${cadence}_rebalance'`. Default "weekly" preserves F8.1b behavior                                                                                           | impl           | **Done**                                                                                                                  |
| `PolymarketPaperAdapter.quoteStaleMs` constructor param — daily ritual uses 24h, <=0/NaN/non-finite clamps to 5d default                                                                                                                                                                 | impl           | **Done**                                                                                                                  |
| NO-side shorting via target-rewriting: negative α-weight on `Yes` resolves `complementOutcome → No`, fills via existing buy-path on the NO token. Multi-outcome (>2) markets log `multi_outcome_short_unsupported` and skip                                                              | impl           | **Done**                                                                                                                  |
| `marketOutcomeCount` guard queries `prediction_markets.outcome_tokens` to enforce binary-only shorting (round 1 W1 fix)                                                                                                                                                                  | audit W1       | **Done**                                                                                                                  |
| `complementOutcome` supports EN pairs (Yes/No, True/False, Up/Down) + ES (Sí/No) with case preservation                                                                                                                                                                                  | impl           | **Done**                                                                                                                  |
| `pm_paper_rebalance` tool — new `cadence` enum param, builds adapter with cadence-specific `quoteStaleMs`, surfaces cadence in log line                                                                                                                                                  | ACI            | **Done**                                                                                                                  |
| `pm-daily-rebalance` ritual — `src/rituals/pm-daily-rebalance.ts` (NEW) + config.ts cron `0 6 * * * America/New_York` (daily incl weekends, NOT gated by NYSE trading-day check). Ritual task runs: `prediction_markets limit=100` → `pm_alpha_run` → `pm_paper_rebalance cadence=daily` | impl           | **Done**                                                                                                                  |
| Executor file header + tool description updated to reflect F8.1c behavior (dropping stale v1 "exit-only" language)                                                                                                                                                                       | audit W2       | **Done**                                                                                                                  |
| Executor-level test: 25h-old held position + 24h adapter → `stalePositionsAborted=true` (end-to-end, not just adapter-level)                                                                                                                                                             | audit M3       | **Done**                                                                                                                  |
| Scheduler dispatch test: drives `pm-daily-rebalance` callback, asserts `mockSubmitTask` called with correct title (not false-positive void-wrapper)                                                                                                                                      | audit MAJ-R2-1 | **Done**                                                                                                                  |
| Live smoke: 10k USDC fresh account, binary market at YES=0.535, negative α weight −0.03 → buy 643.87 NO @ 0.465 → thesis `entry_signal='pm_daily_rebalance'` persisted                                                                                                                   | live           | **Done**                                                                                                                  |
| F7.5 firewall adaptation for event-level P&L (CPCV/PBO/DSR reshaped from bar-returns to event-outcomes)                                                                                                                                                                                  | F7.5           | **Deferred** (F8.1d — algorithmic, separate sprint)                                                                       |
| Orderbook walking / level-by-level fills                                                                                                                                                                                                                                                 | impl           | **Deferred** (F8.1d — trigger: measured midpoint-vs-live slippage >50bps over ≥10 fills)                                  |
| pm-trader MCP subprocess integration                                                                                                                                                                                                                                                     | V7 spec        | **Declined** (F8.1b rationale reaffirmed: singleton-DB + 660ms cold-start + cross-language opacity; no trigger to reopen) |
| Cross-venue unified `paper_rebalance` / `paper_portfolio`                                                                                                                                                                                                                                | V7 spec        | **Deferred** (F8.1d — trigger: both venues ≥30d independent paper record)                                                 |
| Whale replication scoring                                                                                                                                                                                                                                                                | V7 spec        | **Deferred** (F8.1e — trigger: `whale_trades` ≥1k rows + forward-return correlation measurable)                           |
| Continuous Gamma fetch (not just at rebalance)                                                                                                                                                                                                                                           | impl           | **Deferred** (F8.1e — trigger: daily-rebalance staleness abort rate >10% in 14d)                                          |

---

### F8.1b — PolymarketPaperAdapter — **Done** (2026-04-20)

Shipped session 83. Impl plan: `docs/planning/phase-beta/24-f8.1b-impl-plan.md`. Branch: `phase-beta/f81b-pm-adapter`. 2 QA audit passes.

**Scope shift**: declined the pm-trader MCP integration. Rationale (impl plan §0): (1) pm-trader is its own SQLite singleton — embedding via MCP subprocess violates the one-DB discipline at root; (2) cold-start cost (~660ms per subprocess spawn) is intolerable on the ritual path; (3) cross-language mutual observability gap — Python MCP errors would surface as opaque tool failures, not debuggable TS stacks. The replacement is a TS-native adapter with synthetic midpoint fills; operator gets Polymarket paper-trading without the operational surface area of a second DB.

| Item                                                                                                                                                                                                                                                       | Source                                           | Status                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| `PolymarketPaperAdapter: VenueAdapter` (`src/finance/pm-paper-adapter.ts`, ~310 LOC) — `getMarketData` reads `prediction_markets.outcome_tokens` midpoint; `placeOrder` fills synthetically at midpoint × (1 ± 20 bps); atomic db.transaction per buy/sell | impl                                             | **Done**                                                                                                                                                       |
| `Position` discriminated union — `{kind:"equity"}\|{kind:"polymarket"}` with `isEquityPosition` / `isPolymarketPosition` guards; PaperEquityAdapter, paper-executor, paper-trading all migrated to narrow at boundaries                                    | impl                                             | **Done**                                                                                                                                                       |
| `runPmRebalance` orchestrator (`src/finance/pm-paper-executor.ts`) — reads `pm_alpha_latest`, sizes per `                                                                                                                                                  | weight                                           | × total_equity × (1 − 20bps cash buffer)`, sells-first ordering, persists `trade_theses` `entry_signal='pm_weekly_rebalance'`with`aborted` flag on stale-abort | impl | **Done** |
| 3 new tools — `pm_paper_rebalance` (write, `allow_stale` passthrough), `pm_paper_portfolio` (read), `pm_paper_history` (read); new `pm_paper` scope group with ES+EN regex including head-noun-first phrasings                                             | ACI                                              | **Done**                                                                                                                                                       |
| 3 new additive tables — `pm_paper_balance`, `pm_paper_portfolio`, `pm_paper_fills`                                                                                                                                                                         | schema                                           | **Done**                                                                                                                                                       |
| Full-exit sells bypass the $10 dust filter so stranded penny positions always clear                                                                                                                                                                        | audit W1                                         | **Done**                                                                                                                                                       |
| Stale-position abort gate — if any held position has `stale=true` (>5d old or missing quote), orders are skipped; `allow_stale=true` lifts the gate; thesis row still persists with `aborted: true` metadata                                               | audit W2                                         | **Done**                                                                                                                                                       |
| `TARGET_CASH_BUFFER_BPS = 20` — targetNotional derated by 20 bps so slip + rounding can't drive cash negative                                                                                                                                              | audit W3                                         | **Done**                                                                                                                                                       |
| NaN weight filter in the tool handler — `Number.isFinite(t.weight)` check prevents bogus `zero_quantity` rejects on malformed `pm_signal_weights` rows                                                                                                     | audit round-2 W3                                 | **Done**                                                                                                                                                       |
| Integration wiring — `PM_PAPER_TOOLS` export, scope dispatch, `WRITE_TOOLS` inclusion, `auto-persist.ts` Rule 2b, `write-tools-sync.test.ts` assertion, registry registration                                                                              | impl                                             | **Done**                                                                                                                                                       |
| Orderbook walking + level-by-level fill simulation                                                                                                                                                                                                         | `reference_polymarket_paper_trader.md` pattern 1 | **Deferred** (F8.1b.2)                                                                                                                                         |
| Negative weights open NO-side positions (instead of exit-only at v1)                                                                                                                                                                                       | impl                                             | **Deferred** (F8.1b.2)                                                                                                                                         |
| Cross-venue unified `paper_rebalance` + `paper_portfolio`                                                                                                                                                                                                  | V7 spec                                          | **Deferred** (F8.1c — requires shared executor; tools stay parallel at v1)                                                                                     |
| pm-trader MCP wrapping + live Polymarket Gamma API fetch                                                                                                                                                                                                   | V7 spec                                          | **Deferred** (F8.1c — scope-shift decision documented in impl plan §0)                                                                                         |
| F7.5 firewall integration (CPCV/PBO/DSR for PM strategy)                                                                                                                                                                                                   | F7.5                                             | **Deferred** (F8.1c — bar-return shape vs event-level P&L adaptation)                                                                                          |
| Replication scoring vs Polymarket whales                                                                                                                                                                                                                   | V7 spec                                          | **Deferred** (F8.1c — needs live whale-flow data)                                                                                                              |

**Explicit non-goals for F8.1**: F11 live Polymarket trading (requires 30+ days paper record), order-book-depth-aware slippage for equities (F11 concern), multi-resolution event joins (F9 ritual concern).

---

## v7.0 F9 — Morning/EOD Scan Rituals — **Done**

> Shipped session 81 (2026-04-20). Impl plan: `docs/planning/phase-beta/22-f9-impl-plan.md`. Branch: `phase-beta/f9-rituals`. 2 QA audit passes.
>
> **Phase β closes** on its original 12-item scope with F9 merged. β-addendum (F8.1a prediction-market alpha layer → F8.1b PolymarketPaperAdapter, per operator Decision 7) queues next before Phase γ opens.

| Item                                                                                                                                                                                         | Source   | Status   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| `src/finance/market-calendar.ts` — NYSE 2024–2027 holidays + early-close dates; `isNyseTradingDay` / `isEarlyClose` / `nextTradingDay` / `prevTradingDay` helpers; America/New_York anchored | impl     | **Done** |
| `src/rituals/alert-budget.ts` — per-ritual daily token budget; `consumeBudget` + `getBudgetStatus` + `recordRitualTokensForTask` wired into router task.completed + task.failed              | impl     | **Done** |
| `market-morning-scan` ritual — cron `0 8 * * 1-5` America/New_York; reads macro_regime, alpha_latest, backtest_latest, paper_portfolio, intel_query, market_signals; Telegram + email        | V7 spec  | **Done** |
| `market-eod-scan` ritual — cron `30 16 * * 1-5` America/New_York; reads market_history, paper_portfolio, paper_history, intel_query; Friday-only rebalance nudge section                     | V7 spec  | **Done** |
| 2 new read tools — `market_calendar`, `alert_budget_status`; new `market_ritual` scope group with ES+EN regex                                                                                | ACI      | **Done** |
| Scheduler-level trading-day gate — `executeRitual` short-circuits market rituals when `isNyseTradingDay(today)` is false (belt-and-braces with LLM prompt gate)                              | audit W4 | **Done** |
| Per-ritual timezone override (`RitualDefinition.timezone?`) — market rituals use America/New_York so 8 AM / 4:30 PM track NYSE hours across DST                                              | audit W1 | **Done** |
| Ritual delivery via `router.watchRitualTask` → `broadcastToAll` — final task-output text is the Telegram message; no `telegram_send` tool needed (audit C1 removed phantom reference)        | impl     | **Done** |
| End-to-end reachability tests — every tool name in ritual templates resolves in the real registry (catches round-1 C1-class regressions)                                                     | audit R1 | **Done** |

---

## v7.0 F10 — Real-Time Crypto WebSocket — **Planned** (optional)

> 1 session. Parallel from F3. Optional — defer if not needed at v7.0 launch.

| Item                                                                                                      | Source                                   | Status      |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| Binance WebSocket adapter — tick-level BTC/ETH/SOL/etc. Implemented as `VenueAdapter`-compliant (see F8). | V7 spec + `reference_nautilus_trader.md` | **Planned** |
| Real-time signal dispatch (bypass polling for crypto watchlist)                                           | V7 spec                                  | **Planned** |

---

# Phase γ — Feature Verticals (deferred until post-F9 per Decision 6)

> Layered on top of Phase β. No γ work interleaves into β. When γ opens (post-F9), start with items that have no β dependencies (v7.2 graph, v7.3 P4 ads, v7.10–v7.12, v7.14). v7.1 charts + v7.3 P3 AI overview need β F1/F3 data. v7.5 skill evolution needs F9 trace data — ships last in γ.

## v7.1 — Chart Rendering + Vision Chart Patterns — **Done**

> Session 88 (2026-04-20). Phase γ S5. Impl plan: `docs/planning/phase-gamma/05-v7.1-impl-plan.md`. Reference: `reference_quantagent.md`.
>
> **Scope pivot (mid-session)**: pre-explore chose lightweight-charts + Playwright for PNG rendering. Live smoke failed — headless Chromium on this VPS crashes the renderer process on any non-trivial page load (same class as v7.12's mermaid-cli hang; confirmed via minimal `data:text/html` test). Pivoted to a pure-TS SVG string builder (~250 LOC). Zero browser dep; PNG path delegates to ImageMagick `convert` (already apt-installed from v7.14.1). Live verified: SPY 60-bar daily SVG with SMA50+Bollinger in 4ms (15.5KB); AAPL PNG via convert in 393ms (71KB).

| Item                                                                                                                                           | Source      | Status                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| Pure-TS SVG candlestick renderer (`chart-svg.ts`, ~250 LOC, no browser, no canvas, no deps)                                                    | pivot       | **Done**                                                                   |
| Candlestick + indicator overlays (SMA20/50/200, EMA20/50, Bollinger, VWAP) + signal markers (buy/sell/note arrows)                             | V7 spec     | **Done**                                                                   |
| Vision chart pattern recognition (`market_chart_patterns` tool) — vision LLM classifies PNG into named formation + confidence + candle range   | quantagent  | **Done**                                                                   |
| Trend-channel-fitting algorithm — pivot detection + least-squares upper/lower + slope + consolidation detection (`trend-channel.ts`, ~160 LOC) | quantagent  | **Done**                                                                   |
| Pattern-agent prompt — structured JSON output with 20+ named formations, confidence-clamped, rationale + candle range                          | quantagent  | **Done**                                                                   |
| ROC + Williams %R indicators                                                                                                                   | quantagent  | **Done** (F2 already)                                                      |
| `chart_patterns` table + helpers (`chart-patterns-persist.ts`)                                                                                 | F1 schema   | **Done**                                                                   |
| `chart` scope group — bilingual EN/ES keyword regex + ticker-anchored variant with non-ticker exclusion list                                   | scope.ts    | **Done**                                                                   |
| PNG output via ImageMagick `convert` (reuses v7.14.1 apt binary)                                                                               | v7.14.1     | **Done**                                                                   |
| Playwright + lightweight-charts render path                                                                                                    | pre-explore | **Deferred v7.1.1** (headless Chromium chronically unreliable on this VPS) |
| RRF fusion of `chart_patterns` into post-F7 decision ranking                                                                                   | explore F   | **Deferred v7.1.1** (separate ranking-synthesis sprint)                    |
| Indicator-layering single-LLM-call prompt (RSI + MACD + Stochastic + ROC + Williams %R coherent read)                                          | quantagent  | **Deferred v7.1.1**                                                        |

---

## v7.2 — Knowledge Graph (Graphify MCP) — **Done (MVP)**

> Session 84 (2026-04-20). **Phase γ opens with S1.** Shipped MVP: the integration plumbing + a working code-only corpus. Markdown/CRM/cross-source deferred to v7.2.1 with written triggers. Impl plan: `docs/planning/phase-gamma/01-v7.2-impl-plan.md`.
>
> **Scope-shift at impl-plan step 4**: original plan indexed `docs/` markdown; recon revealed graphify's `collect_files` only handles code extensions (markdown requires the skill-driven LLM semantic pass). Pivoted to `src/` AST-only build: 335 files → 1757 nodes / 4686 edges / 25 communities. Zero LLM cost. God nodes surface semantically-correct singletons (`getDatabase()` top at 257 edges).

| Item                                                                                | Source         | Status                                                          |
| ----------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------- |
| Graphify MCP integration — 7-tool `graphify-code` server (namespaced, deferred)     | graphify       | **Done**                                                        |
| Code corpus AST graph — `src/*.ts` (excl. test files), 1757 nodes / 4686 edges      | graphify       | **Done**                                                        |
| `graph` scope group — bilingual EN/ES regex, negative-lookahead collision avoidance | scope.ts       | **Done**                                                        |
| Bootstrap script + pinned version guard + deployment doc                            | —              | **Done**                                                        |
| Codebase **semantic** graph — LLM-derived cross-references, docstring concepts      | graphify + LLM | **Deferred v7.2.1** (upstream #451 fix or 30-file trial passes) |
| CRM entity graph — prospects, deals, conversations, decision-makers                 | graphify + CRM | **Deferred v7.2.1** (needs md-export pipeline from crm-azteca)  |
| Cross-source queries — unified router across multiple graphify corpora              | native tool    | **Deferred v7.2.1** (after CRM + semantic graphs ship)          |
| Automatic rebuild cron — weekly `--update` pass                                     | cron           | **Deferred v7.2.1** (first stale-graph incident triggers it)    |

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

## v7.3 Phase 2 — SEO Telemetry (PageSpeed Insights + Search Console) — **Done** (2026-04-21)

> 1 session. Depends on v7.6 (uses gws OAuth/Discovery pattern for Search Console).

| Item                                                                              | Source  | Status      |
| --------------------------------------------------------------------------------- | ------- | ----------- |
| PageSpeed Insights adapter — Core Web Vitals, Lighthouse scores, mobile/desktop   | PSI API | **Planned** |
| Google Search Console adapter — clicks, impressions, CTR, position per query/page | GSC API | **Planned** |
| Reuse v7.6 gws pattern if GSC surfaces via Discovery; native adapter if not       | v7.6    | **Planned** |
| `seo_telemetry` tool — query-level performance + alerting on regressions          | —       | **Planned** |

---

## v7.3 Phase 3 — AI Overview Monitoring — **Done** (2026-04-21, MVP)

> 1 session. Depends on F1 schedule infrastructure. The GEO differentiator toprank lacks.

| Item                                                                                       | Source | Status      |
| ------------------------------------------------------------------------------------------ | ------ | ----------- |
| Scheduled job — runs tracked queries via SERP API, detects AI overview presence            | —      | **Planned** |
| AI overview attribution tracking — which sources cited, rank position, over-time evolution | —      | **Planned** |
| `ai_overview_tracking` table — time-series of query → presence + sources                   | —      | **Planned** |
| Alert on attribution loss or competitor displacement                                       | —      | **Planned** |

---

## v7.3 Phase 5 — GEO Depth (Princeton + llms.txt + AI-bots) — **Done** (2026-04-21)

> 1 session. Depends on nothing. Source: `reference_geo_optimizer.md` (Auriti-Labs MIT). Fills content-quality diagnostic gap in Phase 1 audit + 2 new tools for emerging GEO standards.

| Item                                                                                                                                                                                                                                                     | Source          | Status      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------- |
| `seo_llms_txt_generate` — sitemap → `/llms.txt` AI-readable site summary (emerging standard)                                                                                                                                                             | Auriti          | **Planned** |
| Extend `seo_page_audit` with Princeton KDD 2024 content-quality signals (cite density +30-115%, stat density +40%, quote presence +30-40%, readability +15-30%, keyword-stuffing detection); impact-weighted scoring alongside existing structural score | Princeton paper | **Planned** |
| `seo_robots_audit` — AI-bot robots.txt coverage report; training-vs-citation distinction; misconfiguration flagging                                                                                                                                      | Auriti          | **Planned** |
| `ai-bots.ts` reference library (27 entries: OpenAI, Anthropic, Perplexity, Google, Microsoft, Apple, Meta, + others)                                                                                                                                     | Auriti          | **Planned** |

~600 LOC TS total. No new deps. No license blockers (MIT). Ships independently of Phase 2/3/4.

---

## v7.3 Phase 4 — Digital Marketing Buyer (claude-ads + Meta/Google Ads) — **Phase 4a Done** (2026-04-21)

> 3 sessions originally scoped — split into 3 credential-boundary-aware sub-sprints. Reference: `reference_claude_ads.md`.

### v7.3 Phase 4a — Audit + Brand DNA + Creative Generation (done, 1 session)

| Item                                                                                                                                                                                                                                                                                                                                                           | Source     | Status   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------- |
| `ads_audit` — weighted 7-platform check framework (v1 ~50 checks, severity 5.0×→0.5×, categories: targeting/budget/creative/technical/tracking); A-F grade with not-applicable-aware denominator; supersede-map drops exact-field-duplicate cross-platform checks on platforms with specific variants; WordStream/LinkedIn industry benchmarks cross-reference | claude-ads | **Done** |
| `ads_brand_dna` — URL (stealth-fetch) or pasted-text → LLM-extracted brand brief (voice axes formality/boldness/playfulness, colors, typography, value props, audience, lexicon); scalar + list sanitization at storage boundary (prompt-injection laundering defense)                                                                                         | claude-ads | **Done** |
| `ads_creative_gen` — brief_id or inline brief + framework (AIDA/PAS/BAB/FAB/4P/Star-Story-Solution) + platform + objective → N creative variants; single-pass template substitution (immune to placeholder laundering)                                                                                                                                         | claude-ads | **Done** |
| 6 copywriting framework prompt templates + 47-row industry×platform benchmark table + `ads_audits`/`ads_brand_profiles`/`ads_creatives` tables + `ads` scope group (bilingual EN+ES)                                                                                                                                                                           | claude-ads | **Done** |

### v7.3 Phase 4b — Meta + Google Ads API clients — **Credential-gated**

> 1 session. Depends on operator provisioning: Facebook Business app (id/secret/system-user token) + Google OAuth2 client + Google Ads developer token. Shipping API clients before creds are in place produces dead code.

| Item                                                                                  | Source     | Status      |
| ------------------------------------------------------------------------------------- | ---------- | ----------- |
| Meta Ads API client — campaign CRUD, audience targeting, creative upload (Graph v21+) | Meta Graph | **Planned** |
| Google Ads API client — campaign CRUD, keywords, bid strategies                       | Google Ads | **Planned** |

### v7.3 Phase 4c — Bid Automation + CRM Attribution — **Planned** (depends on P4b)

| Item                                                                            | Source | Status      |
| ------------------------------------------------------------------------------- | ------ | ----------- |
| Bid management — budget allocation, dayparting, auto-pause                      | —      | **Planned** |
| CRM attribution — ad click → lead → opportunity → close linkage via agentic-crm | CRM    | **Planned** |
| Daily performance ritual — scheduled scan + weekly optimization report          | —      | **Planned** |

---

## v7.4 — Video Production

> 2 sessions. Depends on v7.3 Phase 4 (feeds marketing content). References: `reference_open_higgsfield.md`, `reference_openmontage.md`, `reference_hyperframes.md`, `reference_redditvideomakerbbot.md`.

### v7.4 S1 — Composition Engine (augments existing S5d ffmpeg pipeline) — **Done (session 97, 2026-04-21)**

> Shipped as augmentation of the existing `src/video/*` S5d module rather than a port of openmontage/hyperframes. S5d already shipped the `video_create/script/tts/image/compose` tool set under the `video` scope group (Phase β). S1 adds the hyperframes Tier-1 patterns that survive without a Chromium compositor: frame quantization, xfade-mapped transitions, manifest protocol, worker-pool (unwired — see S1.1). Impl plan: `docs/planning/phase-gamma/09-v7.4-impl-plan.md`.

| Item                                                                                                                                                                            | Source                 | Status                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| S5d composer baseline (video_create / video_status / video_script / video_tts / video_image / video_list_profiles / video_list_voices / video_background_download)              | Phase β S5d            | **Done** (pre-v7.4)                                                                                 |
| **Seek-by-frame protocol** (`VideoCompositionManifest` + `validateManifest`, engine-agnostic)                                                                                   | hyperframes #1         | **Done**                                                                                            |
| **Deterministic frame quantization** (`src/video/frame-clock.ts`, wired into `composer.ts` at `-t` + `between(t,…)` sites)                                                      | hyperframes #2         | **Done**                                                                                            |
| **Parallel worker coordinator** (`src/video/worker-pool.ts` — written, tested, CAP 4)                                                                                           | hyperframes #3         | **Partial** — module shipped, NOT wired into composer. See v7.4 S1.1.                               |
| Skill gate pattern (SKILL.md + house-style.md + visual-styles.md)                                                                                                               | hyperframes #5         | **Deferred to S2a** — better expressed as cinema-prompts catalog (see v7.3 P4a pattern)             |
| **14 transition library** — 8 native ffmpeg xfade (fade / wipeleft / wiperight / circleopen / circlecrop / pixelize / dissolve / radial)                                        | hyperframes #7 partial | **Done**                                                                                            |
| 6 GL-only shader transitions (domain-warp / ridged-burn / gravitational-lens / chromatic-radial-split / sdf-iris / rgb-displacement) → fall back to dissolve                    | hyperframes #7         | **Deferred to v7.4.4** — trigger: operator requests a specific one                                  |
| 4 new tools — `video_transition_preview`, `video_compose_manifest`, `video_job_cancel`, `video_job_cleanup`                                                                     | —                      | **Done**                                                                                            |
| DB additive migration — `manifest_json` / `frame_hash` / `cost_cents` / `ffmpeg_pid` on `video_jobs`                                                                            | —                      | **Done**                                                                                            |
| Scope regex tightening — bilingual EN+ES, negative lookaheads on `video`/`render`/`mp4`/`overlay`/`screenshot`/platforms, + Round-2 W2 singular-`reel` + `reels de/para X` arms | —                      | **Done**                                                                                            |
| `ffmpeg_pid` pid-kill wiring in `video_job_cancel` (composer needs `execFileSync`→`spawn` refactor)                                                                             | —                      | **Deferred to v7.4 S1.1** — trigger: operator reports "cancelled" job kept running to 2-min timeout |
| `runManifestPipeline` unit tests (currently covered only by live smoke)                                                                                                         | —                      | **Deferred** — trigger: ffmpeg live-fixture harness, OR regression observed                         |
| Stretch: pre-extract video frames pipeline (ffprobe + CDP injection, ~400 LOC)                                                                                                  | hyperframes #4         | **Deferred to v7.4.3** — Chromium compositor reliability                                            |
| Stretch: 40-block registry (Reddit-post, IG-follow, YT-lower-third, data-chart)                                                                                                 | hyperframes #8         | **Deferred to v7.4.3** — HTML/CSS blocks                                                            |
| Stretch: Docker determinism mode (pinned Chrome + fonts)                                                                                                                        | hyperframes #9         | **Deferred** — trigger: two renders of same input diverge in hash                                   |
| Stretch: audio-reactive sampling pattern (pre-extracted frequency bands)                                                                                                        | hyperframes #10        | **Doc-only** in v7.4 S2a cinema-prompts (visual-styles)                                             |

### v7.4 S2a — Storyboard Pipeline + Brand-DNA Bridge (code-only) — **Done (session 97, 2026-04-22)**

| Item                                                                                                                            | Source | Status                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| Storyboard pipeline — brief → LLM → `VideoCompositionManifest` (scene list + narration + image queries + transitions)           | —      | **Done** (`src/video/storyboard.ts`)     |
| Cinema prompts library — 20 camera modifiers + 15 lighting styles + 10 mood archetypes (static catalog, shape = P4a ads-refs)   | —      | **Done** (`src/video/cinema-prompts.ts`) |
| Brand-DNA bridge — load v7.3 P4a `ads_brand_profiles` row by id, merge voice + lexicon into storyboard prompt                   | —      | **Done**                                 |
| 2 new tools — `video_storyboard`, `video_brand_apply`                                                                           | —      | **Done**                                 |
| URL / active-content sanitization on brief (prompt injection defense: http/https/ftp/file/data:/javascript:/mailto:)            | —      | **Done**                                 |
| LLM output hardening — JSON block extraction (raw/fenced/embedded), defensive scene re-indexing, `validateManifest` enforcement | —      | **Done**                                 |

### v7.4 S2b — AI Generation + Lip-Sync (credential-gated) — **Planned**

| Item                                                                        | Source          | Status      | Trigger                                  |
| --------------------------------------------------------------------------- | --------------- | ----------- | ---------------------------------------- |
| AI asset generation pipeline (higgsfield/Muapi — Kling clips + Flux stills) | open-higgsfield | **Planned** | operator provisions API key              |
| fal.ai FLUX adapter — upgrade images from pexels stock to AI-generated      | open-higgsfield | **Planned** | operator provisions `FAL_API_KEY`        |
| ElevenLabs premium TTS adapter — upgrade from edge-tts                      | open-higgsfield | **Planned** | operator provisions `ELEVENLABS_API_KEY` |
| Lip sync for talking-head generation                                        | open-higgsfield | **Planned** | operator provisions wav2lip or Muapi key |

---

## v7.4.3 — HTML-as-Composition DSL (hyperframes item #6) — **Planned**

> 1 session, ~8-12h. Follow-up to v7.4 S1+S2. LLM-native composition format: single `index.html` file with `data-start` / `data-duration` / `data-track-index` / `data-layer` attributes, GSAP timeline, CSS styling. Agents already speak HTML — makes composition an end-to-end LLM-writable artifact.

> Warrants its own session because it's a different composition paradigm than Remotion JSX (the v7.4 S1 default). Competing paradigms shouldn't both live in v7.4 simultaneously.

| Item                                                                                  | Source         | Status      |
| ------------------------------------------------------------------------------------- | -------------- | ----------- |
| Port `packages/core/src/parsers/htmlParser.ts` — data-attribute → timeline extraction | hyperframes #6 | **Planned** |
| `video_html_compose` tool — accepts HTML composition file, produces MP4               | —              | **Planned** |
| BeginFrame CDP capture path (faster + more deterministic than page.screenshot)        | hyperframes    | **Planned** |
| Pre-extract + inject video pipeline for `<video>` elements in composition             | hyperframes #4 | **Planned** |
| Integration with skill gate (Visual Identity Gate applied to HTML path too)           | —              | **Planned** |
| Scope decision: HTML DSL coexists with Remotion JSX or replaces it?                   | Design Q       | **Open**    |

---

## v7.5 — Skill Evolution Engine (GEPA + SkillClaw) — **Planned**

> 2 sessions. Depends on F9 (needs production trace data). References: `reference_gepa.md`, `reference_skillclaw.md`, `feedback_phantom_evolution_engine.md`.
>
> **MANDATORY PRE-PLAN TASK (NO SKIP):** Before any v7.5 implementation starts, run the full upstream sweep per `memory/feedback_v75_upstream_sweep_directive.md`. Budget: ~4 hours as its own half-day session. Scope: 48+ `reference_*.md` files with 10 core skill-evolution references read in depth (GEPA, SkillClaw, Hyperagents, Hermes, ACE, Memoria, claude-mem, mempalace, Superpowers, context-engineering). The sweep findings shape v7.5 scope — without it the skill-evolution engine is built against stale reference material from months earlier. Launch with parallel `Agent subagent_type=Explore` calls for the 10 core repos. Do NOT start coding v7.5 until every reference file has a "last reviewed" date within the current week AND Tier 1 findings are folded into the scope table below.

| Item                                                                                                                                                                                                                               | Source                                     | Status      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| **Pre-plan: bulk upstream sweep (48 refs, ~4h)**                                                                                                                                                                                   | `feedback_v75_upstream_sweep_directive.md` | **Blocker** |
| Reflective mutation from execution traces — extract corrections, propose minimal config deltas                                                                                                                                     | GEPA + Phantom evolution                   | **Planned** |
| ASI (Ablation Signal Intensity) diagnostics — which parts of the prompt are load-bearing                                                                                                                                           | GEPA                                       | **Planned** |
| Pareto domain specialization — separate skill variants per task class                                                                                                                                                              | GEPA                                       | **Planned** |
| Failure source classification (skill / agent / env) — SkillClaw pattern                                                                                                                                                            | SkillClaw                                  | **Planned** |
| Session trajectory structuring — logged corrections promoted to golden suite                                                                                                                                                       | SkillClaw + Phantom                        | **Planned** |
| Conservative editing principles — append-first, minimal replace, no remove of safety keywords                                                                                                                                      | Phantom constitution                       | **Planned** |
| Monotonic validation — 5-gate taxonomy (constitution/regression/size/drift/safety) with fail-closed safety                                                                                                                         | Phantom evolution                          | **Planned** |
| Triple-judge minority veto for safety-critical gates                                                                                                                                                                               | Phantom judges                             | **Planned** |
| Daily cost cap + heuristic fallback when budget exhausted                                                                                                                                                                          | Phantom engine                             | **Planned** |
| Upgrade overnight tuning loop to use the evolution engine                                                                                                                                                                          | V7 spec                                    | **Planned** |
| Two-layer memory separation — tag `kb_entries` with `layer` (`prior_knowledge` / `task_experience`); different retrieval per layer (cognition query uses sampled task node analyses, not raw user prompt)                          | ASI-Evolve (arxiv 2603.29640)              | **Planned** |
| Dedicated Analyzer module — separate from mutator. Engineer emits rich output → Analyzer distills into structured `{decision, reasoning, actionable_insights[]}` → Researcher next round consumes distilled report, not raw traces | ASI-Evolve                                 | **Planned** |
| MAP-Elites island sampling — quality-diversity alternative to UCB1/Thompson. Behavioral cells (tool-call pattern × response structure) preserve distinct variants; prevents mode collapse                                          | ASI-Evolve                                 | **Planned** |

---

## v7.13 — Structured PDF Ingestion (`kb_ingest_pdf_structured`) — **Done (Option B)**

> Session 76 (2026-04-17), shipped as Option B: minimum-viable pre-F7 using the existing `@opendataloader/pdf` core dep, **no MinerU**. Full MinerU Python service deferred to v7.13-polish. Impl plan: `docs/planning/phase-beta/18-v7.13-impl-plan.md`. Branch: `phase-beta/v7.13-pdf-structured-ingestion`.

**Why Option B**: MinerU is a 1.5-session Docker + systemd + ML-models infrastructure project. F7's 11-step alpha combination doesn't hard-depend on ML-quality extraction (numeric signal series from F3/F5/F6/F6.5 are sufficient). Zero-new-deps invariant held across S1-S5. If F7/F8 retrieval telemetry shows quality ceiling, MinerU ships as v7.13-polish with evidence.

| Item                                                                                                                               | Source                | Status                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `KbEntry` interface + pgvector schema extended: `modality`, `parent_doc_id`, `section_path`, `chunk_position` (additive migration) | impl                  | **Done**                                                                 |
| `src/kb/pdf-structured-ingest.ts` — markdown sectionizer + pipe-table detector + CJK-aware chunker w/ hard-slice fallback          | impl                  | **Done**                                                                 |
| `kb_ingest_pdf_structured(pdf_path, namespace?, parent_doc_id?, tags?, max_chunks?)` tool — UUID validation + migration hint       | impl + audit C2/W3/S1 | **Done**                                                                 |
| `kb_batch_insert(entries)` cheap-win tool — bypass chunker, accept pre-parsed content                                              | impl                  | **Done**                                                                 |
| Hierarchical `belongs_to` metadata — parent_doc_id, section_path, chunk_position                                                   | impl                  | **Done**                                                                 |
| Tables preserved as single chunks with pipe-format intact (modality='table')                                                       | impl                  | **Done**                                                                 |
| New `kb_ingest` scope group w/ activation pattern (verb + file signal) — audit C2 negative-case tested                             | audit C2              | **Done**                                                                 |
| WRITE_TOOLS + write-tools-sync test expanded                                                                                       | impl                  | **Done**                                                                 |
| 44 new tests (25 ingester + 14 tool + 4 scope + 1 sync)                                                                            | —                     | **Done**                                                                 |
| MinerU Python service (Docker + systemd + ML models) — equation LaTeX + image-caption modalities                                   | HKUDS RAG-Anything    | **Deferred** (v7.13-polish; trigger = F7/F8 retrieval quality telemetry) |
| Retrieval layer modality filter (pgHybridSearch modality bias)                                                                     | F7 concern            | **Deferred** (F7 pre-plan item)                                          |
| Vision adapter image-caption generation                                                                                            | v7.13-polish          | **Deferred**                                                             |
| OCR fallback for scanned PDFs                                                                                                      | v7.13-polish          | **Deferred**                                                             |
| Multi-doc cross-linking via `related_to[]`                                                                                         | F7+F9 concern         | **Deferred**                                                             |

**Explicit non-goals**: full RAG-Anything framework adoption, multi-modal knowledge graph, VLM-enhanced retrieval, modality-specific processor plugin architecture. See `reference_rag_anything.md` for skip rationale.

---

## v7.14 — Infographic Generation (`infographic_generate` tool) — **Done**

> Session 87 (2026-04-20). Phase γ S4. Impl plan: `docs/planning/phase-gamma/04-v7.14-impl-plan.md`.

**Unusually clean integration — no scope pivot.** `@antv/infographic@0.2.17` installed cleanly (MIT, TypeScript, 13 pure-JS transitive deps, zero puppeteer/g2/g6/chromium). Pure-Node SSR via `renderToString` using a `linkedom` DOM shim — no browser required. Four consecutive γ sprints (v7.2, v7.10, v7.12) all had step-1-or-2 recon pivots; this one didn't, which made it the fastest γ sprint so far.

| Item                                                                                                                              | Source                     | Status               |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------- |
| Install `@antv/infographic@0.2.17`; verify footprint (64MB node_modules, no heavy viz stack pulled in)                            | antvis/Infographic         | **Done**             |
| `infographic_generate(description, template?, theme?, data?, output_path?, emit?, width?, height?)` tool handler                  | —                          | **Done**             |
| 3-mode dispatch: `data` → direct render; raw DSL → direct render; NL → LLM → DSL → render                                         | —                          | **Done**             |
| 15-template curated recommendation set documented in tool description; full 276 validated at runtime via `getTemplates()`         | AntV templates             | **Done**             |
| Default `theme: "dark"` matching Jarvis aesthetic (`feedback_vlmp_ui_choice.md`); caller can override                             | —                          | **Done**             |
| Scope wiring — folded into existing `specialty` group; regex extended with EN + ES infographic vocabulary                         | `scope.ts`                 | **Done**             |
| Security: output-path whitelist, 30s outer timeout guard, `Number.isFinite` width/height validation                               | Security                   | **Done**             |
| Integration: `WRITE_TOOLS` (hallucination guard), write-tools-sync test with `SPECIALTY_READ_ONLY` set, CLAUDE.md dep count 13→14 | `INTEGRATION-CHECKLIST.md` | **Done**             |
| 27 tests (dispatch 6 + validation 7 + path 4 + error 2 + write 3 + dimensions 2 + ES-form regression 2 + negative over-match 1)   | —                          | **Done**             |
| PNG conversion via Puppeteer/Playwright                                                                                           | v7.1 infra                 | **Deferred v7.14.1** |
| Streaming / progressive render integration with SSE dashboard                                                                     | AntV                       | **Deferred v7.14.1** |
| Retry-with-error-feedback loop for invalid LLM-generated DSL                                                                      | —                          | **Deferred v7.14.1** |
| Image-quality validation on WhatsApp/Telegram delivery paths (SVG text re-encoding)                                               | —                          | **Deferred v7.14.1** |

**Explicit non-goals**: building infographic templates from scratch, full G2/G6 analytical chart coverage (handled by v7.1 lightweight-charts), replacing diagram_generate (v7.12 remains canonical for mermaid/d2/plantuml/graphviz).

---

## v7.10 — Universal File Conversion (`file_convert` tool) — **Done**

> Session 85 (2026-04-20). Phase γ S2. Impl plan: `docs/planning/phase-gamma/02-v7.10-impl-plan.md`. Source: `reference_convertx.md` (ConvertX AGPL blocked; rebuilt native via apt binaries — clean).

Jarvis can now read `.epub/.mobi/.odt/.rtf/.pages/HEIC/AVIF` and extract video frames. One deferred tool, dispatches to FLOSS CLI binaries via `execFile` (no shell). 2 QA audit passes closed 2 critical (symlink bypass, `Infinity` timestamp) + 2 major (UTILITY_TOOLS sync gap, ES regex asymmetry) + 3 warnings. Live smoke: pandoc .md→.html, imagemagick .png→.jpeg, libreoffice .docx→.pdf, symlink rejection all verified.

| Item                                                                                         | Source                     | Status   |
| -------------------------------------------------------------------------------------------- | -------------------------- | -------- |
| VPS prerequisites: `apt install calibre libreoffice pandoc imagemagick libvips-tools ffmpeg` | —                          | **Done** |
| `file_convert(input_path, target_format, output_path?, timestamp_sec?)` tool handler         | `reference_convertx.md`    | **Done** |
| Format dispatch table (extension → binary, not LLM-inferred)                                 | —                          | **Done** |
| Source-extension whitelist + path validation (absolute, canonical, symlink-rejecting)        | Security                   | **Done** |
| realpath re-validation (defeats intermediate-symlink sandbox escape)                         | Security                   | **Done** |
| LibreOffice `--outdir` rename-to-requested-name unification                                  | UX                         | **Done** |
| Integration: scope group, guards (NOT read-only), WRITE_TOOLS guard, sync test               | `INTEGRATION-CHECKLIST.md` | **Done** |
| Test file: dispatch + validation + security + error + regression (28 tests)                  | —                          | **Done** |
| **Explicit non-goal**: audio transcription — separate project (whisper.cpp or Deepgram)      | —                          | —        |

---

## v7.11 — Jarvis Teaching Module ("teach me anything") — **Done**

> 1.5-2 sessions. No F-step dependencies — slottable in Phase γ. Primary reference: `reference_deeptutor.md`. User intent: "I want Jarvis to teach me anything."
>
> **Scope honesty**: DeepTutor provides ~30% of this (decomposition/scoped-chat/summary prompts + state machine, ~400 LOC portable). The load-bearing 70% is Jarvis-native work: learner model, spaced repetition, misconception detection, Socratic loop, prerequisite graph. Do NOT plan this as "port DeepTutor" — plan it as a capability build with DeepTutor as one foundation.

### Ported from DeepTutor (~30%, ~400 LOC)

| Item                                                                                                       | Source                           | Status      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------- |
| Knowledge-point decomposition prompt — topic → 2-5 ordered atomic units with predicted difficulties        | `design_agent.yaml`              | **Planned** |
| Scoped chat-agent contract — answers constrained to current unit, carries predicted difficulties as priors | `chat_agent.yaml`                | **Planned** |
| Retrospective summary prompt — forces LLM to cite specific user questions as mastery evidence              | `summary_agent.yaml`             | **Planned** |
| Quiz pipeline (idea→generate→followup) with dedup-vs-history                                               | `agents/question/coordinator.py` | **Planned** |
| `GuidedSession` state machine — create_session / start_learning / chat / complete_learning flow            | `guide_manager.py`               | **Planned** |

### Jarvis-native (~70%, load-bearing capabilities)

| Item                                                                                                           | Notes                                                                                           | Status      |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| **Learner model table** — `concept → {last_seen, confidence, evidence_quotes, mastery_score, review_due_date}` | Core state. Updated by summary pass + spaced repetition scheduler                               | **Planned** |
| **Spaced repetition ritual** — Leitner or SM-2 scheduling, Jarvis cron-side                                    | Morning ritual reads learner_model where `review_due_date <= today`, picks today's review units | **Planned** |
| **Misconception detection loop** — during chat, detect user statements that contradict canonical concept       | Not prompt-only — requires comparison logic against concept definitions                         | **Planned** |
| **Explain-back / Socratic loop** — periodically ask user to explain concept in own words, grade explanation    | Grading feeds mastery_score + evidence_quotes on learner_model                                  | **Planned** |
| **Prerequisite graph** — LLM-generated on plan creation, persisted as directed graph                           | Blocks advancing to unit N until prereqs mastered                                               | **Planned** |
| **Adaptive difficulty** — quiz difficulty adjusts based on learner_model mastery scores                        | Not static input                                                                                | **Planned** |

### New tools (scope group `teaching`)

| Tool                                      | Purpose                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `learning_plan_create(topic)`             | Decomposes + persists ordered knowledge_points                  |
| `learning_plan_advance(plan_id)`          | Moves to next unit if prerequisites met                         |
| `learning_plan_quiz(plan_id, unit_index)` | Generates adaptive-difficulty quiz                              |
| `learning_plan_explain_back(plan_id)`     | Socratic loop — ask user to explain, grade response             |
| `learning_plan_summarize(plan_id)`        | Updates learner_model + writes session summary with evidence    |
| `learner_model_status`                    | Report: what concepts mastered, what due for review, what shaky |

### New DB tables

- `learning_plans(plan_id, topic, created_at, status, notes)`
- `learning_plan_units(plan_id, unit_index, title, summary, predicted_difficulties, prerequisites, status, mastery_score)`
- `learner_model(concept, last_seen, confidence, evidence_quotes, mastery_score, review_due_date)`
- `learning_sessions(session_id, plan_id, unit_index, started_at, ended_at, mastery_delta)`

### Scope activation

Scope group `teaching` activates on: "enséñame", "teach me", "explícame X desde cero", "quiero aprender", "review today", "quiz me on X"

### Ritual integration

- **Morning ritual**: reads `learner_model` where `review_due_date <= today`, proposes today's review
- **EOD ritual**: writes mastery deltas from the day's teaching sessions back to `learner_model`

### Out of scope (explicit non-goals)

- Interactive HTML unit rendering (chat-first, no frontend)
- Video lectures or generated explainer videos (that's v7.4 territory)
- Multi-user shared progress (single-user system)
- Real-time collaboration with Fede's CRM team (different project)

---

## v7.12 — Diagram Generation (`diagram_generate` tool) — **Done (MVP)**

> Session 86 (2026-04-20). Phase γ S3. Impl plan: `docs/planning/phase-gamma/03-v7.12-impl-plan.md`.

**Scope pivot (during impl-plan step 2)**: mermaid-cli (`mmdc`) v11 AND v10.9.1 both hang with `ProtocolError: DOM.resolveNode timed out` on this VPS's puppeteer/Chromium combo (4+ minute wall-clock, 0 svg produced on both). Mermaid deferred to v7.12.1. MVP ships with graphviz + svg_html only. Scope-pivot was recorded in impl-plan §1; third consecutive sprint (F8.1b, v7.2, v7.12) with a step-1-or-2 recon pivot — the pattern is now expected, not exceptional.

| Item                                                                                                         | Source                     | Status               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------- | -------------------- |
| VPS prerequisite: `apt install graphviz`                                                                     | —                          | **Done**             |
| `diagram_generate(description, format, diagram_type?, theme?, output_path?, emit?)` tool handler             | Cocoon reference           | **Done**             |
| Format dispatch: graphviz → `dot -Tsvg`, svg_html → inline LLM with Cocoon palette                           | —                          | **Done**             |
| Raw-DSL short-circuit (DOT + HTML detected, skips LLM — saves ~6s per call for hand-written DSL)             | —                          | **Done**             |
| Cocoon palette + layout rules ported to `diagram-svg-prompt.ts` (dark + light themes)                        | Cocoon reference           | **Done**             |
| Security: `execFile` (no shell), output-path whitelist, temp-file cleanup, description size cap (8000 chars) | Security                   | **Done**             |
| Integration: new `DIAGRAM_TOOLS` scope group + regex, WRITE_TOOLS guard, write-tools-sync test               | `INTEGRATION-CHECKLIST.md` | **Done**             |
| 26 tests (dispatch, validation, errors, security, boundary, cleanup)                                         | —                          | **Done**             |
| Mermaid format via Node API (`@mermaid-js/mermaid` + jsdom/happy-dom) instead of mmdc CLI                    | —                          | **Deferred v7.12.1** |
| D2 format (out-of-band installer; low demand until first ask)                                                | —                          | **Deferred v7.12.1** |
| PlantUML format (JRE + ~200MB deps; graphviz covers the UML-ish topology cases)                              | —                          | **Deferred v7.12.1** |

**Supported diagram types**: architecture, flowchart, sequence, ER, class, state
**Output formats**: svg (graphviz), html (svg_html), plus `emit: source` to return DSL text without rendering.

---

# Phase δ — Live Trading (gated on 30d F8 paper-trading record)

> **Not** part of Phase β. Ships only after F9 delivers and F8 produces 30+ days of positive risk-adjusted paper-trading telemetry. Real money at risk — wallet security architecture alone warrants dedicated session time.

## v7.0 F11 — Live Polymarket Trading Engine — **Gated** (Phase δ)

> 2.5 sessions. Depends on F6 (read-side adapter), F8 (paper-trading track record — 30+ days), and the full prediction-suite learning stack listed below. Goal: Jarvis can autonomously place, manage, and exit positions on Polymarket with reward-farming + directional-betting strategies. Source: `reference_polymarket_cli.md` (Stage C).
>
> **Readiness gate (hard prerequisite)**: Stage B paper-trading must show 30+ days of positive risk-adjusted return (Sharpe > 0, max drawdown within configured cap) before any real-money deployment. Same discipline as F8 stock paper-trading graduation.

### Apply-all-learnings fold matrix

Every prediction-suite learning applies — cross-referenced to the source memory:

| Learning source                                        | What it contributes to F11                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference_polymarket_cli.md` (this ref)               | Full write-side API surface — CLOB orders, on-chain CTF ops, bridge, wallet, rewards API                                                                                                                                                                                                                      |
| `reference_polymarket_paper_trader.md`                 | 5 patterns already ported for Stage B — orderbook walking, positions, P&L analytics, caching, multi-account A/B                                                                                                                                                                                               |
| `reference_wolff_echterling_stock_picking.md`          | **Natural fit** — Polymarket markets ARE binary (YES/NO with probability 0-1). Classification-target framing maps directly: "true probability vs market price." Regularized logistic regression as baseline before complex ML.                                                                                |
| `reference_lopez_de_prado_methodology.md`              | Meta-labeling as Kelly-sizing bridge — primary model predicts edge magnitude, secondary predicts bet/pass given fees + slippage. Purged CV for backtesting. PBO as strategy-quality gate. Triple-barrier labels adapt to Polymarket: upper = edge realized, lower = adverse move, vertical = market resolves. |
| `reference_finrl_x.md`                                 | Weight-centric architecture `w = ℛ(𝒯(𝒜(𝒮(X))))` applies — 𝒮 = market selection, 𝒜 = position sizing, 𝒯 = timing (entry/exit), ℛ = portfolio-level risk overlay (concentration caps, max exposure)                                                                                                             |
| `reference_asi_evolve.md`                              | **MAP-Elites island sampling** structures strategy variants as behavioral cells: directional-bet / market-making / arbitrage-across-related-markets. Prevents mode collapse into one strategy.                                                                                                                |
| `reference_trading_agents.md`                          | BM25 reflection memory + adversarial critic — useful for event-driven markets where news interpretation matters (election polls, sports, geopolitical)                                                                                                                                                        |
| `reference_quantagent.md` (v7.1 fold)                  | Event-chart pattern recognition — Polymarket markets often have their own price charts; vision-LLM pattern detection applies (breakout, channel, consolidation on market probability)                                                                                                                         |
| F6 read-side                                           | Builder-leaderboard for strategy validation — compare Jarvis's builder-level performance against known high performers                                                                                                                                                                                        |
| `feedback_audit_patterns.md`, security audit checklist | 10-item security pass for any new HTTP-exposed service. Critical here — wallet auth + order placement is attack-surface-heavy.                                                                                                                                                                                |

### Scope table

| Item                                                                                                                                                                                                                                                                                                                                                                                      | Source                                               | Status      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------- |
| **Regulatory precheck** — geoblock call on every session start; user-location-aware gating; documented KYC posture. Jurisdiction where trade execution happens is a legal precondition, not a code question.                                                                                                                                                                              | polymarket-cli + legal                               | **Planned** |
| **Wallet security architecture** — NEVER plain-config private key. Options in preference order: HashiCorp Vault self-hosted, hardware wallet (Ledger) via WebHID, env-var-from-secrets-manager. Dedicated session time budgeted.                                                                                                                                                          | polymarket-cli + security audit                      | **Planned** |
| **CLOB write-path TS adapter** — `VenueAdapter`-compliant from start (see F8 interface). `createOrder`, `marketOrder`, `postOrders` (batch), all cancel variants, order-type enum (GTC/FOK/GTD/FAK + post-only). Structured error objects (code + message + retryable). Pin to polymarket-cli commit.                                                                                     | polymarket-cli CLOB + `reference_nautilus_trader.md` | **Planned** |
| **Advanced order types** — OCO (One-Cancels-Other) for atomic bid+ask market-making pairs; OTO (One-Triggers-Other) for bracket orders (entry → auto-stop-loss); OUO (One-Updates-Other) for dynamic hedging; iceberg for size concealment. Gated by Polymarket API support — verify which types CLOB actually accepts; implement client-side emulation for unsupported types where safe. | `reference_nautilus_trader.md`                       | **Planned** |
| **Shared execution engine compliance** — F11 uses the F8-defined shared Order state machine, fill simulator, event bus, and clock abstraction. NO F11-specific execution paths. Research-to-live parity test (from F8) is the ship-gate before any live-money activation.                                                                                                                 | `reference_nautilus_trader.md`                       | **Planned** |
| **On-chain operations** — ERC-20 (USDC) + ERC-1155 (CTF) approvals, CTF split/merge/redeem, neg-risk redemption. OpenZeppelin ABIs. ethers.js Wallet abstraction.                                                                                                                                                                                                                         | polymarket-cli CTF + approve                         | **Planned** |
| **Bridge integration** — USDC → Polygon deposit orchestration; supported-assets check; status polling                                                                                                                                                                                                                                                                                     | polymarket-cli bridge                                | **Planned** |
| **Position + portfolio management** — risk limits (max per-market, max total exposure, concentration caps), multi-market tracking, resolution P&L realization with `redeem` on winning outcomes                                                                                                                                                                                           | Stage B patterns + V7 spec                           | **Planned** |
| **Strategy selection via MAP-Elites cells** — behavioral cells: directional-bet / market-making / arbitrage. Cell-based candidate maintenance rather than single best-strategy.                                                                                                                                                                                                           | `reference_asi_evolve.md`                            | **Planned** |
| **Directional-betting strategy** — Wolff-Echterling classification target + de Prado meta-labeling wrapper. Edge detection: `(model_probability - market_price)` vs `fees + expected_slippage`. Kelly sizing via secondary classifier probability.                                                                                                                                        | de Prado + Wolff-Echterling                          | **Planned** |
| **Market-making strategy** — limit-order placement on liquid markets for fee rebates. Track `current-rewards` + `order-scoring` APIs. Bid-ask risk modeling (get-picked-off when news breaks). Not free money — compensation for real liquidity risk.                                                                                                                                     | polymarket-cli rewards                               | **Planned** |
| **Arbitrage-across-related-markets** — Gamma events API groups related markets (e.g., multi-outcome election); arbitrage when sum of YES probabilities ≠ 1. Rare but clean edge.                                                                                                                                                                                                          | polymarket-cli Gamma + neg-risk                      | **Planned** |
| **Backtest framework** — purged k-fold CV + PBO (from `reference_lopez_de_prado_methodology.md`) on Polymarket historical data. Probability of Backtest Overfitting as ship-gate (>50% blocks deployment).                                                                                                                                                                                | de Prado                                             | **Planned** |
| **Builder-leaderboard comparison** — track Jarvis's builder-level performance, compare against known-good builders                                                                                                                                                                                                                                                                        | F6 Stage A                                           | **Planned** |
| **Reward-tracking instrumentation** — persist `rewards`/`earnings`/`order-scoring` data; include in daily P&L attribution (trading gains vs reward income)                                                                                                                                                                                                                                | polymarket-cli rewards                               | **Planned** |
| **Kill switch + circuit breakers** — daily loss cap, per-market loss cap, max-orders-per-hour. Automatic pause + notify on breach. Manual override required to resume.                                                                                                                                                                                                                    | Risk management                                      | **Planned** |
| **Security audit (10-item pass)** — full checklist from `feedback_security_audit.md` before any live order placement                                                                                                                                                                                                                                                                      | `feedback_security_audit.md`                         | **Planned** |
| **Integration touchpoints** — scope group (new `polymarket_trading` scope, destructive/confirmation-gated), tool definitions, write-tools-sync test, auto-persist rules for trade events, INTEGRATION-CHECKLIST.md full touchpoints                                                                                                                                                       | `INTEGRATION-CHECKLIST.md`                           | **Planned** |

### Explicit non-goals

- **Polymarket analytics dashboard** — out of scope, build only if needed for Jarvis's own operation
- **Polymarket alongside other prediction venues simultaneously in F11** — Kalshi etc. are separate integrations; F11 is Polymarket-specific depth
- **HFT / sub-second latency** — Polymarket resolution cadence doesn't need it; we're not co-located
- **Social trading / copy-trading from whales** — separate signal (F6 whale tracker already covers this for read-side); F11 is Jarvis's own strategies

### Concerns carried forward from reference

1. polymarket-cli has **no declared license** — verify before any code copy, API reference-only is safe
2. polymarket-cli is "early, experimental software" — pin to commit, subscribe to releases, expect breakage
3. **Real money at risk** — Stage B track record (30+ days paper positive) is a hard prerequisite
4. **Wallet security is the hardest operational question**, not a code question — budget session time explicitly
5. **Reward farming ≠ free money** — market-making carries bid-ask risk, model it honestly

---

## Session 69 Deferred Items — Review at v7.5 or Phase β F-step

Items analyzed and approved in session 69 but not implemented. Each has a memory reference with full details.

**Phase β F-step anchored (implement at stated F-step):**

| Item                                                                                                             | F-step       | Memory Reference                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------- |
| Port orderbook walking, position tracking, P&L analytics, API caching, multi-account A/B                         | F5→F7 bridge | `reference_polymarket_paper_trader.md` |
| Port Zeta composite, CVD divergence, order blocks, rejection-gate scoring, Fibonacci entry/exit                  | F3/F7/F8     | `reference_bybit_screening_bot.md`     |
| Fan-out→funnel multi-agent architecture, universal signal format, constraint-before-LLM, vol×corr risk sizing    | F7           | `reference_ai_hedge_fund.md`           |
| Kronos-mini forecast model (replaces TimesFM) — Python sidecar, OHLCV output, probabilistic 5-sample quantiles   | F7           | `reference_kronos.md`                  |
| Indicator condition DSL — declarative signal rules (crosses_above/below, compareMode value\|indicator, offsets)  | F3           | `reference_fincept_terminal.md`        |
| Config-driven agent manifest — specialists as JSON `{model, instructions, tools, output_format}`, not classes    | F7           | `reference_fincept_terminal.md`        |
| Guardrails pre-execution layer — position/confidence/symbol checks BEFORE broker call, clamp_quantity helper     | F8           | `reference_fincept_terminal.md`        |
| BM25 reflection memory — per-agent banks, inject top-2 lessons from past P&L into next prompts (~220 LOC)        | F7 (M2+)     | `reference_trading_agents.md`          |
| Adversarial critic pass — single bull/bear critic over Portfolio Manager draft + judge reconciliation (~150 LOC) | F7           | `reference_trading_agents.md`          |
| Black-Litterman signal combiner — blend multi-agent signals as views into posterior beliefs (~150 LOC, mathjs)   | F7           | `reference_skfolio.md`                 |
| HRP weight allocator — Lopez de Prado hierarchical risk parity, replaces heuristic confidence-weighted sum       | F7           | `reference_skfolio.md`                 |
| Inverse-volatility + equal-weight baseline allocators — ship before HRP as fallbacks (~30 LOC)                   | F7 (M1)      | `reference_skfolio.md`                 |

**v7.5 anchored (implement during skill evolution engine):**

| Item                                                                              | Source                          | Memory Reference                |
| --------------------------------------------------------------------------------- | ------------------------------- | ------------------------------- |
| Prometheus reflector: per-dimension critiques with evidence instead of pass/fail  | RationalRewards paper           | `reference_rational_rewards.md` |
| Predictive consistency gate: rationale must predict outcome without seeing answer | RationalRewards paper           | `reference_rational_rewards.md` |
| Skill evaluation loop: draft→test with/without→grade→improve cycle                | anthropics/skills skill-creator | `reference_anthropic_skills.md` |
| Tool annotations: readOnlyHint, destructiveHint, idempotentHint on tool registry  | anthropics/skills mcp-builder   | `reference_anthropic_skills.md` |

**Adopt during relevant feature work (no fixed timeline):**

| Item                                               | Trigger                                | Memory Reference                    |
| -------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| Browser pool with atomic slot reservation          | Multi-agent browser sharing            | `reference_maxun.md`                |
| Pagination auto-detection (5 strategies)           | Building `web_crawl` tool              | `reference_maxun.md`                |
| pg-boss job queue (PostgreSQL-backed)              | Rituals/scheduling reliability upgrade | `reference_maxun.md`                |
| Landing page CRO framework                         | Client landing page work               | `reference_landing_page_cro.md`     |
| Three-tier ownership (runtime/first-fix/canonical) | Multi-layer debugging sessions         | `reference_three_tier_ownership.md` |

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
                                                   │
                                            F11 (live Polymarket trading, after F6 + F8 track record)

FEATURE VERTICALS (Tier B — phase γ, layered on top)
  v7.2 Graphify ────────────── independent
  v7.1 Charts + vision ──────── after F3
  v7.3 P2 SEO telemetry ─────── after v7.6
  v7.3 P3 AI overview monitor ─ after F1 schedule infra
  v7.3 P4 Ads buyer ──────────── independent
  v7.3 P5 GEO depth ──────────── independent
  v7.13 Structured PDF ingest ── after pgvector (✅); unblocks F7 retrieval
  v7.14 Infographic generation ─ independent; cross-cuts F9/CRM/social
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

## Total Effort (by phase)

### Phase α — Shipped (5 items, 5 sessions)

| Version | Theme                                    | Sessions | Status   |
| ------- | ---------------------------------------- | -------- | -------- |
| v7.3 P1 | SEO/GEO tool suite                       | 1        | **Done** |
| v7.6    | Workspace expansion (gws)                | 1        | **Done** |
| v7.7    | Jarvis MCP server                        | 1        | **Done** |
| v7.8 P1 | Autoreason lifts (CoT+k=2+gap telemetry) | 1        | **Done** |
| v7.9    | Prometheus Sonnet port                   | 1        | **Done** |

### Phase α.2 — Gated decision (0.5 session)

| Version | Theme                                       | Sessions | Status                 |
| ------- | ------------------------------------------- | -------- | ---------------------- |
| v7.8 P2 | Autoreason tournament decision (2026-04-20) | 0.5      | **Gated** (fixed date) |

### Phase β — Financial Stack critical path (12 items, all shipped)

| Version   | Theme                                               | Sessions | Status   |
| --------- | --------------------------------------------------- | -------- | -------- |
| v7.0 F1   | Data layer (AV + Polygon + FRED)                    | 1.7      | **Done** |
| v7.0 F2   | Indicator engine                                    | 1        | **Done** |
| v7.0 F4   | Watchlist + market tools                            | 1        | **Done** |
| v7.0 F5   | Macro regime detection                              | 0.5      | **Done** |
| v7.0 F3   | Signal detector                                     | 1        | **Done** |
| v7.0 F6   | Prediction markets + whale tracker                  | 1.5      | **Done** |
| v7.0 F6.5 | Sentiment signals (F&G x2)                          | 0.7      | **Done** |
| v7.13     | Structured PDF ingestion (pre-F7 enabler, Option B) | 0.5      | **Done** |
| v7.0 F7   | Alpha combination engine                            | 2.5      | **Done** |
| v7.0 F7.5 | Strategy backtester (CPCV, PBO, DSR)                | 1        | **Done** |
| v7.0 F8   | Paper trading (pm-trader + VenueAdapter)            | 1.5      | **Done** |
| v7.0 F9   | Scan rituals + calendar                             | 1        | **Done** |

**β subtotal:** ~14.9 sessions sequential. **All 12 items shipped by session 81 (2026-04-20).**

### Phase β-addendum — Polymarket coverage (2 items, all shipped)

| Version    | Theme                              | Sessions | Status   |
| ---------- | ---------------------------------- | -------- | -------- |
| v7.0 F8.1a | Prediction-market alpha layer      | 1        | **Done** |
| v7.0 F8.1b | PolymarketPaperAdapter (TS-native) | 1.5      | **Done** |

**β-addendum subtotal:** 2.5 sessions. **Both shipped by session 83 (2026-04-20). Phase β closes.**

### Phase β-opt — Optional parallel (1 session)

| Version  | Theme                      | Sessions | Status      |
| -------- | -------------------------- | -------- | ----------- |
| v7.0 F10 | Real-time crypto WebSocket | 1        | **Planned** |

### Phase γ — Feature verticals (post-β, 13 items — 1 shipped, 12 remaining)

| Version | Theme                                         | Sessions | Deps          | Status                      |
| ------- | --------------------------------------------- | -------- | ------------- | --------------------------- |
| v7.2    | Knowledge graph (Graphify)                    | 1.5      | None          | **Done (MVP)** — session 84 |
| v7.3 P4 | Digital marketing buyer (claude-ads)          | 3        | None          | **Planned**                 |
| v7.3 P5 | GEO depth (llms.txt + Princeton)              | 1        | None          | **Planned**                 |
| v7.10   | Universal file conversion (calibre/LO/pandoc) | 1        | None          | **Done** — session 85       |
| v7.11   | Jarvis teaching module                        | 2        | None          | **Done** — session 89       |
| v7.12   | Diagram generation (graphviz + svg_html)      | 1        | None          | **Done (MVP)** — session 86 |
| v7.14   | Infographic generation (AntV)                 | 1        | None          | **Done** — session 87       |
| v7.3 P2 | SEO telemetry (PageSpeed + GSC)               | 1        | v7.6 ✅       | **Planned**                 |
| v7.3 P3 | AI overview monitoring                        | 1        | F1 ✅         | **Planned**                 |
| v7.1    | Charts + vision chart patterns                | 1.5      | F3 ✅         | **Planned**                 |
| v7.4    | Video production (S1+S2)                      | 2        | v7.3 P4       | **Planned**                 |
| v7.4.3  | HTML-as-composition DSL (hyperframes #6)      | 1        | v7.4          | **Planned**                 |
| v7.5    | Skill evolution (GEPA + SkillClaw)            | 2        | F9 ✅ + sweep | **Planned**                 |

**γ subtotal:** ~19 sessions (~14–15 with parallelizable independents). **6/13 done; 7 remaining.**

### v7.2.1 — v7.2 follow-ups (queued, not yet scheduled)

| Item                              | Trigger                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| Codebase **semantic** graph       | Upstream graphify issue #451 closes OR 30-file TS trial clears |
| CRM entity graph                  | md-export pipeline designed in crm-azteca                      |
| Cross-source unified query router | After ≥2 graphs ship                                           |
| Automatic rebuild cron            | First stale-graph incident                                     |

### Phase δ — Live trading (gated on 30d F8 paper record)

| Version  | Theme                          | Sessions | Status                      |
| -------- | ------------------------------ | -------- | --------------------------- |
| v7.0 F11 | Live Polymarket trading engine | 2.5      | **Gated** (30d paper track) |

### Phase ε — Conditional (post 2026-04-20 decision)

| Version | Theme                                | Sessions | Status          |
| ------- | ------------------------------------ | -------- | --------------- |
| v7.8 P3 | Autoreason targeted tournament pilot | 2        | **Conditional** |

### Totals

| Bucket                                 | Count  | Sessions              |
| -------------------------------------- | ------ | --------------------- |
| Shipped (α + β + β-addendum + γ S1-S6) | **25** | ~27                   |
| Gated / conditional (δ + ε)            | 2      | 4.5                   |
| β-opt (optional)                       | 1      | 1                     |
| γ remaining                            | 7      | ~12.5                 |
| **Total committed**                    | **35** | **~43 seq / ~34 par** |
| **Remaining to close v7**              | **10** | **~18 seq / ~15 par** |

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
