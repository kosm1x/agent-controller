# Jarvis Roadmap: v6.2 → v6.3 → v6.4

**Date**: 2026-04-06
**Baseline**: v6.0+v6.1 complete. 1319 tests, 163 tools. SG1-SG5 shipped. Behavioral coherence (10 OpenClaude patterns) shipped.
**Sources**: 8 repo assessments, 3 Claude Code deep-dives, 11 memory references

---

## v6.2 — Reliable Foundation

**Theme**: Jarvis never goes silent, remembers what it learns, and produces real video content.

**Duration**: 14 sessions, ~7 weeks

### Workstream 1: Inference Resilience (5 sessions)

| Session | Deliverable                       | Why                                                                                                                                                      |
| ------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1      | Smart Provider Routing — **DONE** | Health classification (healthy/degraded/unhealthy), baseline-derived thresholds (90s/3%/180s/10%), per-model cost tracking, auto-demotion on degradation |
| S2      | Task Cancellation — **DONE**      | "cancela"/"detente" from Telegram. AbortController wired through dispatcher → fast-runner → inferWithTools. Cancel intent regex + cleanup + notification |
| S3      | Per-Task Mutation Log — **DONE**  | task_mutations table, classifyMutation for 8 tool types, centralized recording in task executor, getMutationSummary. 15 new tests                        |
| S4      | Unified FS Maturation             | Auto-persist paths, day recaps, INDEX.md regen, stale cleanup                                                                                            |
| S5      | Protected Paths + Path Safety     | validatePathSafety 6-check pipeline, isDangerousRemovalPath, DANGEROUS_FILES                                                                             |

### Workstream 2: Memory Reinforcement (5 sessions)

| Session | Deliverable                              | Source                                                                                                                                                         |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0      | pgvector KB Migration — **DONE**         | Supabase self-hosted. `kb_entries` table, HNSW index, Spanish tsvector, dual-write adapter. 315/315 backfilled with Gemini embeddings. Hybrid search RPC live. |
| M0.5    | Background Memory Extractor — **DONE**   | Post-task LLM extraction (1-3 facts), content-hash dedup, pgvector storage with embeddings, pgvector hybrid search in enrichment pipeline. 17 new tests        |
| M1      | Lesson Fingerprinting + Dedup — **DONE** | Content-hash dedup in write path (reinforce vs duplicate), weekly decay sweep cron (Sundays 2 AM), KB health stats in /health endpoint. 7 new tests            |
| M2      | Ebbinghaus Retention Scoring             | agentmemory. Postgres function, type-salience map, hot/warm/cold/evictable tiers, pg_cron nightly                                                              |
| M3      | Crystal → Lesson Pipeline                | agentmemory. Post-task LLM crystallization, 1-3 atomic lessons, fingerprint dedup                                                                              |

### Workstream 3: Content Factory Foundation (3.5 sessions)

| Session | Deliverable                   | Source                                                                                                                                             |
| ------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1      | TTS Engine Upgrade — **DONE** | Per-scene TTS with ffprobe durations, 324-voice selection, sentence-boundary text splitting + silence concat, video_list_voices tool. 17 new tests |
| V2      | Background Media Library      | RedditVideoMakerBot. yt-dlp cache, random subclip, royalty-free pre-seed                                                                           |
| V3      | Overlay Composition Engine    | RedditVideoMakerBot. FFmpeg between(t,x,y) timing, audio mixing, portrait-first                                                                    |
| V3.5    | Integration + Polish          | Wire V1+V2+V3. End-to-end test: topic → TTS → images → background → MP4                                                                            |

### v6.2 Week Plan

```
Week 1:  S1 (provider routing)     +  M0 (pgvector migration)
Week 2:  S2 (task cancel)          +  M0.5 (background extractor)
Week 3:  S3 (mutation log)         +  M1 (lesson fingerprinting)
Week 4:  V1 (TTS upgrade)         +  M2 (retention scoring)
Week 5:  S4 (unified FS)          +  V2 (background library)
Week 6:  V3 (overlay composition)  +  M3 (crystal→lesson)
Week 7:  S5 (protected paths)     +  V3.5 (integration)
```

### v6.2 Success Criteria

- [ ] Jarvis never goes silent >2 minutes due to provider failure
- [ ] KB entries deduplicate automatically via content fingerprinting
- [ ] Old unreinforced entries decay and get pruned (Ebbinghaus)
- [ ] Conversations automatically extract memories into pgvector
- [ ] Enrichment pipeline uses vector similarity, not just FTS5 keywords
- [ ] `video_create mode:"overlay"` produces 30-60s vertical video with per-scene narration over background

---

## v6.3 — Content Distribution

**Theme**: End-to-end content pipeline — from source to published post. Plus writing quality and browser stealth.

**Duration**: 8 sessions, ~4 weeks

### Workstream 4: Content Distribution (4.5 sessions)

| Session | Deliverable                     | Source                                                                                          |
| ------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| D1      | Screenshot-to-Content Pipeline  | RedditVideoMakerBot. `screenshot_element` tool, DSF trick, cookie injection, DOM text injection |
| D2      | Facebook + Instagram Publishing | AiToEarn. OAuth, social_accounts + publish_records tables, Media Container pattern              |
| D3      | TikTok + YouTube Publishing     | AiToEarn. Chunked upload, resumable protocol, status polling                                    |
| D4      | Content Calendar                | `social_schedule` tool, event reactor triggers, batch mode                                      |
| D4.5    | Playwright Stealth Hardening    | browser-fingerprinting. 5 addInitScript patches, validate against 5 test URLs                   |

### Workstream 5: Writing Quality (1.5 sessions)

| Session | Deliverable                   | Source                                                                                 |
| ------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| W1      | AI Writing Humanization Skill | avoid-ai-writing. On-demand skill, 4-section audit, 6 context profiles                 |
| W1.5    | Mechanical Post-Filter        | avoid-ai-writing. Regex scan on outbound messages: 60 Tier 1 words + chatbot artifacts |

### Workstream 6: Dashboard Generation (2 sessions)

| Session | Deliverable              | Source                                                                                        |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| DB1     | Tool + Prompt + Template | Anton. `dashboard_generate` tool, ECharts 5, KPI hero cards, template + LLM-generated options |
| DB2     | Serving + Integration    | Hono route, jarvis_files storage, Playwright screenshot for Telegram/WordPress                |

### v6.3 Week Plan

```
Week 1:  D1 (screenshots)          +  W1 (writing skill)
Week 2:  D2 (FB + Instagram)       +  W1.5 (post-filter)
Week 3:  D3 (TikTok + YouTube)     +  DB1 (dashboard tool)
Week 4:  D4 + D4.5 (calendar + stealth) + DB2 (dashboard serving)
```

### v6.3 Success Criteria

- [ ] "Toma este hilo, hazlo video, publícalo en TikTok e Instagram de [cliente]" works end-to-end
- [ ] All outbound text passes humanization filter (no "delve", no reasoning chain leaks)
- [ ] `dashboard_generate` produces interactive ECharts HTML served via Hono URL
- [ ] Playwright browser passes bot.incolumitas.com and sannysoft basic checks
- [ ] Content calendar enables "publish this video to all [client] accounts"

---

## v6.4 — Intelligence Layer

**Theme**: Jarvis gets smarter at prompting, self-improving, orchestrating, and managing its own complexity.

**Duration**: 6 sessions, ~3 weeks

### Workstream 7: Prompt Enhancer v2 + BRAID (2 sessions)

BRAID integration based on validated paper findings (arxiv.org/abs/2512.15959). Two-stage Generator-Solver architecture maps to prompt enhancer → fast runner split.

| Session | Deliverable                               | Source                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PE1     | CIRICD-Aware Gatekeeper + BRAID Generator | prompt-in-context-learning + BRAID paper. Detect missing CIRICD components, ask targeted questions. Generate Mermaid reasoning scaffolds for complex workflows (scope classification, tool orchestration, replan decisions). Generator uses expensive model once per SOP, scaffolds stored in KB for reuse. Numerical Masking Protocol to prevent answer leakage |
| PE1.5   | BRAID Solver Integration + APE Loop       | BRAID paper + prompt-in-context-learning. Fast runner receives Mermaid scaffolds as system guidance (cheap model, per task). APE-style variant scoring: Mermaid vs CoT vs raw prompt on 73+ seed cases. Fair baseline: CoT WITH explicit triggers. Harvest 40+ templates as new seeds. STaR bootstrapping for self-improvement                                   |

### Workstream 8: Memory Maturation (1.5 sessions)

| Session | Deliverable                         | Source                                                                             |
| ------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| G1      | Cascading Staleness Propagation     | agentmemory. Track source_observation_ids, flag related entries stale on supersede |
| G1.5    | Query Expansion + Session Diversity | agentmemory. LLM generates 3-5 reformulations, cap results per session             |

### Workstream 9: Autoresearch + Skill Refinement (1.5 sessions)

| Session | Deliverable                            | Source                                                                                                     |
| ------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A1      | Anti-Overfitting + Simplicity Criteria | autoagent. "Would this still be worthwhile if the task disappeared?" + equal perf with simpler code = keep |
| SK1     | Batch Orchestration Skill              | OpenClaude skills. `/batch` equivalent: plan-approve-execute-track cycle for large multi-tool tasks        |

### Workstream 10: Operational Hardening (1.5 sessions)

| Session | Deliverable                                         | Source                                                                                                  |
| ------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OH1     | Decomposed QA Review                                | OpenClaude simplify. 3 parallel review agents (reuse, quality, efficiency) instead of single qa-auditor |
| OH1.5   | Loop Execute-Then-Schedule + disableModelInvocation | OpenClaude skills. Immediate execution on schedule + prevent LLM auto-invoking expensive skills         |

### v6.4 Week Plan

```
Week 1:  PE1 (CIRICD + BRAID generator)  +  G1 (cascading staleness)
Week 2:  PE1.5 (BRAID solver + APE)      +  G1.5 (query expansion)
Week 3:  A1 (autoresearch)               +  SK1 (batch skill)
         OH1 + OH1.5 (if time, fold into week 3)
```

### v6.4 Success Criteria

- [ ] Prompt enhancer detects missing CIRICD components, asks targeted questions
- [ ] BRAID Mermaid scaffolds generated for 3+ complex workflows (scope, orchestration, replan)
- [ ] Fast runner uses Mermaid scaffolds as system guidance — PPD >5x vs CoT baseline
- [ ] Self-tuning seed set expanded from 73 to 100+ with APE-style scoring (Mermaid vs CoT vs raw)
- [ ] Superseded KB entries cascade staleness to related entries
- [ ] `/autoresearch` rejects overfitting changes and rewards simplification
- [ ] `/batch` decomposes large tasks into parallel isolated units with tracking
- [ ] QA review runs 3 specialized agents in parallel instead of single pass

---

## Dependency Graph

```
v6.2 (Foundation)
  Inference:  S1 → S2 → S3 → S4 → S5
  Memory:     M0 → M0.5 → M1 → M3
              M0 → M2
  Content:    V1 → V3 → V3.5
              V2 → V3.5

v6.3 (Distribution) — depends on v6.2 Content (V3.5)
  Distrib:    D1 → D2 → D3 → D4 → D4.5
  Writing:    W1 → W1.5
  Dashboards: DB1 → DB2

v6.4 (Intelligence) — depends on v6.2 Memory (M0, M1)
  Prompt:     PE1 → PE1.5
  Memory+:    G1, G1.5 (independent)
  Autoresearch + Skills: A1, SK1 (independent)
  Hardening:  OH1, OH1.5 (independent)
```

---

## Architecture Constraints (all versions)

- No new npm dependencies without discussion (11 core + 2 messaging)
- Vendor-agnostic inference: raw fetch to OpenAI-compatible endpoints
- Additive schema changes only (no DB reset)
- $2/video default budget, CONFIRMATION_REQUIRED before exceeding
- 1 concurrent video render (8GB RAM budget)
- libx264 only, no GPU dependency
- Social OAuth tokens stored encrypted in SQLite, refresh on 401
- pgvector via raw fetch to Supabase REST API (no SDK)

---

## What We Shipped Today (pre-v6.2, behavioral coherence)

6 commits, ~540 lines, all 1319 tests passing:

| Commit    | Patterns                                                          |
| --------- | ----------------------------------------------------------------- |
| `57df00b` | Critical System Reminder, 9-section compact, verification nudge   |
| `e39d4e3` | Tool deferral, KB omission, NO_TOOLS sandwich                     |
| `921cb4b` | Audit fixes batch 1                                               |
| `a0d6fef` | Fork boilerplate, continue-vs-spawn, memory drift, never-delegate |
| `d20cb91` | Path safety pipeline, worker isolation, Prometheus progress       |
| `c9f5254` | Audit fixes batches 3-4                                           |

---

## What We Deliberately Skip

| Pattern                         | Source                     | Why                                |
| ------------------------------- | -------------------------- | ---------------------------------- |
| Remotion composition engine     | OpenMontage                | FFmpeg sufficient for overlay mode |
| AI video generation (Kling/Veo) | OpenMontage                | $3-10/video, not until monetized   |
| P2P memory sync                 | agentmemory                | Single-instance Jarvis             |
| Temporal versioned graph edges  | agentmemory                | Overkill for current usage         |
| Anton full integration          | Anton (MindsDB)            | CLI-only, AGPL, Python sidecar     |
| ICL few-shot selection          | prompt-in-context-learning | Requires labeled eval sets         |
| bashClassifier                  | OpenClaude                 | Internal-only stub                 |
| contextCollapse                 | OpenClaude                 | Stub, not implemented              |

---

## Total Effort

| Version   | Theme                | Sessions | Weeks   |
| --------- | -------------------- | -------- | ------- |
| v6.2      | Reliable Foundation  | 14       | ~7      |
| v6.3      | Content Distribution | 8        | ~4      |
| v6.4      | Intelligence Layer   | 6.5      | ~3      |
| **Total** |                      | **28.5** | **~14** |
