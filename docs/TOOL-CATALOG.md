# Jarvis Tool & Service Catalog

> **Last updated**: 2026-09-26 (tool surface re-verified against code: static enumeration of the exported tool objects = **194** — builtin 150 + WordPress 10 + CRM 1 + `google_workspace_cli` 1 + Google 22 + memory 5 + skills 5; live registry **234** at the 2026-09-26 03:21 UTC boot. Earlier: `memory_forget` added 2026-09-12, CORE + confirm-gated; every tool description passes the not-for ratchet in `src/tools/description-lint.test.ts` or is pinned in its legacy list)
> **Source of truth for tool registration**: `src/tools/sources/builtin.ts` (+ `google.ts`, `memory.ts`, `skills.ts`, `mcp.ts`; wired in `src/index.ts`). **Source of truth for scope groups**: the `*_TOOLS` arrays in `src/messaging/scope.ts`
> **Version history**: `docs/V7-ROADMAP.md`
> **This doc**: structured reference — tools by version (evolution) AND by category (lookup). Read this to understand what Jarvis can call today and how it got here.

---

## At-a-glance

| Dimension                       | Value                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runners                         | 5 types: fast, nanoclaw, heavy (Prometheus), swarm, a2a                                                                                                                                           |
| Total tools available to Jarvis | **234** — live registry per service log (2026-09-26 03:21 UTC boot), 5 ToolSources: builtin 162 + mcp 43 + google 22 + memory 2 (KG/pgvector only; Hindsight backend off) + skills 5              |
| Tools gated by deferral         | 143 of the 194 static tools declare `deferred: true` (2026-09-26); MCP tools not counted                                                                                                          |
| Scope groups                    | 35 regex groups (`DEFAULT_SCOPE_PATTERNS` in `src/messaging/scope.ts`); 26 classifier groups (`VALID_GROUPS` in `src/messaging/scope-classifier.ts`)                                              |
| Core deps                       | 18 + 2 messaging (20 in `package.json`, 2026-09-26)                                                                                                                                               |
| Tests                           | 9,441 (full suite 2026-09-26; 488 `*.test.ts` files under `src/` + `scripts/`)                                                                                                                    |
| External services (non-LLM)     | Hindsight, Supabase, Prometheus (observability), Caddy (proxy), LightPanda, Playwright MCP, MCP: graphify-code, xpoz, Google Workspace APIs (Gmail, Calendar, Drive, Docs, Sheets, Slides, Tasks) |
| LLM providers                   | Claude Agent SDK (primary, `INFERENCE_PRIMARY_PROVIDER=claude-sdk`), OpenAI-compatible fallback (qwen, kimi via rotation)                                                                         |

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

`CORE_TOOLS` + `MISC_TOOLS` in `src/messaging/scope.ts` — in every conversation's tool list regardless of scope.

- `web_search` — Brave Search API
- `web_read` — extract article text from a URL (Jina Reader + stealth-browser fallback)
- `exa_search` — semantic search over Exa's corpus
- `user_fact_set` / `user_fact_list` / `user_fact_delete` — user profile
- `memory_forget` — 2026-09-12, deferred, confirm-gated: invalidates the active knowledge-graph facts of a subject (temporal, history kept) and/or deletes ONE correction-loop entry `corrections/<12 hex>.md` from the pgvector KB via `pgDelete`; NOT for personal facts (`user_fact_delete`) or KB files (`jarvis_file_delete`)
- `skill_save` / `skill_list` — reusable skill vault
- `file_read` — read `.txt`, `.docx`, downloaded attachments
- `data_summarize` — deterministic row counts + column statistics over CSV/TSV/JSON/markdown tables (computed, never estimated)
- `list_dir` — browse VPS filesystem
- `task_history` — Jarvis queries its own past executions
- `jarvis_file_read` / `jarvis_file_list` — read / list the Jarvis knowledge base
- `jarvis_file_search` / `jarvis_file_write` / `jarvis_file_update` / `jarvis_file_delete` / `jarvis_file_move` / `jarvis_files_batch_write` / `jarvis_files_batch_delete` — KB CRUD (always-on since 2026-05-07)
- `list_schedules`, `project_list` / `project_get` / `project_update`, `video_status`, `vps_status`, `northstar_sync`, `browser__goto` / `browser__markdown` — the rest of `MISC_TOOLS`
- `shell_exec` / `file_write` / `file_edit` / `git_status` / `git_diff` / `git_commit` / `git_push` — coding core, not deferred since 2026-09-01 (under `TOOL_SEARCH_ENABLED` a deferred tool is visible only after a `ToolSearch` hit; tasks 8958/8961–8963 searched once, missed, went BLOCKED). Still scope-gated to `coding`; pinned by `core-coding-always-loaded.test.ts`.

### Google Workspace (scope group: `google`)

Registered by the Google ToolSource when `GOOGLE_CLIENT_ID` + `GOOGLE_REFRESH_TOKEN` are set.

- `gdocs_read` / `gdocs_read_full` / `gdocs_write` / `gdocs_replace` — Google Docs
- `gsheets_read` / `gsheets_write` — Sheets
- `gslides_read` / `gslides_create` — Slides
- `gmail_send` / `gmail_search` / `gmail_read` — Gmail
- `gdrive_list` / `gdrive_create` / `gdrive_share` / `gdrive_delete` / `gdrive_move` / `gdrive_upload` / `gdrive_download` — Drive
- `calendar_list` / `calendar_create` / `calendar_update` — Calendar
- `gtasks_create` — Tasks
- `google_workspace_cli` — dispatcher tool (v7.6, the "gws" CLI) for Workspace APIs not covered by a dedicated handler (Chat, etc.); registered only when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` are all set
- The google group also pulls in `pdf_read`, `gemini_upload`, `gemini_research` (2026-07-22: a bare Drive link carries no research keyword)

### WordPress (scope group: `wordpress`)

Registered only when `WP_SITES` is set.

- `wp_list_posts` / `wp_read_post` — read
- `wp_publish` — create/update posts
- `wp_delete` — delete
- `wp_media_upload` — media library
- `wp_categories` / `wp_pages` / `wp_plugins` / `wp_settings` / `wp_raw_api` — admin
- The wordpress group also adds `humanize_text`

### NorthStar (vision/goals/tasks) (scope groups: `northstar_read` / `northstar_write` / `northstar_journal`)

The `commit__*` MCP tools are gone (no `commit` server in `mcp-servers.json`; no reference in `src/`). NorthStar content lives in the Jarvis KB and is read/written with the always-on `jarvis_file_*` tools.

- `northstar_sync` — bidirectional LWW sync with db.mycommit (self-heal); always-on via `MISC_TOOLS`
- `northstar_journal` and `destructive` are intent-only groups (they add no tools of their own)

### Intel Depot (scope group: `intel`)

Signals ingested from 8 sources, queryable.

- `intel_query` — filter signals by domain/source/hours
- `intel_status` — adapter health
- `intel_alert_history` — recent alerts
- `intel_baseline` — compute baseline for a signal
- Sources behind intel_query (`src/intel/adapters/`): `usgs`, `nws`, `gdelt`, `frankfurter`, `cisa_kev`, `coingecko`, `treasury`, `google_news`

### Markets (scope groups: `finance`, `alpha`, `backtest`, `paper`, `pm_alpha`, `pm_paper`, `market_ritual`, `chart`)

- `market_quote` / `market_history` / `market_indicators` — price snapshot, OHLCV, indicators (`finance`)
- `market_watchlist_add` / `market_watchlist_list` / `market_watchlist_remove` / `market_watchlist_reseed` — watchlist (`finance`)
- `market_scan` / `market_signals` — threshold scan + crossover/divergence detection (`finance`)
- `macro_regime` — FRED + Alpha Vantage regime classifier (`finance`)
- `market_budget_stats` — Alpha Vantage / Polygon / FRED API budget (`finance`)
- `prediction_markets` — Polymarket markets (`finance`)
- `whale_trades` — large on-chain transfers (`finance`)
- `sentiment_snapshot` — news/social sentiment (`finance`)
- `alpha_run` / `alpha_latest` / `alpha_explain` — F7 alpha combination engine, Fama-MacBeth scalar β (`alpha`)
- `backtest_run` / `backtest_latest` / `backtest_explain` — F7.5 backtester, CPCV + PBO + DSR firewall (`backtest`)
- `paper_rebalance` / `paper_portfolio` / `paper_history` — equity paper trading (`paper`)
- `pm_alpha_run` / `pm_alpha_latest` — F8.1a Polymarket alpha (`pm_alpha`)
- `pm_paper_rebalance` / `pm_paper_portfolio` / `pm_paper_history` — Polymarket paper trading (`pm_paper`)
- `market_calendar` / `alert_budget_status` — NYSE trading-day check + ritual token budget (`market_ritual`)
- `market_chart_render` / `market_chart_patterns` — SVG charts + pattern detection (`chart`)

### Coding (scope group: `coding`)

- `git_status` / `git_diff` / `git_commit` / `git_push` — git ops
- `gh_repo_create` (pass `cwd`: creates the repo AND wires `origin`) / `gh_create_pr` — GitHub. `git_push` takes `remote` for a repo already on GitHub; `shell_exec` denies `git remote …` (2026-09-01, `337d91f`)
- `file_write` / `file_edit` / `file_delete` — filesystem mutation
- `list_dir` / `glob` / `grep` — navigation + search
- `http_fetch` / `code_search` — raw HTTP + semantic code search
- `shell_exec` — sandboxed shell (denylist). `shell_exec`, `file_write`, `file_edit` and the four `git_*` tools are always-loaded (not `deferred`) since 2026-09-01; `file_delete`, `gh_*`, `code_search` stay deferred
- `jarvis_dev` — sandboxed Jarvis self-modification (`action: branch|test|pr|status`)
- `jarvis_test_run` — run Jarvis's own tests
- `jarvis_diagnose` — diagnose recent mission-control errors
- `vps_deploy` / `vps_backup` / `vps_logs` — VPS management (`vps_backup` copies mc.db to `backups/`)
- `jarvis_propose_directive` / `jarvis_apply_proposal` — propose / apply (after explicit approval) changes to Jarvis's own directives

### Research (scope group: `research`)

- `web_search` / `web_read` / `exa_search` (also core)
- `gemini_upload` / `gemini_research` / `gemini_audio_overview` — Gemini document upload, research with URL + local file support, podcast-style audio overview
- `knowledge_map` / `knowledge_map_expand` — structured domain knowledge maps
- The research group also adds `pdf_read` and `http_fetch`
- `memory_search` / `memory_store` / `memory_reflect` — Hindsight memory; registered and scoped only when the memory backend is `hindsight` (off in production: the memory ToolSource registers only `memory_kg_query` + `memory_forget`)

### Browser automation (scope group: `browser`)

MCP bridges to two browser stacks.

- `browser__goto` / `browser__markdown` (always-on) + `browser__links` / `browser__click` / `browser__fill` / `browser__scroll` / `browser__evaluate` / `browser__interactiveElements` / `browser__semantic_tree` / `browser__structuredData` — LightPanda (lightweight, 10 tools)
- `playwright__browser_*` — Playwright MCP (full-browser; 21 tools lazy-registered, 20 in `BROWSER_TOOLS`: navigate, click, fill_form, snapshot, take_screenshot, press_key, select_option, tabs, wait_for, evaluate, type, close, console_messages, drag, file_upload, handle_dialog, hover, navigate_back, network_requests, resize)

### Scheduling (scope group: `schedule`)

- `schedule_task` — create a one-time or cron scheduled task
- `list_schedules` (always-on) / `delete_schedule` — manage
- Static rituals (`src/rituals/scheduler.ts`, 2026-09-26): morning-briefing, nightly-close, evolution-log, market-morning-scan, market-eod-scan, pm-daily-rebalance, signal-intelligence, skill-evolution, weekly-review, day-narrative, overnight-tuning, autonomous-improvement, kb-backup, stale-artifact-prune, memory-consolidation, diff-digest (and others)

### CRM (scope group: `crm`)

- `crm_query` — bidirectional REST to `agentic-crm` service (port 3000); registered only when `CRM_API_TOKEN` is set

### SEO + GEO (scope group: `seo`)

- `seo_keyword_research`
- `seo_page_audit`
- `seo_content_brief`
- `seo_meta_generate` / `seo_schema_generate` — meta tags + JSON-LD
- `seo_robots_audit` / `seo_llms_txt_generate` — AI-bot robots.txt audit + `/llms.txt`
- `seo_telemetry` — PageSpeed Insights + Search Console
- `ai_overview_track` — Google AI Overview presence for a query

### Ads / Digital Marketing Buyer (scope group: `ads`)

- `ads_audit` — 7 platforms, ~70 checks, A-F grade
- `ads_brand_dna` — brand voice extraction
- `ads_creative_gen` — creative generation with framework library (AIDA, BAB, FAB, ROAS, CPA)

### Video production (scope group: `video`)

- `video_create` / `video_status` / `video_list_profiles` — video generation
- `video_script` / `video_storyboard` — script + scene-by-scene manifest composition
- `video_tts` / `video_list_voices` — text-to-speech
- `video_image` — scene images
- `video_background_download` / `video_transition_preview` / `video_brand_apply` — background footage, transition samples, brand profile
- `video_compose_manifest` / `video_html_compose` — composition DSLs
- `video_job_cancel` / `video_job_cleanup` — job hygiene
- `screenshot_element` — HiDPI element screenshot

### Multimedia / design (scope groups: `specialty` / `diagram`)

- `chart_generate` — chart image URL from data
- `rss_read` — RSS/Atom feed to JSON
- `diagram_generate` — graphviz `dot` or inline LLM svg_html (`diagram`)
- `infographic_generate` — AntV DSL (276 templates)
- `gemini_image` — Gemini image gen
- `hf_generate` / `hf_spaces` — HuggingFace inference
- `batch_decompose` — split a large batch task into sequential chunks
- The specialty group also adds `humanize_text`, `dashboard_generate` / `dashboard_list`, `http_fetch`, `pdf_read`

### Teaching (scope group: `teaching`)

- `learning_plan_create` / `learning_plan_advance` / `learning_plan_quiz` / `learning_plan_explain_back` / `learning_plan_summarize` / `learning_plan_status` — v7.11 learning plans
- `learner_model_status` — learner-model report (due / mastered / shaky concepts)

### Skills (scope group: `skills`)

- `skill_describe` / `skill_load` / `skill_run` — S5 skill dispatch (metadata, full body, invoke); `skill_save` / `skill_list` are core

### Messaging / delivery

- Telegram bot (grammy-based, not a tool — runtime messaging channel)
- WhatsApp (Baileys-based, ditto)

### Knowledge / graph

- `memory_kg_query` — knowledge-graph query (memory ToolSource; registered without Hindsight since `01f8d7a`)
- `kb_ingest_pdf_structured` / `kb_batch_insert` — structured PDF ingestion + batch insert into the pgvector KB (scope group: `kb_ingest`)
- `graphify-code__*` — code knowledge graph (7 tools via external Python MCP; scope group: `graph`)
- `xpoz__*` — xpoz-pipeline MCP (5 tools: trigger_run, get_topics, get_digest, get_history, get_job_status; scope group: `xpoz`)

### Admin / self-management

- `jarvis_propose_directive` / `jarvis_apply_proposal` — Jarvis can propose changes to its own directives (applied only after operator approval)
- `jarvis_file_search` / `jarvis_file_update` / `jarvis_file_write` / `jarvis_file_delete` — jarvis_files CRUD
- `project_list` / `project_get` / `project_update` — project registry
- `task_history` — Jarvis queries its own task log
- `submit_report` — validate + audit a draft operator-facing report before delivery (not deferred; unscoped, reached by the runner)
- `evolution_get_data` / `evolution_deactivate_skill` — skill-evolution ritual data + deactivation (unscoped, ritual-only)

### Utilities (scope group: `utility`)

- `weather_forecast` / `currency_convert` / `geocode_address` — weather, ECB FX rates, geocoding
- `file_convert` — format bridge (ebooks, office, images, doc↔doc via pandoc, video frames via ffmpeg)
- `email_verify` — SMTP mailbox verification without sending (syntax → MX → RCPT TO probe; daily cap + circuit breaker; `docs/EMAIL-VERIFY.md`, 2026-09-11)
- `http_fetch` / `pdf_read` — generic HTTP + local PDF extraction (via the `coding` / `research` / `specialty` groups)
- `hf_generate` / `hf_spaces` — HuggingFace (via `specialty`)
- `vps_status` (always-on) / `vps_logs` / `vps_deploy` — VPS management (via `coding`)

### Social (scope group: `social`)

- `tweet_post` / `tweet_probe` / `tweet_mentions` — X posting, auth health-check, mentions (`src/tools/builtin/x-post.ts`; see `docs/X-POSTING.md`)

### Writing

- `humanize_text` — detect and remove AI writing patterns (`src/tools/builtin/writing.ts`; added by the `specialty` and `wordpress` groups — there is no `writing` scope group)

---

## External services

Not Jarvis "tools" per se — supporting services that Jarvis talks to.

| Service                     | Where                                     | Port             | Purpose                                  | Stability                                                                     |
| --------------------------- | ----------------------------------------- | ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| mission-control             | systemd, compiled JS                      | 8080             | Jarvis agent orchestrator (this service) | Primary                                                                       |
| agentic-crm                 | systemd, tsx                              | 3000             | CRM engine (Pulso)                       | External repo                                                                 |
| Hindsight                   | Docker (`crm-hindsight`)                  | 8888, 9999       | Long-term memory                         | Off for mission-control (memory backend not `hindsight`); used by agentic-crm |
| Prometheus (metrics)        | Docker (`mc-prometheus`)                  | 9090             | Metrics scrape target                    | Observability                                                                 |
| Supabase                    | Docker stack                              | 5433, 8100, 3100 | Postgres + API + Studio                  | Shared platform                                                               |
| Caddy                       | system binary                             | 80, 443          | Reverse proxy + TLS                      | Edge                                                                          |
| LightPanda                  | binary (`./bin/lightpanda`)               | MCP stdio        | Lightweight browser                      | MCP server                                                                    |
| Playwright MCP              | npx                                       | MCP stdio        | Full-browser automation                  | MCP server                                                                    |
| xpoz-pipeline MCP           | node (`xpoz-pipeline/dist/mcp-server.js`) | MCP stdio        | xpoz topics/digests (5 tools)            | MCP server                                                                    |
| graphify-code               | Python venv + MCP                         | MCP stdio        | Code knowledge graph                     | Env-gated                                                                     |
| Claude Agent SDK            | npm `@anthropic-ai/claude-agent-sdk`      | (direct)         | Primary inference                        | Primary provider                                                              |
| OpenAI-compatible providers | HTTPS                                     | (direct)         | Fallback inference (qwen, kimi)          | Secondary                                                                     |

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
- **xpoz-intelligence-pipeline-manager MCP bridge** — SHIPPED: `xpoz` MCP server live (5 `xpoz__*` tools, scope group `xpoz`; boot log 2026-09-26)

---

## How to find a tool

1. **Know the name?** `grep -n "name: \"<name>\"" src/tools/builtin/*.ts`
2. **Know the category?** Find it in this doc by scope group, then read the corresponding `src/tools/builtin/<category>.ts`
3. **Not sure?** Check `src/tools/sources/builtin.ts:BUILTIN_TOOLS` — the canonical registration array
4. **Need to add a new one?** `CLAUDE.md` → "Adding a new tool" pattern (declare the name once via `defineTool()`, `src/tools/define-tool.ts`; the freeze ended 2026-05-22)

---

## Scope groups (the deferral control surface)

From `src/messaging/scope.ts:DEFAULT_SCOPE_PATTERNS` (35 groups, 2026-09-26):

`ads`, `alpha`, `backtest`, `browser`, `chart`, `coding`, `crm`, `destructive`, `diagram`, `finance`, `google`, `graph`, `intel`, `jarvis_write`, `kb_ingest`, `market_ritual`, `meta`, `northstar_journal`, `northstar_read`, `northstar_write`, `paper`, `pm_alpha`, `pm_paper`, `projects`, `research`, `schedule`, `seo`, `skills`, `social`, `specialty`, `teaching`, `utility`, `video`, `wordpress`, `xpoz`

Each has a regex triggering on user message; matching groups load their associated tools into the prompt (the `*_TOOLS` arrays in the same file). ~52% token savings vs loading all 234 tools every turn.

The semantic classifier (`v6.4 CL1.1` — `src/messaging/scope-classifier.ts`; Jev runs first when enabled, operator ruling 2026-09-21) is the primary matcher; the regex patterns are fallback for classifier timeouts. NFC normalization is enforced at both entry points (Dim-5 C-SCP-1 fix).
