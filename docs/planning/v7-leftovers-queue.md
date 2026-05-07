# v7-Leftovers Queue — Outstanding Items from v7.5 and Earlier

> **Authored**: 2026-05-08
> **Sibling doc**: `next-sessions-queue.md` (post-freeze stability work — separate track)
> **Scope**: every v7-roadmap item with status `Planned` / `Gated` / `Partial` / `Deferred-with-trigger` from v7.0 through v7.5. v7.6+ items excluded (current track).
> **Verification pass run 2026-05-08**: confirmed via `grep` that none of the actionable items have been silently shipped. v7.4 worker-pool exists but is unwired; tool annotations / RationalRewards / F7 session-69 ports have zero references in `src/`.

---

## How to read this doc

Items are grouped by **what unblocks them**, not by version number. Within each tier they are ordered by ROI × effort.

- **Tier A — Actionable now**: pure code adds, no external deps, no waiting on telemetry. Pick from this list when the next session starts.
- **Tier B — Credential-gated**: code is straightforward but useless without operator-provisioned keys/tokens. List exists so we can ship in one batch when creds land.
- **Tier C — Trigger-gated**: deferred behind a measurable signal (mode collapse, FP rate, plateau, etc.). Don't pre-commit.
- **Tier D — Phase / decision-gated**: large arcs (Phase δ live trading, optional crypto WS).

---

## Tier A — Actionable now

| #   | Item                                                                                                                  | Source                                            | Estimate | Verification                                                                 | Notes                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A1  | **v7.4 S1.1 — wire `WorkerPool` into `composer.ts`**                                                                  | hyperframes #3                                    | 0.5 sess | `grep -n WorkerPool src/video/composer.ts` returns hits                      | Module written + tested at CAP=4; just unplugged. Closes v7.4 S1 partial.         |
| A2  | **Tool annotations — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on tool registry**          | anthropic `mcp-builder` skill (Session 69)        | 0.5 sess | grep `readOnlyHint` in `src/tools/` returns hits                             | MCP-spec field. Lets clients (and Jarvis itself) reason about side-effect safety. |
| A3  | **Skill evaluation loop — draft → test with/without skill → grade → improve**                                         | anthropic `skill-creator` (Session 69)            | 1 sess   | New `src/tuning/skill-eval-loop.ts` wired into Tue/Thu/Sat overnight cron    | v7.5 anchored. Complements existing `src/tuning/` mutation pipeline.              |
| A4  | **RationalRewards — Prometheus reflector per-dimension critiques (replace pass/fail with evidence)**                  | RationalRewards paper (Session 69)                | 0.5 sess | `src/prometheus/reflector.ts` emits structured critique objects, not bools   | v7.5 anchored. Improves Prometheus reflect signal quality.                        |
| A5  | **RationalRewards — predictive consistency gate (rationale predicts outcome blind to answer)**                        | RationalRewards paper (Session 69)                | 0.5 sess | New gate in tuning pipeline; rejects mutations that fail blind-prediction    | v7.5 anchored. Tightens skill-evolution validator.                                |
| A6  | **F7 — BM25 reflection memory** (per-agent banks; inject top-2 lessons from past P&L into next prompts)               | `reference_trading_agents.md` (Session 69, ~220L) | 1 sess   | `src/finance/` gains `reflection-memory.ts`; F7 alpha pipeline reads from it | F7 ships without it; this is an additive lift. Pure code, no API.                 |
| A7  | **F7 — Adversarial critic pass** (single bull/bear critic over Portfolio Manager draft + judge reconciliation, ~150L) | `reference_trading_agents.md` (Session 69)        | 0.5 sess | Critic step lives in `src/finance/alpha-combination.ts` decision flow        | Same session as A6 — share inference budget.                                      |
| A8  | **F7 — Black-Litterman signal combiner** (multi-agent signals as views into posterior, mathjs, ~150L)                 | `reference_skfolio.md` (Session 69)               | 1 sess   | `src/finance/black-litterman.ts` + tests                                     | Replaces heuristic confidence-weighted sum.                                       |
| A9  | **F7 — HRP weight allocator** (López de Prado hierarchical risk parity)                                               | `reference_skfolio.md` (Session 69)               | 0.5 sess | `src/finance/hrp.ts` + tests                                                 | Replaces heuristic in ranking step.                                               |
| A10 | **F7 M1 — Inverse-vol + equal-weight baseline allocators** (~30L)                                                     | `reference_skfolio.md` (Session 69)               | 0.5 sess | Baselines exist before HRP ships, used as fallback                           | Ship before A9 to bracket the lift.                                               |
| A11 | **v7.4.3.6 — Skill gate markdown** (`SKILL.md` + `house-style.md` + `visual-styles.md` for HTML composition)          | hyperframes #5                                    | 0.5 sess | Skills loaded by v7.5 Skill Evolution Engine                                 | Was blocked on v7.5 — **now unblocked**.                                          |

---

## Tier B — Credential-gated (deferred until operator provisions)

| #   | Item                                                                                                | Required credential                               | Estimate | Notes                                                                        |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| B1  | **v7.3 P4b — Meta Ads API client** (Graph v21+, campaign CRUD, audience targeting, creative upload) | FB Business app (id/secret/system-user token)     | 0.5 sess | Half a session each for B1+B2. Don't ship before creds — produces dead code. |
| B2  | **v7.3 P4b — Google Ads API client** (campaign CRUD, keywords, bid strategies)                      | Google OAuth2 client + Google Ads developer token | 0.5 sess | Same — gate on credentials.                                                  |
| B3  | **v7.3 P4c — Bid management** (budget alloc, dayparting, auto-pause)                                | Depends on B1+B2                                  | 0.5 sess | One bundled session after B1+B2.                                             |
| B4  | **v7.3 P4c — CRM attribution** (ad click → lead → opportunity → close, via agentic-crm)             | Depends on B1+B2 + agentic-crm webhooks           | 0.5 sess | Same bundle as B3.                                                           |
| B5  | **v7.3 P4c — Daily performance ritual + weekly optimization report**                                | Depends on B1+B2                                  | 0.5 sess | Same bundle as B3+B4. Ship all of P4c in one session.                        |
| B6  | **v7.4 S2b — higgsfield/Muapi pipeline** (Kling clips + Flux stills)                                | higgsfield/Muapi API key                          | 1 sess   | AI asset generation upgrade.                                                 |
| B7  | **v7.4 S2b — fal.ai FLUX adapter** (replace pexels stock with AI-generated stills)                  | `FAL_API_KEY`                                     | 0.5 sess | Same session as B6 if both keys land together.                               |
| B8  | **v7.4 S2b — ElevenLabs premium TTS adapter** (replace edge-tts)                                    | `ELEVENLABS_API_KEY`                              | 0.5 sess | Same session.                                                                |
| B9  | **v7.4 S2b — Lip-sync for talking-head**                                                            | wav2lip OR Muapi key                              | 0.5 sess | Same session if Muapi covers both B6 + B9.                                   |

---

## Tier C — Trigger-gated (do nothing until signal fires)

### v7.5.1 cluster — fires only if v7.5 telemetry shows the named pathology

| #   | Item                                                                                | Trigger                                           |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| C1  | MAP-Elites island sampling (quality-diversity alternative to score-prop)            | Variant archive shows mode collapse (top-5 same)  |
| C2  | Dedicated Analyzer module separate from mutator (engineer trace → analyzer distill) | Reflector-gap telemetry regresses                 |
| C3  | Triple-judge minority veto for safety-critical gates                                | False-positive promotion rate > 5%                |
| C4  | ASI (Ablation Signal Intensity) diagnostics                                         | Per-clause hot-spot attribution needed            |
| C5  | Pareto domain specialization (per-category skill variants)                          | Domain-score variance > cross-domain delta        |
| C6  | GEPA `reflection_lm_kwargs` passthrough                                             | qwen reflection quality plateau                   |
| C7  | Full logprob confidence (replace stddev proxy in `confidence.ts`)                   | Opus/Sonnet logprob API lands in primary provider |

### v7.6 cluster — schema-blocked / module-split-blocked

| #   | Item                                                                                     | Blocker                                                          |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C8  | Two-layer memory separation — `kb_entries.layer` (`prior_knowledge` / `task_experience`) | Schema add on `kb_entries` table                                 |
| C9  | ACE 3-agent Generator → Reflector → Curator loop                                         | Mutator/analyzer module split (depends on C2)                    |
| C10 | claude-mem v12.2.2 subagent labeling schema adoption                                     | Coupled with C8                                                  |
| C11 | context-engineering latent-briefing KV cache compaction                                  | Prometheus runtime hook                                          |
| C12 | Hermes v0.10.0 compression smart-collapse + anti-thrash gate                             | Separate sprint — touches `src/prometheus/context-compressor.ts` |

### v7.4.3.x cluster — HTML-composition extensions (each with operator trigger)

| #   | Item                                                                         | Trigger                                                          |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C13 | v7.4.3.1 BeginFrame CDP capture path                                         | `page.screenshot` too slow (>300ms/frame) or visible sync jitter |
| C14 | v7.4.3.2 GSAP bundle (+1 dep or static asset)                                | Operator requests motion library beyond CSS animations           |
| C15 | v7.4.3.3 Pre-extract + inject `<video>` pipeline                             | Operator authors composition with `<video>` source               |
| C16 | v7.4.3.4 40-block HTML registry                                              | Operator requests reusable block template                        |
| C17 | v7.4.3.5 Audio overlay (TTS + music in HTML path)                            | Operator needs voiced HTML composition                           |
| C18 | v7.4.3.7 Multi-track / layer compositing (`data-track-index` + `data-layer`) | Operator requests multi-track output                             |
| C19 | Stale-`composing` reaper on boot (inherited from v7.4 S1)                    | Operator reports concurrency gate blocked with no active render  |

### Other trigger-only

| #   | Item                                                   | Trigger                                |
| --- | ------------------------------------------------------ | -------------------------------------- |
| C20 | Browser pool with atomic slot reservation              | Multi-agent browser sharing scenario   |
| C21 | Pagination auto-detection (5 strategies)               | Building `web_crawl` tool              |
| C22 | pg-boss job queue (PostgreSQL-backed)                  | Rituals/scheduling reliability upgrade |
| C23 | Landing-page CRO framework                             | Client landing-page work               |
| C24 | Three-tier ownership (runtime / first-fix / canonical) | Multi-layer debug session pattern      |

---

## Tier D — Phase / decision-gated

| #   | Item                                                                                                                                                                                                                                                                 | Gate                                                                              | Estimate |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| D1  | **v7.0 F10 — Real-Time Crypto WebSocket** (Binance adapter + tick-level signal dispatch)                                                                                                                                                                             | Optional — defer until needed                                                     | 1 sess   |
| D2  | **v7.0 F11 — Live Polymarket trading engine** (~16 sub-items: wallet sec, CLOB write path, OCO/OTO/iceberg, on-chain CTF ops, bridge, MAP-Elites cells, directional + market-making + arbitrage strategies, purged-CV backtest, kill-switch, 10-item security audit) | **Phase δ** — gated on 30+ days of F8 paper-trading positive risk-adjusted record | 2.5 sess |

---

## Suggested session bundling

| Session | Items                       | Description                                                                                                                                    |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| L1      | A1 + A11                    | **v7.4 unfinished** — wire worker-pool, ship the skill-gate markdown that v7.5 unblocked. Single video-stack session.                          |
| L2      | A2                          | **Tool annotations** — registry-wide additive change. Useful on its own; precondition for richer scope reasoning.                              |
| L3      | A3 + A4 + A5                | **v7.5 follow-through** — skill eval loop + RationalRewards reflector + predictive consistency gate. All in `src/tuning/` + `src/prometheus/`. |
| L4      | A10 + A9                    | **F7 portfolio allocators** — inverse-vol baseline first, then HRP. Ship together so F7 has a fallback chain.                                  |
| L5      | A8                          | **F7 Black-Litterman** — depends on A9 to combine signals into HRP-allocated weights.                                                          |
| L6      | A6 + A7                     | **F7 reflection + critic** — BM25 memory + adversarial bull/bear critic. Same inference budget; ship together.                                 |
| L7      | B1 + B2                     | **Ads API clients** — only when operator provisions FB + Google creds.                                                                         |
| L8      | B3 + B4 + B5                | **Ads automation** — bid mgmt + CRM attribution + perf ritual. After L7.                                                                       |
| L9      | B6 + B7 + B8 + B9           | **AI media stack** — higgsfield + fal + ElevenLabs + lip-sync. After all 4 keys land. Otherwise split per key arrival.                         |
| LT      | C-tier items                | **Trigger-fire** — no scheduled session. Each item activates on its named signal. Re-check during weekly retros.                               |
| LD      | D1 (optional), D2 (Phase δ) | **Phase-gated** — F10 only if crypto is requested; F11 only after F8 hits 30d positive paper record.                                           |

**Total Tier-A backlog: ~6.5 sessions** (A1–A11) once we go in execution order.
**Total Tier-B backlog: ~4.5 sessions** once creds land.
**Total Tier-C/D**: trigger / phase-gated, no scheduled budget.

---

## Maintenance protocol

1. After each Tier-A session ships, **strike-through the row + commit hash + verification grep result** (mirror the format used by `next-sessions-queue.md` items 1–14).
2. If a Tier-C trigger fires, **promote the item to Tier A immediately** — don't wait for a planning round. Telemetry-driven items are time-sensitive by definition.
3. If a Tier-B credential lands, **promote the credentialed item to Tier A immediately**.
4. Re-audit every 30 days against the v7-roadmap source of truth (`mc/docs/V7-ROADMAP.md`). Roadmap items that ship without flowing through this queue need cross-referencing both ways.
5. v7.6+ items live in their own queue (this doc explicitly excludes them).

---

## Cross-references

- Source roadmap: `mc/docs/V7-ROADMAP.md`
- Sibling queue (post-freeze stability): `mc/docs/planning/next-sessions-queue.md`
- v7.5 sweep report: `memory/v75_upstream_sweep_report.md`
- Phase β F-series detail: V7-ROADMAP.md §"Appendix: F-Series Technical Reference"
- Phase δ readiness gate: V7-ROADMAP.md §"v7.0 F11" (30d F8 paper-trading discipline)
