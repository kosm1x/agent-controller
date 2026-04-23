# Jarvis Tool & Service Catalog

> **Last updated**: 2026-04-23 (Session 101 close)
> **Source of truth for tool registration**: `src/tools/sources/builtin.ts`
> **Version history**: `docs/V7-ROADMAP.md`
> **This doc**: structured reference — tools by version (evolution) AND by category (lookup). Read this to understand what Jarvis can call today and how it got here.

---

## At-a-glance

| Dimension                       | Value                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runners                         | 5 types: fast, nanoclaw, heavy (Prometheus), swarm, a2a                                                                                                                                      |
| Total tools available to Jarvis | ~246 (227 builtin + 8 jarvis\_\* MCP (read-only, env-gated) + 62 external MCP + 20 Google + 1 gws dispatch)                                                                                  |
| Tools gated by deferral         | 167 (saves ~52% prompt tokens)                                                                                                                                                               |
| Scope groups                    | 22 (see `DEFAULT_SCOPE_PATTERNS` in `src/messaging/scope.ts`)                                                                                                                                |
| Core deps                       | 15 + 2 messaging                                                                                                                                                                             |
| Tests                           | 3733                                                                                                                                                                                         |
| External services (non-LLM)     | Hindsight, Supabase, Prometheus (observability), Caddy (proxy), Grafana, LightPanda, Playwright MCP, MCP: context7, sequential-thinking, graphify-code, Gmail, Google Calendar, Google Drive |
| LLM providers                   | Claude Agent SDK (primary, `INFERENCE_PRIMARY_PROVIDER=claude-sdk`), OpenAI-compatible fallback (qwen, kimi via rotation)                                                                    |

---

## Evolution — major milestones

The version arcs below are sequential. Feature verticals (γ) shipped in parallel bursts once infrastructure (α/β) was in place. See `V7-ROADMAP.md` for sprint-by-sprint detail with commit SHAs.

### v1 — Foundation (Done)

**The runtime.** Hono HTTP server, SQLite/WAL, X-Api-Key auth, persistent event bus, 5-way classifier, dispatcher, fast/nanoclaw/heavy/swarm/a2a runners, Prometheus PER loop (plan → execute → reflect), MCP integration, A2A protocol, web dashboard.

### v2.1–v2.13 — Tool plugin system + external integrations (Done)

**The first capabilities.** Browser (LightPanda + Playwright MCP). Web: web_search via EXA, web_read, exa_search. Local PDF via `@opendataloader/pdf`. Google Workspace (19 tools across gdocs/gsheets/gdrive/gmail/gcal/gslides/gtasks). Hindsight memory backend (external Docker). Adaptive intelligence (Jarvis personality).

### v2.14–v2.22 — Hardening + verticals (Done)

Production guards, 3-layer guardrails. **Coding toolkit** (git_status/diff/commit/push, shell_exec, file_read/write/edit/delete, list_dir, glob, grep). **WordPress** (10 tools). Hallucination detector. Dynamic tool scoping (deferral pattern introduced). Telegram vision. Sandboxed shell with deny-list.

### v2.23–v2.30 — Strategic autonomy + self-tuning (Done)

Jarvis unification. Project entity. Strategic autonomy via `jarvis_propose_directive`. HyperAgents (skill evolution). Self-tuning overnight loop. 7-layer hallucination defense. pdf_read, hf_generate, hf_spaces. Fast-path (~2s Telegram responses). Streaming. Scope isolation.

### v3.0 — Production hardening (Done)

Systemd, Pino logging, model benchmark, provider rotation.

### v4.0 S1–S9 — Observability + security (Done)

DB indexes, shell security, Gemini research, Playwright, **scope telemetry** (the `scope_telemetry` table this audit relies on), decomposition, hallucination protocol. 894 tests.

### v5.0 S1–S5 — Guards + memory + concurrency (Done)

4-layer doom-loop detection. Escalation ladder. Circuit breakers (the shared registry used in Dim-4). Session repair. Memory compaction pipeline. Auto-persist. Spending quotas (the budget-exhaustion path tested in R9). **Concurrent task isolation** (per-task context, task_history tool). **CRM integration** (bidirectional REST, jarvis-pull). Knowledge maps. Research verification (provenance tracking — the `task_provenance` table).

### v6 series — Semantic classifier + KB migration (Done)

BRAID prompt enhancer. pgvector KB migration (planning). **v6.4 CL1.1**: Semantic scope classifier — LLM understands user intent, regex stays as fallback. This is the `semanticGroups` path audited in Dim-5 T8.

### v7 phase α — Infrastructure unblockers (Done)

5 items shipped: v7.3 P1, v7.6, v7.7, v7.8 P1, v7.9.

- **v7.6**: gws CLI (dispatch tool for Google Workspace — `gws` single tool replaces per-API proliferation)
- **v7.7**: Jarvis MCP server (8 `jarvis_*` read-only tools exposed via MCP, env-gated)
- **v7.9**: Prometheus Sonnet port (heavy runner on Claude Agent SDK)

### v7 phase α.2 — Autoreason decision (Closed 2026-04-20)

v7.8 P2: evaluation-by-data decision on the tournament reasoner upgrade. avg_gap=0.029 (7-day, n=8) << 0.10 threshold → Phase 3 declined. See `feedback_evaluation_by_data_decision.md` for the pattern.

### v7 phase β — Financial Signal Detection Stack (Done, 12/12 original)

**v7.0 thesis.** Sequential build:

| Sprint    | Shipped       | What                                                                     |
| --------- | ------------- | ------------------------------------------------------------------------ |
| F1        | session 67    | Data layer (ingest, normalize, persist OHLCV)                            |
| F2/F4     | session 70    | Indicator engine (SMA, EMA, RSI, MACD, BB, VWAP, ATR) + watchlist tools  |
| F5/F3     | session 72    | Macro regime detector (FRED) + signal detector (crossovers, divergences) |
| F6/F6.5   | session 74    | External signals (whale_trades, prediction_markets, sentiment_snapshot)  |
| v7.13     | session 75    | PDF structured ingestion (10-K, research papers) — Option B (no MinerU)  |
| F7        | session 77    | Alpha combination engine (Fama-MacBeth scalar β)                         |
| F7.5      | session 79    | Strategy backtester with CPCV + PBO + DSR firewall                       |
| F8        | session 80    | Paper-trading executor (equity-first)                                    |
| F8.1a/b/c | session 81-83 | Polymarket alpha + PolymarketPaperAdapter + daily cadence                |
| F9        | session 81    | Morning + EOD rituals (market-open, market-close, pre-market)            |

### v7 phase γ — Feature verticals (Done, 13/13 + v7.5 extended)

Parallel bursts after β closed.

| Sprint           | Shipped       | What                                                                               |
| ---------------- | ------------- | ---------------------------------------------------------------------------------- |
| v7.2             | session 84    | Graphify MCP integration (code knowledge graph)                                    |
| v7.10            | session 85    | `file_convert` tool (5 format gaps: ebooks, office, HEIC, pandoc, ffmpeg)          |
| v7.12            | session 86    | `diagram_generate` (graphviz + LLM svg_html)                                       |
| v7.14            | session 87    | `infographic_generate` (AntV DSL, pure-JS SSR)                                     |
| v7.1             | session 88    | Chart rendering + patterns (SVG builder + ImageMagick PNG)                         |
| v7.11            | session 89    | Jarvis Teaching Module                                                             |
| v7.3 P1+P2+P3+P5 | session 90-92 | SEO + GEO suite (content-brief, page-audit, keyword-research, SERP + rank tracker) |
| v7.3 P4a         | session 93    | Digital Marketing Buyer (ads_audit + ads_brand_dna + ads_creative_gen)             |
| v7.4 S1+S2a      | session 94-95 | Video Composition Engine + Video Storyboard Pipeline                               |
| v7.4.3           | session 98    | HTML-as-Composition DSL (video_html_compose)                                       |
| v7.5 (extended)  | session 99    | Skill Evolution Engine — 6-item surgical extension to `src/tuning/`                |

### Session 100 — Sonnet across all runners (Done 2026-04-22)

Sonnet 4.6 now primary across fast + heavy-in-process + Prometheus + nanoclaw + heavy-containerized. Container routing fixed: `INFERENCE_PRIMARY_PROVIDER` forwarded into Docker, `.claude/.credentials.json` mounted read-only, `mission-control:latest` image rebuilt. Commits `bd68fb1` + `350c90f`.

### Session 101 — Full-system audit (Done 2026-04-22 → 2026-04-23)

All 5 dimensions closed. 20 Critical + 11 Major + 3 Warning fixes. See `README.md` "Current status" for the detailed finding list and `docs/audit/2026-04-22-*.md` for per-dimension reports.

### Freeze window (2026-04-22 → 2026-05-22)

No new tools / adapters / scope entries during this window. Jarvis autonomous builds remain in their own repos; MCP bridges only for Jarvis-side consumption.

---

## Current tool surface — by category

Each tool has `deferred: true|false` controlling whether it loads at prompt-construction or only on scope activation. Read `CLAUDE.md` invariants for discipline; `src/tools/builtin/` is the handler source; `src/tools/sources/builtin.ts:BUILTIN_TOOLS` is the canonical registry array.

### Always-loaded (core)

Essential tools for every conversation. Not deferred.

- `web_search` — EXA-powered web search
- `web_read` — extract article text from a URL
- `exa_search` — semantic search over Exa's corpus
- `user_fact_set` / `user_fact_list` / `user_fact_delete` — user profile
- `skill_save` / `skill_list` — reusable skill vault
- `file_read` — read `.txt`, `.docx`, downloaded attachments
- `list_dir` — browse VPS filesystem
- `task_history` — Jarvis queries its own past executions
- `jarvis_file_read` — NorthStar visions/goals
- `jarvis_file_list` — list jarvis_files/

### Google Workspace (scope group: `google`)

- `gdocs_read` / `gdocs_write` — Google Docs
- `gsheets_read` / `gsheets_write` — Sheets
- `gslides_read` / `gslides_create` — Slides
- `gdrive_list` / `gdrive_create` / `gdrive_upload` / `gdrive_move` / `gdrive_share` / `gdrive_delete` — Drive
- `gmail_search` / `gmail_read` / `gmail_send` — Gmail
- `calendar_list` / `calendar_create` / `calendar_update` — Calendar
- `gtasks_create` — Tasks
- `gws` — dispatcher tool (v7.6) wrapping the above via CLI (preferred for complex multi-step workflows)
- MCP: `claude_ai_Gmail`, `claude_ai_Google_Calendar`, `claude_ai_Google_Drive` (external MCPs available for supplementary access)

### WordPress (scope group: `wordpress`)

- `wp_list_posts` / `wp_read_post` — read
- `wp_publish` — create/update posts
- `wp_delete` — delete
- `wp_media_upload` — media library
- `wp_categories` / `wp_pages` / `wp_plugins` / `wp_settings` / `wp_raw_api` — admin

### NorthStar (vision/goals/tasks) (scope groups: `northstar_read` / `northstar_write` / `northstar_journal`)

- `commit__list_objectives` / `commit__list_goals` / `commit__list_tasks` / `commit__list_ideas`
- `commit__get_hierarchy` / `commit__get_daily_snapshot`
- `commit__create_objective` / `commit__create_task` / `commit__update_task` / `commit__update_goal` / `commit__update_objective` / `commit__update_status` / `commit__delete_item`
- `commit__search_journal`
- `northstar_sync` — bidirectional LWW sync with self-heal

### Intel Depot (scope group: `intel`)

Signals ingested from 8 sources, queryable.

- `intel_query` — filter signals by domain/source/hours
- `intel_status` — adapter health
- `intel_alert_history` — recent alerts
- `intel_baseline` — compute baseline for a signal
- Sources behind intel_query: `usgs`, `nws`, `gdelt`, `frankfurter`, `cisa_kev`, `coingecko`, `treasury`, `google_news`

### Markets (scope groups: `markets`, `portfolio`, `alpha`)

- `market_prices` / `market_indicators` / `market_history` — core OHLCV + indicators
- `market_watchlist_add` / `market_watchlist_list` — watchlist
- `market_signals` — crossover/divergence detection
- `market_macro_snapshot` / `market_macro_regime` — FRED + regime
- `pm_alpha` / `pm_markets` / `pm_trader` — Polymarket (prediction markets)
- `whale_trades` — large on-chain transfers
- `sentiment_snapshot` — news/social sentiment
- `alpha_combine` — Fama-MacBeth scalar β combination
- `strategy_backtest` — CPCV + PBO + DSR firewall
- `pm_paper_rebalance` / `pm_paper_portfolio` / `pm_paper_history` — Polymarket paper trading
- `paper_rebalance` / `paper_portfolio` / `paper_history` — equity paper trading
- `market_chart_render` / `market_chart_patterns` — SVG charts + pattern detection

### Coding (scope group: `coding`)

- `git_status` / `git_diff` / `git_commit` / `git_push` — git ops
- `gh_repo_create` / additional `gh` ops via shell — GitHub
- `file_write` / `file_edit` / `file_delete` — filesystem mutation
- `list_dir` / `glob` / `grep` — navigation + search
- `shell_exec` — sandboxed shell (denylist)
- `jarvis_dev` — sandboxed Jarvis self-modification (`action: branch|test|pr|status`)
- `jarvis_test_run` — run Jarvis's own tests

### Research (scope group: `research`)

- `web_search` / `web_read` / `exa_search` (also core)
- `gemini_research` — Gemini-powered research with URL + local file support
- `output_citation` — structured citation output
- `memory_search` / `memory_store` — Hindsight memory

### Browser automation (scope group: `browser`)

MCP bridges to two browser stacks.

- `browser__goto` / `browser__evaluate` / `browser__interactiveElements` / `browser__links` / `browser__markdown` — LightPanda (lightweight)
- `playwright__browser_navigate` / `playwright__browser_click` / `playwright__browser_fill_form` / `playwright__browser_snapshot` / `playwright__browser_take_screenshot` — Playwright MCP (full-browser)

### Scheduling (scope group: `schedule`)

- `schedule_task` — create a one-time or cron scheduled task
- `list_schedules` / `delete_schedule` — manage
- Static rituals: morning-briefing, nightly-close, market-open, market-close, pre-market, proactive-scan, autonomous-improvement, kb-backup, stale-artifact-prune, memory-consolidation, diff-digest

### CRM (scope group: `crm`)

- `crm_query` — bidirectional REST to `agentic-crm` service (port 3000)

### SEO + GEO (scope group: `seo`)

- `seo_keyword_research`
- `seo_page_audit`
- `seo_content_brief`
- `seo_serp_snapshot` / `seo_rank_tracker`

### Ads / Digital Marketing Buyer (scope group: `ads`)

- `ads_audit` — 7 platforms, ~70 checks, A-F grade
- `ads_brand_dna` — brand voice extraction
- `ads_creative_gen` — creative generation with framework library (AIDA, BAB, FAB, ROAS, CPA)

### Video production (scope group: `video`)

- `video_create` / `video_status` / `video_list_profiles` — video generation
- `video_script` — script composition
- `video_tts` — text-to-speech
- `video_image` — scene images
- `video_compose_manifest` / `video_html_compose` — composition DSLs

### Multimedia / design (scope group: `specialty` / `chart`)

- `chart_render` / `chart_patterns` — SVG + pattern overlay
- `diagram_generate` — graphviz `dot` or inline LLM svg_html
- `infographic_generate` — AntV DSL (276 templates)
- `gemini_image` — Gemini image gen
- `hf_generate` — HuggingFace inference

### Messaging / delivery

- Telegram bot (Baileys-based, not a tool — runtime messaging channel)
- WhatsApp (grammy-based, ditto)

### Knowledge / graph

- `memory_search` / `memory_store` — Hindsight + SQLite fallback
- `graphify-code__*` — code knowledge graph (7 tools via external Python MCP)
- MCP: `context7__query-docs` / `resolve-library-id` — library docs
- MCP: `sequential-thinking__sequentialthinking` — scratchpad reasoning

### Admin / self-management

- `jarvis_propose_directive` — Jarvis can propose changes to its own directives
- `jarvis_file_search` / `jarvis_file_update` / `jarvis_file_write` / `jarvis_file_delete` — jarvis_files CRUD
- `project_list` / `project_get` / `project_update` — project registry
- `task_history` — Jarvis queries its own task log

### Utilities (scope group: `utility`)

- `http_fetch` — generic HTTP request (use dedicated tools when available)
- `pdf_read` — local PDF extraction
- `file_convert` — format bridge (ebooks, office, images, doc↔doc via pandoc, video frames via ffmpeg)
- `hf_generate` / `hf_spaces` — HuggingFace
- `vps_status` / `vps_logs` / `vps_deploy` — VPS management

### Social (scope group: `social`)

- Various social content tools (see `src/tools/builtin/social.ts`)

### Writing (scope group: `writing`)

- `writing` — writing/editing assistant tool

---

## External services

Not Jarvis "tools" per se — supporting services that Jarvis talks to.

| Service                     | Where                                | Port                 | Purpose                                  | Stability        |
| --------------------------- | ------------------------------------ | -------------------- | ---------------------------------------- | ---------------- |
| mission-control             | systemd, compiled JS                 | 8080                 | Jarvis agent orchestrator (this service) | Primary          |
| agentic-crm                 | systemd, tsx                         | 3000                 | CRM engine (Azteca)                      | External repo    |
| Hindsight                   | Docker (`crm-hindsight`)             | 8888, 9999           | Long-term memory                         | Primary backend  |
| Prometheus (metrics)        | Docker (`mc-prometheus`)             | 9090                 | Metrics scrape target                    | Observability    |
| Supabase                    | Docker stack                         | 5433, 8100, 3100     | Postgres + API + Studio                  | Shared platform  |
| Grafana                     | Docker / Caddy                       | 3200 (Caddy-proxied) | Dashboards                               | Observability    |
| Caddy                       | system binary                        | 80, 443              | Reverse proxy + TLS                      | Edge             |
| LightPanda                  | binary (`./bin/lightpanda`)          | MCP stdio            | Lightweight browser                      | MCP server       |
| Playwright MCP              | npx                                  | MCP stdio            | Full-browser automation                  | MCP server       |
| context7                    | npm                                  | MCP stdio            | Library documentation lookup             | MCP server       |
| sequential-thinking         | npm                                  | MCP stdio            | Scratchpad reasoning                     | MCP server       |
| graphify-code               | Python venv + MCP                    | MCP stdio            | Code knowledge graph                     | Env-gated        |
| Claude Agent SDK            | npm `@anthropic-ai/claude-agent-sdk` | (direct)             | Primary inference                        | Primary provider |
| OpenAI-compatible providers | HTTPS                                | (direct)             | Fallback inference (qwen, kimi)          | Secondary        |

---

## Deprecated / pruned

- **commit-ai** — standalone React app, NOT integrated. NorthStar replaces it in-process.
- Various pre-v5 experimental tools pruned in v4 consolidation (ask `git log src/tools/` for specifics).

---

## Deferred / planned (gated on post-freeze)

Per `docs/V7-ROADMAP.md`:

- **F10** (Real-time crypto, β-opt, parallel) — planned
- **F11** (Live trading, δ) — gated on 30+ days of F8 paper-trading record
- **v7.5.1** — deferred
- **v7.6.x** deferrals — deferred
- **v7.8 P3** (Autoreason tournament, ε) — declined 2026-04-20
- **v7.13.x** deferrals — deferred
- **v7.14.1** PNG output / streaming / retry — deferred
- **xpoz-intelligence-pipeline-manager MCP bridge** — next Jarvis-side integration (pending Jarvis plan)

---

## How to find a tool

1. **Know the name?** `grep -n "name: \"<name>\"" src/tools/builtin/*.ts`
2. **Know the category?** Find it in this doc by scope group, then read the corresponding `src/tools/builtin/<category>.ts`
3. **Not sure?** Check `src/tools/sources/builtin.ts:BUILTIN_TOOLS` — the canonical registration array
4. **Need to add a new one?** NOT during freeze. Post-freeze: `CLAUDE.md` → "Adding a new tool" pattern

---

## Scope groups (the deferral control surface)

From `src/messaging/scope.ts:DEFAULT_SCOPE_PATTERNS`:

`google`, `wordpress`, `northstar_read`, `northstar_write`, `northstar_journal`, `intel`, `markets`, `portfolio`, `alpha`, `coding`, `research`, `browser`, `schedule`, `crm`, `seo`, `ads`, `video`, `specialty`, `chart`, `graph`, `social`, `writing`, `meta`, `utility`, `destructive`, `jarvis_write`

Each has a regex triggering on user message; matching groups load their associated tools into the prompt. ~52% token savings vs loading all ~246 tools every turn.

The semantic classifier (`v6.4 CL1.1` — `src/messaging/scope-classifier.ts`) is the primary matcher; the regex patterns are fallback for classifier timeouts. NFC normalization is enforced at both entry points (Dim-5 C-SCP-1 fix).
