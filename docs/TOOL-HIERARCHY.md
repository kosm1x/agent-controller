# Tool Hierarchy — Jarvis Agent Controller

> How 172 tools are organized, scoped, and delivered to the LLM without blowing up the prompt.

## The Problem

172 tools × ~200 tokens each = ~34K tokens of tool schemas. With a 128K context window and ~20K tokens of system prompt + conversation history, sending all tool schemas would consume 50%+ of the budget on every message — most of it irrelevant.

## The Solution: 4-Layer Hierarchy

```
172 total tools
├── Layer 1: ALWAYS ON (25 tools) — full schema every message
├── Layer 2: SCOPE-GATED (~80 tools) — activated by topic detection
├── Layer 3: DEFERRED (82 tools) — name+description only, schema on demand
└── Layer 4: CONDITIONAL (~30 tools) — env-var gated at startup
```

Typical message sees ~27 tools. Of those, ~9 have full schemas, ~18 are deferred (name only). Prompt stays under 22K tokens.

---

## Layer 1: Always Active (CORE + MISC)

**25 tools, full schema, every message.** These are the capabilities Jarvis needs regardless of topic.

### CORE_TOOLS (13)

| Tool               | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `user_fact_set`    | Store user facts/preferences                |
| `user_fact_list`   | List known facts about user                 |
| `user_fact_delete` | Remove a user fact                          |
| `web_search`       | Brave Search API                            |
| `web_read`         | Jina Reader (+ stealth browser CF fallback) |
| `exa_search`       | Exa neural search                           |
| `skill_save`       | Save a learned skill                        |
| `skill_list`       | List available skills                       |
| `file_read`        | Read files (.txt, .docx, attachments)       |
| `list_dir`         | Browse filesystem                           |
| `task_history`     | Query own past executions                   |
| `jarvis_file_read` | Read from Jarvis knowledge base             |
| `jarvis_file_list` | List knowledge base files                   |

### MISC_TOOLS (12)

| Tool                 | Purpose                       | Notes                    |
| -------------------- | ----------------------------- | ------------------------ |
| `jarvis_file_write`  | Write to knowledge base       | Core write capability    |
| `jarvis_file_update` | Append/update KB files        |                          |
| `jarvis_file_delete` | Delete KB files               | Deferred schema          |
| `jarvis_file_move`   | Move/rename KB files          | Deferred schema          |
| `jarvis_file_search` | Search KB content             | Deferred schema          |
| `list_schedules`     | View active schedules         | Read-only                |
| `project_list`       | List tracked projects         | Read-only                |
| `video_status`       | Check video job status        | Always-on for follow-ups |
| `vps_status`         | Server health check           | Always-on                |
| `northstar_sync`     | Sync with COMMIT db           | Always-on                |
| `browser__goto`      | Lightpanda navigation         | Fast, no JS rendering    |
| `browser__markdown`  | Lightpanda content extraction |                          |

---

## Layer 2: Scope-Gated Groups

**~80 tools activated by topic detection.** Three classifiers run in priority order:

### Classification Priority

1. **Semantic classifier** (LLM-based, 3s timeout) — understands intent ("abre mi northstar" → northstar scope)
2. **URL injection** (mechanical) — `docs.google.com/*`, `drive.google.com`, `mail.google.com`, `calendar.google.com` → google scope
3. **Regex fallback** (mechanical) — keyword patterns when semantic classifier times out

### Scope Groups

| Group               | Trigger Keywords                                                            | Tools                                                                                  | Count |
| ------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----- |
| `google`            | correo, gmail, calendar, drive, slides, presentación, Google Workspace URLs | Gmail (3), Drive (6), Calendar (3), Sheets (2), Docs (3), Slides (2), Tasks (1)        | 20    |
| `coding`            | código, archivo, git, deploy, shell                                         | Shell, file ops, git (6), jarvis dev/diagnose/test, VPS deploy/backup/logs, directives | 22    |
| `browser`           | navega, browse, click, login, SPA, playwright                               | Lightpanda extras (8) + Playwright Chromium (8)                                        | 16    |
| `wordpress`         | blog, wordpress, publica en sitio                                           | WP CRUD, media, plugins, settings, raw API                                             | 10    |
| `video`             | video, clip, render, TikTok                                                 | Create, script, TTS, image, profiles, voices, background, screenshot                   | 9     |
| `research`          | analiza, investiga, estudio                                                 | Gemini upload/research/audio, knowledge maps                                           | 5     |
| `specialty`         | gráfica, RSS, genera imagen                                                 | Chart, RSS, Gemini image, HuggingFace, batch                                           | 6     |
| `intel`             | señales, mercado, alertas, depot                                            | Query, status, alert history, baseline                                                 | 4     |
| `social`            | redes, Instagram, publica en redes                                          | Publish, accounts, status                                                              | 3     |
| `schedule`          | programa, reportes, cron, cada hora                                         | Schedule task, delete schedule                                                         | 2     |
| `utility`           | clima, weather, moneda, currency, tipo de cambio, geocode                   | weather_forecast, currency_convert, geocode_address                                    | 3     |
| `crm`               | CRM, Azteca (explicit only)                                                 | crm_query                                                                              | 1     |
| `northstar_read`    | metas, visión, objetivo, north star                                         | jarvis_file_read (already in CORE), jarvis_init                                        | 2     |
| `northstar_write`   | actualiza visión, nueva meta                                                | jarvis_file_write (already in MISC)                                                    | 1     |
| `destructive`       | elimina, borra, delete                                                      | _(intent-only — destructive tools live in domain groups)_                              | 0     |
| `northstar_journal` | escribe diario, journal entry                                               | _(intent-only — jarvis_file_write in MISC handles writes)_                             | 0     |
| `meta`              | herramientas disponibles, diagnóstico                                       | **ALL groups activate** — full inventory                                               | all   |

### Scope Behavior Rules

- **Current message has scope signals** → activate matching groups + scan prior turns for context
- **Short follow-up (<80 chars) with no signals** → inherit scope from previous message
- **Imperative verbs** (ejecuta, procede, hazlo) → inherit previous scope
- **No signals, not a follow-up** → CORE + MISC only (minimal footprint)

---

## Layer 3: Deferred Tools

**82 of 172 tools are deferred.** The LLM sees name + description but NOT the parameter schema. This saves ~16K tokens per message.

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
**Savings:** 82 × ~200 tokens = ~16,400 tokens saved per message.

### Deferral Exceptions

| Exception       | Behavior                                                              |
| --------------- | --------------------------------------------------------------------- |
| `gmail_send`    | `deferred: false` — delivery-critical, can't afford round-trip delay  |
| ≤6 total tools  | Deferral skipped entirely — scheduled tasks, rituals get full schemas |
| Trigger phrases | Tools with `triggerPhrases` array get priority expansion              |

### Non-Deferred Tools (full schema always sent when in scope)

Only tools WITHOUT `deferred: true` send full schemas:

- All CORE_TOOLS (13)
- `gmail_send` (explicitly `deferred: false`)
- `memory_search`, `memory_store`, `memory_reflect` (3)
- Tools without the `deferred` property default to non-deferred

---

## Layer 4: Conditional Registration

Tools only registered at startup if their service is configured:

| Env Var                                     | Tools Registered                                |
| ------------------------------------------- | ----------------------------------------------- |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | 20 Google Workspace tools                       |
| `WP_SITES`                                  | 10 WordPress tools                              |
| `CRM_API_TOKEN`                             | 1 CRM tool                                      |
| `SOCIAL_PUBLISH_ENABLED=true`               | 3 social tools                                  |
| Lightpanda MCP server running               | 10 browser tools                                |
| Playwright MCP server running               | 21 Playwright tools (lazy connect on first use) |

---

## Token Budget Impact

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

| File                                | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `src/messaging/scope.ts`            | Tool groups, scope patterns, scoping function  |
| `src/messaging/scope-classifier.ts` | LLM-based semantic scope classifier            |
| `src/runners/fast-runner.ts`        | Deferral logic, KB injection, tool resolution  |
| `src/tools/registry.ts`             | Tool registration, deferred catalog generation |
| `src/tools/sources/*.ts`            | ToolSource plugins (Google, MCP, builtin)      |
| `src/inference/adapter.ts`          | Deferred expansion on first call               |

---

## Design Principles

1. **Default to minimal** — CORE + MISC only. Add tools when evidence (keywords, URLs, prior context) supports it
2. **Defer aggressively** — Name+description is usually enough for the LLM to decide IF it needs a tool. Full schema only when it commits to calling one
3. **Mechanical over LLM** — URL injection and regex don't cost inference. Semantic classifier is a 3s LLM call — use it for ambiguous cases, not obvious ones
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

| Tool                         | Purpose                           | Reached Via              |
| ---------------------------- | --------------------------------- | ------------------------ |
| `evolution_get_data`         | Nightly skill evolution data      | Evolution ritual (cron)  |
| `evolution_deactivate_skill` | Deactivate underperforming skills | Evolution ritual (cron)  |
| `jarvis_init`                | One-time bootstrap                | Startup / manual trigger |
