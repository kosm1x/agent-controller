# v6 Roadmap — Self-Improving Jarvis

> Last updated: 2026-04-07 — **v6.0-v6.4 ALL DONE. 1648 tests, 170 tools, 47 sessions. Next: D3+D4 (OAuth for TikTok/YouTube), then G1.5 (query expansion).**

## Status Key

- **Done** — Implemented, tested, shipped
- **Blocked** — Dependencies unresolved
- **Planned** — Scoped and sequenced

---

## Execution Tiers

| Tier               | Sessions                  | Priority              | Rationale                                                  |
| ------------------ | ------------------------- | --------------------- | ---------------------------------------------------------- |
| 0 — Self-Improving | v6.0 S1–S8                | Ship first            | Jarvis codes, tests, deploys, improves himself             |
| 1 — Safeguards     | SG1–SG5                   | Before activation     | Mechanical safety before autonomous improvement goes live  |
| 2 — Background     | v6.1 agents + checkpoints | User-visible value    | Parallel execution lanes the user controls                 |
| 3 — Coherence      | 10 OpenClaude patterns    | Behavioral foundation | Prevents drift, improves long-session reliability          |
| 4 — Foundation     | v6.2 (14 sessions)        | Reliability           | Never go silent, remember everything, produce video        |
| 5 — Distribution   | v6.3 (8 sessions)         | Content pipeline      | Source to published post, writing quality, dashboards      |
| 6 — Optimization   | v6.3.1                    | Performance           | 52% prompt token reduction, fast-path hardening            |
| 6.5 — Resilience   | v6.3.2                    | Report delivery       | Deferral bypass for small tool sets, degradation isolation |
| 7 — Intelligence   | v6.4 (8 sessions)         | Reliability + smarts  | OH2 first, then CIRICD, memory maturation, autoresearch    |

---

## v6.0 S1 — Branch + PR Workflow — **Done**

| Item                                                    | Source       | Status   |
| ------------------------------------------------------- | ------------ | -------- |
| Unlock mission-control for branch operations (not main) | Architecture | **Done** |
| Branch naming: `jarvis/{type}/{slug}`                   | —            | **Done** |
| NanoClaw sandbox for code + tests                       | —            | **Done** |
| Auto-labeled PRs (`jarvis-authored`)                    | —            | **Done** |

---

## v6.0 S2 — Self-Repair — **Done**

| Item                                                                                    | Source | Status   |
| --------------------------------------------------------------------------------------- | ------ | -------- |
| Diagnosis tools: `jarvis_diagnose`, `jarvis_test_run`                                   | —      | **Done** |
| Repair workflow: identify → branch → fix → test → PR                                    | —      | **Done** |
| Scope limit: `src/tools/`, `src/intel/`, `src/messaging/scope.ts`, `prompt-sections.ts` | —      | **Done** |

---

## v6.0 S3 — Directive Evolution — **Done**

| Item                                                                        | Source | Status   |
| --------------------------------------------------------------------------- | ------ | -------- |
| `jarvis_propose_directive` — writes to `knowledge/proposals/`, notifies     | —      | **Done** |
| User approves in Telegram → Jarvis applies → changelog in `logs/decisions/` | —      | **Done** |
| Rate limit: can only propose, never apply without approval                  | —      | **Done** |

---

## v6.0 S4 — VPS Management — **Done**

| Item                                                                | Source | Status   |
| ------------------------------------------------------------------- | ------ | -------- |
| `vps_status` — CPU, memory, disk, Docker, services, error count     | —      | **Done** |
| `vps_deploy` — build + restart (gates on test suite + health check) | —      | **Done** |
| `vps_backup` — mc.db backup with 7-day rotation                     | —      | **Done** |
| `vps_logs` — filtered journalctl                                    | —      | **Done** |

---

## v6.0 S5 — Autonomous Improvement Loop — **Done**

| Item                                                                    | Source | Status   |
| ----------------------------------------------------------------------- | ------ | -------- |
| Overnight tuning or user report triggers improvement                    | —      | **Done** |
| Plan → branch → code → tests → PR → user merge → deploy                 | —      | **Done** |
| Post-deploy monitoring: error logs every 15 min for 1 hour, auto-revert | —      | **Done** |
| Safety: max 3 PRs/day, $5/cycle, scope-limited, revertable, kill switch | —      | **Done** |

---

## v6.0 S6–S8 — Tool Results, Code Search, Pattern Memory — **Done**

| Session | What                                                                       | Status   |
| ------- | -------------------------------------------------------------------------- | -------- |
| S6      | Structured tool result pipelines — pre-formatted data bypasses LLM         | **Done** |
| S7      | Semantic code search — `code_search` tool, tree-sitter index, SQLite store | **Done** |
| S8      | Execution pattern memory — auto-extract lessons, inject on similar tasks   | **Done** |

---

## Autonomous Improvement Safeguards (SG1–SG5) — **Done**

Built before enabling `AUTONOMOUS_IMPROVEMENT_ENABLED=true`. Five mechanical safeguards:

| ID  | Safeguard          | What                                                            | Where                                    |
| --- | ------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| SG1 | Weekly Diff Digest | Sunday 8 PM Telegram: all Jarvis-authored changes, 7-day window | `src/rituals/diff-digest.ts`             |
| SG2 | HTTP Kill Switch   | POST /api/admin/kill-autonomous — disables loop + cancels tasks | `src/api/routes/admin.ts`                |
| SG3 | Immutable Core     | 15 files + src/api/ blocked in all write paths                  | `src/tools/builtin/immutable-core.ts`    |
| SG4 | Directive Cooldown | Max 1 proposal per 48h (DIRECTIVE_COOLDOWN_HOURS env)           | `src/tools/builtin/jarvis-directives.ts` |
| SG5 | Pre-Cycle Git Tag  | pre-auto-YYYY-MM-DD before each cycle. Prune >30d, keep min 10  | `src/rituals/scheduler.ts`               |

---

## v6.1 — Background Agents + Task Continuity — **Done**

| Item                                                                                 | Source       | Status   |
| ------------------------------------------------------------------------------------ | ------------ | -------- |
| Trigger detection: "lanza un agente", "investiga en background", "averigua mientras" | Router       | **Done** |
| Max 3 concurrent agents, workspace/ scratch writes, completion notification          | Architecture | **Done** |
| Fork child boilerplate: identity + 6 rules + structured output (Alcance/Resultado)   | OpenClaude   | **Done** |
| Worker isolation: no conversationHistory, scoped tools, 60-min timeout               | OpenClaude   | **Done** |
| Task continuity: checkpoint on max_rounds, "continúa" resumes with context           | Architecture | **Done** |

---

## Behavioral Coherence (10 OpenClaude Patterns) — **Done**

Shipped in 4 batches + 2 audit fixes. Source: Claude Code CLI architecture analysis.

| #   | Pattern                          | File                                            | Status   |
| --- | -------------------------------- | ----------------------------------------------- | -------- |
| 1   | Critical System Reminder         | `adapter.ts`                                    | **Done** |
| 2   | 9-section structured compact     | `context-compressor.ts`                         | **Done** |
| 3   | Verification discipline nudge    | `fast-runner.ts`                                | **Done** |
| 4   | Tool deferral                    | `registry.ts` + `adapter.ts` + `fast-runner.ts` | **Done** |
| 5   | KB omission for read-only tasks  | `fast-runner.ts`                                | **Done** |
| 6   | NO_TOOLS_PREAMBLE sandwich       | `context-compressor.ts`                         | **Done** |
| 7   | Fork child injection boilerplate | `router.ts`                                     | **Done** |
| 8   | Continue-vs-spawn matrix         | `planner.ts`                                    | **Done** |
| 9   | Memory drift verification        | `enrichment.ts`                                 | **Done** |
| 10  | "Never delegate understanding"   | `planner.ts`                                    | **Done** |

---

## Path Safety Pipeline — **Done**

Ported from Claude Code's `validatePath()`. Wired into file_write, file_edit, file_delete.

| Check | What                                                                                     | Status   |
| ----- | ---------------------------------------------------------------------------------------- | -------- |
| 1     | Quote stripping + tilde expansion                                                        | **Done** |
| 2     | UNC path block (SMB credential leak prevention)                                          | **Done** |
| 3     | Tilde variant block (~user, ~+, ~-)                                                      | **Done** |
| 4     | Shell expansion syntax block ($) — TOCTOU prevention                                     | **Done** |
| 5     | Glob block for write/delete operations                                                   | **Done** |
| 6     | Dangerous files (.env.\*, .bashrc, .npmrc, .netrc) + directories (.git/, .ssh/, .gnupg/) | **Done** |
| 7     | isDangerousRemovalPath — root, home, top-level dirs, wildcards                           | **Done** |

58 tests covering all checks.

---

## Pre-v6.2 Hardening — **Done**

| Item | What                                                 | Status   |
| ---- | ---------------------------------------------------- | -------- |
| H1   | Flatten project paths (38 files migrated)            | **Done** |
| H2   | Tighten prompt enhancer (MIN_LENGTH, 2-question cap) | **Done** |
| H3   | Migrate user_facts — 28 to KB, 6 credentials remain  | **Done** |
| H4   | Video pipeline E2E — PASS (5.3s MP4, video+audio)    | **Done** |
| H5   | Self-tuning verified — baseline 79.3%                | **Done** |
| H6   | Provider health baseline — 7-day metrics in KB       | **Done** |

---

## v6.2 — Reliable Foundation (14/14 DONE)

**Theme**: Jarvis never goes silent, remembers what it learns, produces real video content.

### Workstream 1: Inference Resilience (5 sessions)

| Session | Deliverable                   | What                                                                                             | Status   |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| S1      | Smart Provider Routing        | Health classification (healthy/degraded/unhealthy), baseline thresholds, per-model cost tracking | **Done** |
| S2      | Task Cancellation             | "cancela" from Telegram → AbortController through dispatcher → runner → inferWithTools           | **Done** |
| S3      | Per-Task Mutation Log         | task_mutations table, classifyMutation for 8 tool types, centralized recording. 15 tests         | **Done** |
| S4      | Unified FS Maturation         | Topic-slug auto-persist paths, nightly INDEX.md regen, stop-word filtering. 6 tests              | **Done** |
| S5      | Protected Paths + Path Safety | isPreciousPath for KB prefixes, CONFIRMATION_REQUIRED flow with confirmed:true param. 14 tests   | **Done** |

### Workstream 2: Memory Reinforcement (5 sessions)

| Session | Deliverable                   | What                                                                                                      | Status   |
| ------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| M0      | pgvector KB on Supabase       | kb_entries table, HNSW index, Spanish tsvector, dual-write adapter. 315 entries backfilled. Hybrid search | **Done** |
| M0.5    | Background Memory Extractor   | Post-task LLM extraction (1-3 facts), content-hash dedup, pgvector storage. 17 tests                      | **Done** |
| M1      | Lesson Fingerprinting + Dedup | Content-hash dedup in write path, weekly decay sweep cron (Sundays 2 AM). 7 tests                         | **Done** |
| M2      | Ebbinghaus Retention Scoring  | kb_retention_sweep RPC (hot/warm/cold/evictable tiers), nightly 3 AM cron. 4 tests                        | **Done** |
| M3      | Crystal → Lesson Pipeline     | crystallizeTask: lesson-focused LLM extraction (≥5 tools, >30s), content-hash dedup. 9 tests              | **Done** |

### Workstream 3: Content Factory Foundation (3.5 sessions)

| Session | Deliverable                | What                                                                                   | Status   |
| ------- | -------------------------- | -------------------------------------------------------------------------------------- | -------- |
| V1      | TTS Engine Upgrade         | Per-scene TTS, 324 voices (edge-tts), sentence splitting + ffprobe durations. 17 tests | **Done** |
| V2      | Background Media Library   | yt-dlp + cache, FFmpeg subclip extraction, 5 royalty-free catalog. 6 tests             | **Done** |
| V3      | Overlay Composition Engine | FFmpeg between(t,x,y) timed overlays, bg crop, audio concat+mix. 5 tests               | **Done** |
| V3.5    | Integration + Polish       | E2E overlay pipeline validated (4.6s MP4), ACI workflow docs, scope keywords           | **Done** |

### v6.2 Success Criteria — ALL MET

- [x] Jarvis never goes silent >2 minutes due to provider failure
- [x] KB entries deduplicate automatically via content fingerprinting
- [x] Old unreinforced entries decay and get pruned (Ebbinghaus)
- [x] Conversations automatically extract memories into pgvector
- [x] Enrichment pipeline uses vector similarity, not just FTS5 keywords
- [x] `video_create mode:"overlay"` produces 30-60s vertical video with per-scene narration over background

---

## v6.3 — Content Distribution (7/8 DONE)

**Theme**: End-to-end content pipeline — from source to published post. Plus writing quality and browser stealth.

### Workstream 4: Content Distribution (4.5 sessions)

| Session | Deliverable                    | What                                                                                            | Status      |
| ------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------- |
| D1      | Screenshot-to-Content Pipeline | screenshot_element tool (Playwright direct, DSF HiDPI, theme override, JS injection). 9 tests   | **Done**    |
| D2      | Social Publishing Scaffolding  | social_accounts + publish_records tables, 3 tool stubs (publish/accounts/status). OAuth pending | **Done**    |
| D3      | TikTok + YouTube Publishing    | Chunked upload, resumable protocol, status polling                                              | **Blocked** |
| D4      | Content Calendar               | social_schedule tool, event reactor triggers, batch mode                                        | **Blocked** |
| D4.5    | Playwright Stealth Hardening   | 5 addInitScript patches (hasFocus, visibility, webdriver, connection, memory). 7 tests          | **Done**    |

**D3+D4 blocker**: Need Meta (FB/IG), TikTok, and YouTube OAuth app registration. Set credentials in .env, then ~2 sessions to ship.

### Workstream 5: Writing Quality (1.5 sessions)

| Session | Deliverable                   | What                                                                                               | Status   |
| ------- | ----------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| W1      | AI Writing Humanization Skill | humanize_text tool: detect/rewrite modes, Tier 1 words + artifacts + structure. 3 tests            | **Done** |
| W1.5    | Mechanical Post-Filter        | Regex scan for 20 patterns (words + artifacts + leaks + filler). Wired into sendToChannel. 6 tests | **Done** |

### Workstream 6: Dashboard Generation (2 sessions)

| Session | Deliverable              | What                                                                                       | Status   |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------ | -------- |
| DB1     | Tool + Prompt + Template | dashboard_generate: ECharts 5 + LLM JSON options + KPI hero cards. dashboard_list. 5 tests | **Done** |
| DB2     | Serving + Integration    | GET /dashboard/:id serves self-contained HTML. Path traversal + XSS protected              | **Done** |

### v6.3 Success Criteria

- [ ] "Toma este hilo, hazlo video, publícalo en TikTok e Instagram de [cliente]" works end-to-end — **blocked on D3+D4 OAuth**
- [x] All outbound text passes humanization filter (no "delve", no reasoning chain leaks)
- [x] `dashboard_generate` produces interactive ECharts HTML served via Hono URL
- [x] Playwright browser passes bot.incolumitas.com and sannysoft basic checks
- [ ] Content calendar enables "publish this video to all [client] accounts" — **blocked on D3+D4 OAuth**

---

## v6.3.1 — Context Optimization — **Done**

Single session. Eliminated the #1 performance bottleneck: tool schema bloat causing first-round freezes and token budget blow-outs.

| Change                       | Before        | After                                |
| ---------------------------- | ------------- | ------------------------------------ |
| Tool schemas sent to LLM     | 60-84 full    | 15-30 full + deferred catalog        |
| Prompt tokens (generic chat) | ~19.3K        | ~9.3K **(52% reduction)**            |
| First-round tool skips       | 4/8 tasks     | 0                                    |
| MISC_TOOLS (always-on)       | 30 tools      | 10 tools                             |
| KB injection                 | 8.5K chars    | ~7K chars                            |
| Enrichment (pgvector)        | Sequential 5s | Parallel with 2s timeout             |
| Fast-path threshold          | ≤8 words      | ≤2 words (3+ = full pipeline always) |
| Scope inheritance            | Last 2 turns  | Last 1 turn                          |
| user_facts table             | 34 entries    | 6 credentials only (rest migrated)   |
| Project README               | Manual lookup | Auto-injected on project name in msg |
| Scope deduplication          | None          | `[...new Set(tools)]`                |

Key bug fixes:

| Bug                                      | Impact                                                        | Fix                                                           |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Deferred expansion infinite loop         | 109 tools could never execute                                 | `allowedToolNames.add()` + `tools.push()` after schema return |
| Fast-path NorthStar hallucination        | "Abre mi Northstar" bypassed tools, LLM fabricated "pillars"  | 3+ words always → full pipeline                               |
| Scope cascade from hallucinated response | Fake keywords in thread buffer activated 4 extra scope groups | Reduced thread inheritance to 1 turn                          |
| pgvector timeout race condition          | Late-arriving results mutated shared `sections` array         | `pgTimedOut` guard flag                                       |
| Specialty regex false positive           | "Limpia tu contexto" matched `limpia.*texto` via "contexto"   | Anchored with `\btexto\b`                                     |

---

## v6.3.2 — Scheduled Report Resilience — **Done**

Single session. Fixed compounding failures causing daily report delivery misses (Mercados & Biotecnología, Pharma & Cáncer).

| Change                          | Before                                 | After                                        |
| ------------------------------- | -------------------------------------- | -------------------------------------------- |
| gmail_send deferral             | Deferred (extra round + timeout risk)  | **Non-deferred** (critical delivery tool)    |
| Deferral for small tool sets    | Always applied (even 2-3 tools)        | **Skipped when ≤6 tools** (scheduled/ritual) |
| Provider degradation window     | 10 min / 3% error → skip               | **3 min / 25% error** (routing decisions)    |
| Provider degradation latency    | >90s avg → skip                        | **>180s avg** → skip (matches unhealthy)     |
| Dashboard health classification | Unchanged (10 min / 3% for visibility) | Unchanged                                    |

Root cause chain: gmail_send deferred → extra round after 8K context → timeout → provider cascade → all 3 fail → degradation persists 10 min → interactive traffic affected.

---

## v6.4 — Intelligence Layer — **Planned**

**Theme**: Jarvis gets smarter at prompting, self-improving, orchestrating, and managing its own complexity.

Reordered after v6.3.2 learnings: reliability before intelligence. PE1.5 (BRAID Solver/APE/STaR) dropped — Mermaid scaffolds + variant scoring are academic overhead for a system where the enhancer already PASses 80% of messages correctly. OH1 reframed — Jarvis has no qa-auditor agent; QA is distributed across 5 layers (inference guards, hallucination detection, Prometheus reflector, outcome tracker, overnight tuning). "3 parallel review agents" was a Claude Code pattern that doesn't map here. Replaced with fast-runner post-task quality pipeline.

### Workstream 7: Operational Hardening — Ship First (3 sessions)

| Session | Deliverable                                    | What                                                                                                                                                             |
| ------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| OH2     | Hallucination Guard Precision + Deferral Tests | Remove status data-label false positive, expand diagnostic exemptions. 8 deferred expansion tests. 25 scope regression tests. **1618 tests.**                    | **Done** |
| ST1     | Scheduled Task Resilience                      | Auto-retry on delivery miss (1 attempt). analysis_paralysis exemption for gmail_send tasks. Kimi tools stripped in callProvider().                               | **Done** |
| OH1.5   | Execute-Then-Schedule + Provider Routing v2    | Immediate execution on schedule_task creation. Per-task failure cap (max 2 per taskId) in isDegraded(). taskId threaded through inference chain. **1620 tests.** | **Done** |

### Workstream 8: Prompt Enhancer v2 (1 session)

PE1 validated against Jarvis's enhancer architecture: CIRICD dimensions already exist implicitly (clarity gates, ERROR GRAVE risk detection, batch decomposition, context from last 4 turns). This session formalizes them as explicit scoring dimensions in the analyzer prompt.

| Session | Deliverable             | What                                                                                                                                          |
| ------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PE1     | CIRICD-Aware Gatekeeper | Structured JSON scoring in analyzePrompt(). parseCiricdResponse() with fallback. CIRICD logs for observability. 19 new tests. **1639 tests.** | **Done** |

### Workstream 9: Memory Maturation (1.5 sessions)

| Session | Deliverable                         | What                                                                                                                                         |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G1      | Cascading Staleness Propagation     | pgCascadeStale() on upsert — marks entries with related_to containing superseded path as stale. Fire-and-forget. 3 tests. **1642 tests.**    | **Done** |
| G1.5    | Query Expansion + Session Diversity | expandQuery() generates 3 reformulations, parallel pgvector search, path dedup, max 2 per source_task_id. Seed cases 73→103. **1648 tests.** | **Done** |

### Workstream 10: Autoresearch + Skill Refinement (1.5 sessions)

| Session | Deliverable                            | What                                                                                                                                             |
| ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| A1      | Anti-Overfitting + Simplicity Criteria | validateMutation() gate: case-ID overfitting, >2x complexity, low-worth (1 case + length). "rejected" ExperimentStatus. 6 tests. **1648 tests.** | **Done** |
| SK1     | Batch Orchestration Skill              | batch_decompose tool: chunks items into groups of 5, submits as subtasks. Deferred, scope-gated to specialty. **170 tools.**                     | **Done** |

### Workstream 11: Fast-Runner Quality Pipeline (1 session)

Replaces OH1 (decomposed QA). Jarvis's fast-runner handles 90%+ of tasks but has no post-execution quality validation beyond hallucination detection. The Prometheus reflector only runs on heavy-runner tasks.

| Session | Deliverable             | What                                                                                                                                              |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| QP1     | Post-Task Quality Check | Delivery miss detection in fast-runner: gmail_send in scope but not called → DONE_WITH_CONCERNS. Wired after hallucination guard. **1648 tests.** | **Done** |

### v6.4 Success Criteria — ALL MET

- [x] Hallucination guard no longer fires on write-claim-before-write-call pattern
- [x] Deferred tool expansion path has full test coverage (8 tests)
- [x] Scope pattern regression test suite covers 25 historical bugs
- [x] Scheduled tasks auto-retry once on delivery miss
- [x] Kimi restricted to tools=0 wrap-up (no tool schemas sent)
- [x] Prompt enhancer scores CIRICD dimensions explicitly, asks targeted questions
- [x] Superseded KB entries cascade staleness to related entries
- [x] `batch_decompose` decomposes large tasks into chunked subtasks
- [x] Fast-runner delivery miss detected and flagged as DONE_WITH_CONCERNS
- [ ] Self-tuning seed set expanded 73 → 100+ — **deferred to G1.5**

---

## Safety Invariants

1. Jarvis CANNOT push to `main` — branches + PRs only
2. Jarvis CANNOT modify `directives/` without user approval
3. Jarvis CANNOT remove safety guards — SG3 immutable core
4. Jarvis CANNOT restart without passing tests
5. Jarvis CANNOT modify immutable core files — even on jarvis/\* branches
6. Jarvis CANNOT propose directives more than once per 48h (SG4)
7. Jarvis CANNOT write to .env, .bashrc, .ssh/, .git/ — path safety pipeline
8. All actions audited
9. New tools default to `deferred: true` — full schemas earned, not assumed

---

## Deliberately Skipped

| Pattern                         | Source                     | Why                                                                        |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| Remotion composition engine     | OpenMontage                | FFmpeg sufficient for overlay mode                                         |
| AI video generation (Kling/Veo) | OpenMontage                | $3-10/video, not until monetized                                           |
| P2P memory sync                 | agentmemory                | Single-instance Jarvis                                                     |
| Anton full integration          | Anton (MindsDB)            | CLI-only, AGPL, Python sidecar                                             |
| ICL few-shot selection          | prompt-in-context-learning | Requires labeled eval sets                                                 |
| Multi-VPS management            | Hostinger API              | Single VPS for now                                                         |
| Self-modifying core infra       | —                          | Too risky for autonomous changes                                           |
| Embedding-based scoping         | —                          | Regex 92%+ accuracy, deferred                                              |
| BRAID Solver + APE Loop (PE1.5) | arxiv 2512.15959           | Enhancer already PASses 80%; Mermaid scaffolds + STaR = academic overhead  |
| Decomposed QA (3 agents)        | Claude Code qa-auditor     | Jarvis has no qa-auditor; QA is 5 distributed layers, not 1 agent to split |

---

## Deferred to v7.0+

| Capability                         | Why deferred                        |
| ---------------------------------- | ----------------------------------- |
| Multi-VPS management               | Single VPS for now                  |
| Self-modifying core infrastructure | Too risky for autonomous changes    |
| Agent-to-agent communication       | Background agents don't need it yet |
| Remove human review gate           | Never — alignment constraint        |
| Persistent agent sessions          | Thin approach first, fat if needed  |

---

## Metrics

| Metric                  | v5.0 Final | v6.0+v6.1 | v6.2 | v6.4 (current)     |
| ----------------------- | ---------- | --------- | ---- | ------------------ |
| Tests                   | 1228       | 1377      | 1576 | 1648               |
| Source files            | 214        | 228       | 232  | 234                |
| Test files              | 85         | 105       | 120  | 122                |
| Tools                   | 150        | 163       | 169  | 170 (109 deferred) |
| Safeguards              | 0          | 5         | 5    | 5                  |
| Behavioral patterns     | 0          | 10        | 10   | 10                 |
| Background agents (max) | 0          | 3         | 3    | 3                  |
| Provider cascade        | 2-model    | 3-model   | 3    | 3                  |
| Immutable core files    | 0          | 15        | 15   | 15                 |
| Rituals                 | 7          | 9         | 9    | 9                  |
| KB entries (pgvector)   | 0          | 0         | 315  | 350+               |
| Prompt tokens (chat)    | ~15K       | ~19K      | ~19K | ~9.3K              |

---

## Total Effort

| Version   | Theme                  | Sessions | Status       |
| --------- | ---------------------- | -------- | ------------ |
| v6.0      | Self-improving Jarvis  | 8        | **Done**     |
| SG1-SG5   | Safeguards             | 1        | **Done**     |
| v6.1      | Background agents      | 3        | **Done**     |
| Coherence | 10 OpenClaude patterns | 2        | **Done**     |
| Hardening | Pre-v6.2               | 1        | **Done**     |
| v6.2      | Reliable foundation    | 14       | **Done**     |
| v6.3      | Content distribution   | 8        | **7/8 done** |
| v6.3.1    | Context optimization   | 1        | **Done**     |
| v6.3.2    | Scheduled report fix   | 1        | **Done**     |
| v6.4      | Intelligence layer     | 8        | **Done**     |
| **Total** |                        | **47**   |              |
