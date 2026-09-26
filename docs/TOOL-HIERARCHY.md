# Tool Hierarchy — Jarvis Agent Controller

> How 234 tools are organized, scoped, and delivered to the LLM without blowing up the prompt.
> Counts re-verified 2026-09-26 against `src/messaging/scope.ts` (`*_TOOLS` arrays), the static tool exports (194) and the live boot log (registry 234 = builtin 162 + MCP 43 + Google 22 + memory 2 + skills 5).

## The Problem

234 tools × ~200 tokens each = ~47K tokens of tool schemas. With a 128K context window and ~20K tokens of system prompt + conversation history, sending all tool schemas would consume 50%+ of the budget on every message — most of it irrelevant.

## The Solution: 4-Layer Hierarchy

```
234 registered tools (live, 2026-09-26)
├── Layer 1: ALWAYS ON (31 tools: CORE 15 + MISC 16) — every message
├── Layer 2: SCOPE-GATED (193 names across the *_TOOLS arrays) — activated by topic detection
├── Layer 3: DEFERRED (143 of 194 static tools) — name+description only, schema on demand
└── Layer 4: CONDITIONAL (Google 22, gws 1, WordPress 10, CRM 1, Hindsight memory 3, MCP 43) — env/service gated at startup
```

A message with no topic signal sees the 31 always-on tools: 29 static (20 full schema, 9 deferred — name only) + 2 LightPanda MCP tools (`browser__goto`, `browser__markdown`). Prompt-token figures are in the 2026-04-10 snapshot table below.

---

## Layer 1: Always Active (CORE + MISC)

**31 tools, every message** (the deferred ones among them send name+description only). These are the capabilities Jarvis needs regardless of topic.

### CORE_TOOLS (15)

| Tool               | Purpose                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `user_fact_set`    | Store user facts/preferences                                                          |
| `user_fact_list`   | List known facts about user                                                           |
| `user_fact_delete` | Remove a user fact                                                                    |
| `memory_forget`    | Invalidate KG facts / delete a correction entry (deferred, confirm-gated, 2026-09-12) |
| `web_search`       | Brave Search API                                                                      |
| `web_read`         | Jina Reader (+ stealth browser CF fallback)                                           |
| `exa_search`       | Exa neural search                                                                     |
| `skill_save`       | Save a learned skill                                                                  |
| `skill_list`       | List available skills                                                                 |
| `file_read`        | Read files (.txt, .docx, attachments)                                                 |
| `data_summarize`   | Deterministic row counts + column stats over tabular data                             |
| `list_dir`         | Browse filesystem                                                                     |
| `task_history`     | Query own past executions                                                             |
| `jarvis_file_read` | Read from Jarvis knowledge base                                                       |
| `jarvis_file_list` | List knowledge base files                                                             |

### MISC_TOOLS (16)

| Tool                             | Purpose                             | Notes                      |
| -------------------------------- | ----------------------------------- | -------------------------- |
| `jarvis_file_write`              | Write to knowledge base             | Core write capability      |
| `jarvis_file_update`             | Append/update KB files              |                            |
| `jarvis_file_delete`             | Delete KB files                     | Deferred schema            |
| `jarvis_file_move`               | Move/rename KB files                | Deferred schema            |
| `jarvis_file_search`             | Search KB content                   | Full schema (not deferred) |
| `jarvis_files_batch_write`       | Write several KB files in one call  | Deferred schema            |
| `jarvis_files_batch_delete`      | Delete several KB files in one call | Deferred schema            |
| `list_schedules`                 | View active schedules               | Read-only                  |
| `project_list`                   | List tracked projects               | Read-only                  |
| `project_get` / `project_update` | Read / update a project             | Moved to MISC 2026-05-15   |
| `video_status`                   | Check video job status              | Always-on for follow-ups   |
| `vps_status`                     | Server health check                 | Always-on                  |
| `northstar_sync`                 | Sync with COMMIT db                 | Always-on                  |
| `browser__goto`                  | Lightpanda navigation               | Fast, no JS rendering      |
| `browser__markdown`              | Lightpanda content extraction       |                            |

---

## Layer 2: Scope-Gated Groups

**193 tool names (incl. MCP) activated by topic detection.** Three classifiers run in priority order:

### Classification Priority

1. **Semantic classifier** (LLM-based, `SCOPE_CLASSIFIER_TIMEOUT_MS`, default 8 s; Jev runs first when enabled, operator ruling 2026-09-21) — understands intent ("abre mi northstar" → northstar scope)
2. **URL injection** (mechanical) — `docs.google.com/*`, `drive.google.com`, `mail.google.com`, `calendar.google.com` → google scope
3. **Regex fallback** (mechanical) — keyword patterns when semantic classifier times out

### Scope Groups

| Group                          | Trigger Keywords                                                            | Tools                                                                                                                                                          | Count |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `google`                       | correo, gmail, calendar, drive, slides, presentación, Google Workspace URLs | Gmail (3), Drive (7), Calendar (3), Sheets (2), Docs (4), Slides (2), Tasks (1), `google_workspace_cli` (+ `pdf_read`, `gemini_upload`, `gemini_research`)     | 23    |
| `coding`                       | código, archivo, git, deploy, shell                                         | Shell, http_fetch, file ops, git (4), gh (2), jarvis dev/diagnose/test, code_search, VPS deploy/backup/logs, directives propose/apply                          | 23    |
| `browser`                      | navega, browse, click, login, SPA, playwright                               | Lightpanda extras (8) + Playwright Chromium (20)                                                                                                               | 28    |
| `wordpress`                    | blog, wordpress, publica en sitio                                           | WP CRUD, media, plugins, settings, raw API (+ `humanize_text`)                                                                                                 | 10    |
| `video`                        | video, clip, render, TikTok                                                 | Create, status, script, storyboard, TTS, voices, image, profiles, background, transition preview, compose manifest/HTML, brand, job cancel/cleanup, screenshot | 16    |
| `research`                     | analiza, investiga, estudio                                                 | Gemini upload/research/audio, knowledge maps (+ `pdf_read`, `http_fetch`)                                                                                      | 5     |
| `specialty`                    | gráfica, RSS, genera imagen                                                 | Chart, RSS, Gemini image, HuggingFace (2), batch, infographic (+ humanize, dashboards, http_fetch, pdf_read)                                                   | 7     |
| `intel`                        | señales, mercado, alertas, depot                                            | Query, status, alert history, baseline                                                                                                                         | 4     |
| `finance`                      | cotiza, precio, watchlist, régimen macro                                    | Quote, history, indicators, watchlist (4), scan, signals, macro regime, budget, prediction markets, whales, sentiment                                          | 14    |
| `alpha` / `backtest` / `paper` | alpha, backtest, paper trading                                              | `alpha_*` (3) / `backtest_*` (3) / `paper_*` (3)                                                                                                               | 9     |
| `pm_alpha` / `pm_paper`        | Polymarket alpha / paper                                                    | `pm_alpha_*` (2) / `pm_paper_*` (3)                                                                                                                            | 5     |
| `market_ritual`                | market rituals                                                              | market_calendar, alert_budget_status                                                                                                                           | 2     |
| `chart`                        | chart patterns                                                              | market_chart_render, market_chart_patterns                                                                                                                     | 2     |
| `diagram`                      | diagrama                                                                    | diagram_generate                                                                                                                                               | 1     |
| `seo`                          | SEO, meta tags, schema, robots, llms.txt, AI Overview                       | page audit, keyword research, meta, schema, content brief, robots, llms.txt, telemetry, ai_overview_track                                                      | 9     |
| `ads`                          | anuncios, ads, campaña                                                      | ads_audit, ads_brand_dna, ads_creative_gen                                                                                                                     | 3     |
| `teaching`                     | aprender, lección, quiz                                                     | learning_plan_* (6), learner_model_status                                                                                                                      | 7     |
| `skills`                       | skill                                                                       | skill_describe, skill_load, skill_run                                                                                                                          | 3     |
| `kb_ingest`                    | ingest PDF into KB                                                          | kb_ingest_pdf_structured, kb_batch_insert                                                                                                                      | 2     |
| `graph`                        | code graph                                                                  | graphify-code MCP (7)                                                                                                                                          | 7     |
| `xpoz`                         | xpoz                                                                        | xpoz MCP (5)                                                                                                                                                   | 5     |
| `social`                       | redes, X/Twitter, publica, tweet, menciones                                 | X/Twitter post, probe, mentions (SOCIAL_PUBLISH stub removed 2026-07-05)                                                                                       | 3     |
| `schedule`                     | programa, reportes, cron, cada hora                                         | Schedule task, delete schedule                                                                                                                                 | 2     |
| `utility`                      | clima, weather, moneda, currency, tipo de cambio, geocode                   | weather_forecast, currency_convert, geocode_address, email_verify, file_convert                                                                                | 5     |
| `crm`                          | CRM, Azteca (explicit only)                                                 | crm_query                                                                                                                                                      | 1     |
| `northstar_read`               | metas, visión, objetivo, north star                                         | northstar_sync (already in MISC); KB reads via jarvis_file_read (CORE)                                                                                         | 1     |
| `northstar_write`              | actualiza visión, nueva meta                                                | northstar_sync (already in MISC); writes via jarvis_file_write (MISC)                                                                                          | 1     |
| `projects`                     | proyecto                                                                    | _(none since 2026-05-15 — project_get/update moved to MISC)_                                                                                                   | 0     |
| `destructive`                  | elimina, borra, delete                                                      | _(intent-only — destructive tools live in domain groups)_                                                                                                      | 0     |
| `northstar_journal`            | escribe diario, journal entry                                               | _(intent-only — jarvis_file_write in MISC handles writes)_                                                                                                     | 0     |
| `jarvis_write`                 | escribe en KB                                                               | _(intent-only since 2026-05-07 — JARVIS_WRITE_TOOLS promoted to MISC)_                                                                                         | 0     |
| `meta`                         | herramientas disponibles, diagnóstico                                       | **ALL groups activate** — full inventory                                                                                                                       | all   |

Trigger keywords for the rows added 2026-09-26 are paraphrases; the authoritative regexes are `DEFAULT_SCOPE_PATTERNS` in `src/messaging/scope.ts`.

### Scope Behavior Rules

- **Current message has scope signals** → activate matching groups + scan prior turns for context
- **Short follow-up (<80 chars) with no signals** → inherit scope from previous message
- **Imperative verbs** (ejecuta, procede, hazlo) → inherit previous scope
- **No signals, not a follow-up** → CORE + MISC only (minimal footprint)

---

## Layer 3: Deferred Tools

**143 of the 194 static tools are deferred** (2026-09-26; MCP tools not counted). The LLM sees name + description but NOT the parameter schema. This saves up to ~28,600 tokens per message (143 × ~200) when every group is in scope; a scoped message saves proportionally less.

### How Deferral Works

```
Round 1: LLM sees "gmail_read — Read a full email message"
         LLM calls: gmail_read({})  ← no schema, guesses empty args

Round 2: System injects full schema as a message:
         "gmail_read requires: message_id (string, required),
          download_attachments (boolean, optional)"
         LLM retries: gmail_read({message_id: "abc123"})  ← correct

Round 3: Tool executes normally
```

**Cost:** 1 extra inference round on first use per conversation.
**Savings:** up to 143 × ~200 tokens = ~28,600 tokens per message when every group is in scope.

### Deferral Exceptions

| Exception       | Behavior                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail_send`    | `deferred: false` — delivery-critical, can't afford round-trip delay                                                                                                                                                                         |
| ≤6 total tools  | Deferral skipped entirely — scheduled tasks, rituals get full schemas. **OpenAI-compat path only**: under `TOOL_SEARCH_ENABLED` (live since 2026-07-13) the claude-sdk path applies `alwaysLoad: !deferred` per tool with no count exemption |
| Coding core     | `shell_exec`, `file_write`, `file_edit`, `git_status/diff/commit/push` — `deferred: false` since 2026-09-01 (one ToolSearch miss read as absence, tasks 8958/8961–8963); pinned by `core-coding-always-loaded.test.ts`                       |
| Trigger phrases | Tools with `triggerPhrases` array get priority expansion                                                                                                                                                                                     |

### Non-Deferred Tools (full schema always sent when in scope)

Only tools WITHOUT `deferred: true` send full schemas:

- CORE_TOOLS except `memory_forget` (14)
- `gmail_send` (explicitly `deferred: false`)
- `memory_search`, `memory_store`, `memory_reflect` (3; registered only with the Hindsight backend)
- Also non-deferred: `data_summarize`, `submit_report`, `market_quote`, `market_calendar`, `crm_query`, all 10 `wp_*`, `gdrive_list`, `gdocs_read_full`, `gsheets_read`, the coding core, and most MISC tools
- Tools without the `deferred` property default to non-deferred

---

## Layer 4: Conditional Registration

Tools only registered at startup if their service is configured:

| Env Var                                                              | Tools Registered                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` + `GOOGLE_REFRESH_TOKEN`                          | 22 Google Workspace tools (Google ToolSource)                                                                        |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` | `google_workspace_cli` (1)                                                                                           |
| `WP_SITES`                                                           | 10 WordPress tools                                                                                                   |
| `CRM_API_TOKEN`                                                      | 1 CRM tool                                                                                                           |
| Memory backend = `hindsight`                                         | `memory_search` / `memory_store` / `memory_reflect` (3); otherwise only `memory_kg_query` + `memory_forget` register |
| Lightpanda MCP server running                                        | 10 browser tools                                                                                                     |
| Playwright MCP server running                                        | 21 Playwright tools (lazy connect on first use)                                                                      |
| graphify-code MCP server running                                     | 7 `graphify-code__*` tools                                                                                           |
| xpoz MCP server running                                              | 5 `xpoz__*` tools                                                                                                    |

---

## Token Budget Impact

> Snapshot from 2026-04-10 (172-tool registry; not re-derived for the 2026-09-26 counts — the no-topic baseline is now 31 always-on tools).

| Scenario                  | Tools in Scope | Deferred | Full Schema | Prompt Tokens |
| ------------------------- | -------------- | -------- | ----------- | ------------- |
| Simple chat (no topic)    | 28             | 18       | 10          | ~12-16K       |
| Weather/currency query    | 31             | 21       | 10          | ~13-17K       |
| Google + chat             | 48             | 38       | 10          | ~19-23K       |
| Coding task               | 50             | 33       | 17          | ~21-26K       |
| Full browser + coding     | 66             | 48       | 18          | ~23-29K       |
| Meta query (all groups)   | 110            | 76       | 34          | ~30-37K       |
| Scheduled task (≤6 tools) | 4-6            | 0        | 4-6         | ~8-12K        |

Against TOKEN_BUDGET_FAST=28,000 and INFERENCE_CONTEXT_LIMIT=128,000.

---

## Key Files

| File                                | Purpose                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| `src/messaging/scope.ts`            | Tool groups, scope patterns, scoping function             |
| `src/messaging/scope-classifier.ts` | LLM-based semantic scope classifier                       |
| `src/runners/fast-runner.ts`        | Deferral logic, KB injection, tool resolution             |
| `src/tools/registry.ts`             | Tool registration, deferred catalog generation            |
| `src/tools/sources/*.ts`            | ToolSource plugins (builtin, MCP, Google, memory, skills) |
| `src/inference/adapter.ts`          | Deferred expansion on first call                          |

---

## Design Principles

1. **Default to minimal** — CORE + MISC only. Add tools when evidence (keywords, URLs, prior context) supports it
2. **Defer aggressively** — Name+description is usually enough for the LLM to decide IF it needs a tool. Full schema only when it commits to calling one
3. **Mechanical over LLM** — URL injection and regex don't cost inference. Semantic classifier is an LLM call (8 s default timeout) — use it for ambiguous cases, not obvious ones
4. **Never block delivery** — `gmail_send` is non-deferred because a round-trip delay on email delivery is unacceptable
5. **Scope doesn't restrict** — If the LLM asks for a tool not in scope, the deferred catalog shows it exists. Scope is about token budget, not access control
6. **API over browser** — Google Workspace URLs must route to authenticated API tools (gdocs_read, gsheets_read, gslides_read), never to browser**goto which hits auth walls. All Google read tools carry "DO NOT USE browser**goto" warnings

---

## Known Anti-Patterns

| Anti-Pattern                       | What Happens                                            | Defense                                                                                                     |
| ---------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Browser for private URLs**       | LLM uses browser\_\_goto on docs.google.com → auth wall | URL scope injection + "DO NOT USE browser" in tool descriptions                                             |
| **Missing chain ID**               | Tool A returns data without the ID that Tool B needs    | All search/list tools verified to output IDs (gmail_search includes `ID:`, gdrive_list includes `id`, etc.) |
| **Orphaned tools**                 | Tool registered but in no scope group → invisible       | Exhaustive audit: every tool mapped to a group or documented as intentionally unscopped                     |
| **Semantic classifier blind spot** | LLM classifier returns "browser" for Google URLs        | URL injection overrides semantic classifier for known Google domains                                        |
| **Intent-only groups**             | Scope group detected but adds zero tools                | `destructive` and `northstar_journal` documented as intent-detection-only                                   |

---

## Internal Tools (intentionally unscopped)

These tools are registered but deliberately excluded from scope groups. They are reached via scheduled tasks, rituals, or internal code paths that bypass the scoping system:

| Tool                                                                   | Purpose                           | Reached Via                                                        |
| ---------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `evolution_get_data`                                                   | Nightly skill evolution data      | Evolution ritual (cron)                                            |
| `evolution_deactivate_skill`                                           | Deactivate underperforming skills | Evolution ritual (cron)                                            |
| `submit_report`                                                        | Audit a draft operator report     | Runner / report path                                               |
| `dashboard_generate` / `dashboard_list` / `humanize_text` / `pdf_read` | Niche helpers                     | Pushed inline by `specialty` / `research` / `google` / `wordpress` |
