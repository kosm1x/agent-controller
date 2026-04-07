# Jarvis Roadmap

> Last updated: 2026-04-07 | 1577 tests | 169 tools (109 deferred) | 120 test files

---

## Where We Are

**v6.2** — COMPLETE (14/14 sessions)
**v6.3** — 7/8 done. D3+D4 blocked on OAuth app registration
**v6.3.1** — Shipped. Context optimization (52% prompt token reduction)
**Next** — D3+D4 when OAuth ready, then v6.4

---

## v6.2 — Reliable Foundation (COMPLETE)

14 sessions shipped. Jarvis never goes silent, remembers what it learns, produces real video.

### Inference Resilience

| #   | What                   | Key Detail                                                                        |
| --- | ---------------------- | --------------------------------------------------------------------------------- |
| S1  | Smart provider routing | Health tiers (healthy/degraded/unhealthy), per-model cost tracking, auto-demotion |
| S2  | Task cancellation      | "cancela" from Telegram → AbortController pipeline through dispatcher → runner    |
| S3  | Per-task mutation log  | task_mutations table, 8 tool types, centralized recording                         |
| S4  | Unified FS maturation  | Topic-slug auto-persist, nightly INDEX.md regen                                   |
| S5  | Protected paths        | isPreciousPath, CONFIRMATION_REQUIRED flow, path safety pipeline                  |

### Memory Reinforcement

| #    | What                        | Key Detail                                                                   |
| ---- | --------------------------- | ---------------------------------------------------------------------------- |
| M0   | pgvector KB on Supabase     | kb_entries with HNSW index, Spanish tsvector, hybrid search RPC. 315 entries |
| M0.5 | Background memory extractor | Post-task LLM extraction, content-hash dedup, pgvector storage               |
| M1   | Lesson fingerprinting       | Content-hash dedup, weekly decay sweep (Sundays 2AM)                         |
| M2   | Ebbinghaus retention        | hot/warm/cold/evictable tiers, nightly 3AM sweep                             |
| M3   | Crystal → Lesson pipeline   | Post-task crystallization (≥5 tools, >30s), type=pattern                     |

### Content Factory

| #    | What                     | Key Detail                                                                  |
| ---- | ------------------------ | --------------------------------------------------------------------------- |
| V1   | TTS engine               | Per-scene TTS, 324 voices (edge-tts), sentence splitting, ffprobe durations |
| V2   | Background media library | yt-dlp + cache, FFmpeg subclip, 5 royalty-free catalog                      |
| V3   | Overlay composition      | FFmpeg between(t,x,y) timed overlays, bg crop, audio concat+mix             |
| V3.5 | Integration E2E          | Overlay pipeline validated 4.6s MP4                                         |

---

## v6.3 — Content Distribution (7/8 DONE)

### Shipped

| #    | What                          | Key Detail                                                                                |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| D1   | Screenshot-to-content         | Playwright direct, DSF HiDPI, theme override, stealth patches                             |
| D2   | Social publishing scaffolding | social_accounts + publish_records tables, 3 tool stubs. OAuth pending                     |
| D4.5 | Playwright stealth            | 5 addInitScript patches (hasFocus, visibility, webdriver, connection, memory)             |
| W1   | AI writing humanization       | humanize_text tool: detect/rewrite modes, Tier 1 words + artifacts                        |
| W1.5 | Mechanical post-filter        | Regex scan for 20 patterns (words + artifacts + leaks + filler). Wired into sendToChannel |
| DB1  | Dashboard generation          | dashboard_generate: ECharts 5 + LLM JSON options + KPI hero cards                         |
| DB2  | Dashboard serving             | GET /dashboard/:id serves self-contained HTML                                             |

### Blocked (OAuth required)

| #   | What                        | Blocker                                         |
| --- | --------------------------- | ----------------------------------------------- |
| D3  | TikTok + YouTube publishing | Need Meta/TikTok/YouTube OAuth app registration |
| D4  | Content calendar            | Depends on D3 OAuth infrastructure              |

**To unblock**: Register OAuth apps for Meta (FB/IG), TikTok, YouTube. Set credentials in .env. Then D3+D4 are ~2 sessions.

---

## v6.3.1 — Context Optimization (COMPLETE)

Single session. Eliminated the #1 performance bottleneck: tool schema bloat.

| Change                       | Before                  | After                                    |
| ---------------------------- | ----------------------- | ---------------------------------------- |
| Tool schemas sent to LLM     | 60-84 full JSON schemas | 15-30 full + deferred catalog            |
| Prompt tokens (generic chat) | ~19.3K                  | ~9.3K (**52% reduction**)                |
| First-round tool skips       | 4/8 tasks               | 0                                        |
| MISC_TOOLS (always-on)       | 30 tools                | 10 tools                                 |
| KB injection                 | 8.5K chars              | ~7K chars                                |
| Enrichment (pgvector)        | Sequential (5s)         | Parallel with 2s timeout                 |
| Fast-path threshold          | ≤8 words                | ≤2 words (3+ = full pipeline)            |
| Scope inheritance            | Last 2 user turns       | Last 1 turn                              |
| user_facts                   | 34 entries              | 6 credentials only (rest migrated to KB) |
| Project README               | Manual lookup           | Auto-injected on project name detection  |

Key fixes:

- **Deferred expansion bug** — tools were looping infinitely (allowedToolNames never updated)
- **Fast-path hallucination** — "Abre mi Northstar" bypassed tools, LLM fabricated "pillars"
- **Scope over-triggering** — hallucinated response keywords cascaded into next turn's scope
- **pgvector race condition** — timeout guard prevents late mutations on shared sections array

---

## v6.4 — Intelligence Layer (PLANNED)

6.5 sessions, ~3 weeks. Jarvis gets smarter at prompting, self-improving, and orchestrating.

### Prompt Enhancer v2 + BRAID (2 sessions)

| #     | What                                      | Source                                                                                                                                   |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| PE1   | CIRICD-aware gatekeeper + BRAID generator | Detect missing prompt components, generate Mermaid reasoning scaffolds for complex workflows. Expensive model once per SOP, stored in KB |
| PE1.5 | BRAID solver + APE loop                   | Fast runner uses Mermaid scaffolds as system guidance. APE-style variant scoring on 73+ seed cases. Harvest 40+ templates                |

### Memory Maturation (1.5 sessions)

| #    | What                                | Source                                                                |
| ---- | ----------------------------------- | --------------------------------------------------------------------- |
| G1   | Cascading staleness propagation     | Track source_observation_ids, flag related entries stale on supersede |
| G1.5 | Query expansion + session diversity | LLM generates 3-5 reformulations, cap results per session             |

### Autoresearch + Skills (1.5 sessions)

| #   | What                                   | Source                                                                                          |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A1  | Anti-overfitting + simplicity criteria | "Would this still be worthwhile if the task disappeared?" + equal perf with simpler code = keep |
| SK1 | Batch orchestration skill              | `/batch`: plan-approve-execute-track cycle for large multi-tool tasks                           |

### Operational Hardening (1.5 sessions)

| #     | What                       | Source                                                                             |
| ----- | -------------------------- | ---------------------------------------------------------------------------------- |
| OH1   | Decomposed QA review       | 3 parallel review agents (reuse, quality, efficiency) instead of single qa-auditor |
| OH1.5 | Loop execute-then-schedule | Immediate execution on schedule + prevent LLM auto-invoking expensive skills       |

### v6.4 Success Criteria

- [ ] Prompt enhancer detects missing CIRICD components, asks targeted questions
- [ ] BRAID Mermaid scaffolds for 3+ complex workflows (scope, orchestration, replan)
- [ ] Fast runner uses scaffolds — PPD >5x vs CoT baseline
- [ ] Seed set expanded 73 → 100+ with APE scoring
- [ ] Superseded KB entries cascade staleness to related entries
- [ ] `/batch` decomposes large tasks into parallel units with tracking
- [ ] QA review runs 3 specialized agents in parallel

---

## Architecture Constraints

- No new npm dependencies without discussion (11 core + 2 messaging)
- Vendor-agnostic inference: raw fetch to OpenAI-compatible endpoints
- Additive schema changes only (no DB reset without approval)
- $2/video default budget, CONFIRMATION_REQUIRED before exceeding
- pgvector via raw fetch to Supabase REST API (no SDK)
- New tools default to `deferred: true` unless in CORE_TOOLS or MISC_TOOLS

---

## Deliberately Skipped

| Pattern                         | Source                     | Why                                |
| ------------------------------- | -------------------------- | ---------------------------------- |
| Remotion composition engine     | OpenMontage                | FFmpeg sufficient for overlay mode |
| AI video generation (Kling/Veo) | OpenMontage                | $3-10/video, not until monetized   |
| P2P memory sync                 | agentmemory                | Single-instance Jarvis             |
| Anton full integration          | Anton (MindsDB)            | CLI-only, AGPL, Python sidecar     |
| ICL few-shot selection          | prompt-in-context-learning | Requires labeled eval sets         |

---

## Summary

| Version   | Theme                 | Sessions | Status                       |
| --------- | --------------------- | -------- | ---------------------------- |
| v6.0      | Self-improving Jarvis | 8        | **Done**                     |
| v6.1      | Background agents     | 3        | **Done**                     |
| v6.2      | Reliable foundation   | 14       | **Done**                     |
| v6.3      | Content distribution  | 8        | **7/8 done** (D3+D4 blocked) |
| v6.3.1    | Context optimization  | 1        | **Done**                     |
| v6.4      | Intelligence layer    | 6.5      | Planned                      |
| **Total** |                       | **40.5** |                              |
