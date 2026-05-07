# v7-Leftovers Queue — Outstanding Items from v7.5 and Earlier

> **Status (2026-05-08)**: Tier-A backlog CLEARED. v7.5 formally closed via `docs/V7.5-CLOSURE.md` + tag `v7.5-closed`. This doc remains as a **post-closure watchlist** for residual Tier-B / Tier-C / Tier-D items. Each has an explicit re-open trigger; until those fire, no engineering effort is required.
>
> **Authored**: 2026-05-08
> **Sibling doc**: `next-sessions-queue.md` (post-freeze stability work — separate track)
> **Scope**: every v7-roadmap item with status `Planned` / `Gated` / `Partial` / `Deferred-with-trigger` from v7.0 through v7.5. v7.6+ items excluded (current track).
> **Verification pass run 2026-05-08**: confirmed via `grep` that none of the actionable items had been silently shipped. v7.4 worker-pool wired in L1; tool annotations + RationalRewards + F7 session-69 ports shipped in L2-L6.

---

## How to read this doc

Items are grouped by **what unblocks them**, not by version number. Within each tier they are ordered by ROI × effort.

- **Tier A — Actionable now**: pure code adds, no external deps, no waiting on telemetry. Pick from this list when the next session starts.
- **Tier B — Credential-gated**: code is straightforward but useless without operator-provisioned keys/tokens. List exists so we can ship in one batch when creds land.
- **Tier C — Trigger-gated**: deferred behind a measurable signal (mode collapse, FP rate, plateau, etc.). Don't pre-commit.
- **Tier D — Phase / decision-gated**: large arcs (Phase δ live trading, optional crypto WS).

---

## Tier A — Actionable now

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                            | Estimate        | Verification                                                                            | Notes |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------- | ----- |
| A1  | ~~**v7.4 S1.1 — wire `WorkerPool` into `composer.ts`**~~ ✅ **DONE 2026-05-08 (L1)**. `composeVideo` is now `async`; per-scene clip step fans out via `runPool` with promisified `execFile`. Pool auto-sized (CPU/free-mem/cap-4), abort-signal guard, additional-error logging, +2 tests. Callers in `src/tools/builtin/video.ts` updated to `await`. Verified: `grep -n runPool src/video/composer.ts` → 2 hits.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | hyperframes #3                                    | 0.5 sess (DONE) | Closes v7.4 S1 partial.                                                                 |
| A2  | ~~**Tool annotations — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on tool registry**~~ ✅ **DONE 2026-05-08 (L2)**. Added 4 optional hints to `Tool` interface + `getToolAnnotations()` normalizer with conservative MCP-spec defaults; helper also surfaces `requiresConfirmation`/`riskTier` for unified safety reasoning. **20 tools annotated** in this pass: file (3) + jarvis-files (7) + shell + file-convert + web-read + web-search + exa-search + code-search (4) + http + gmail (3). 23 tests cover defaults, roundtrip, per-tool assertions, and 3 logical invariants (`readOnly ⇒ NOT destructive`, `requiresConfirmation ⇒ NOT readOnly`, `riskTier:high ⇒ destructive`). Convention codified in `CLAUDE.md` ACI section. Verified: `grep -lE "readOnlyHint" src/tools/builtin/` → 9 files.                                | anthropic `mcp-builder` skill (Session 69)        | 0.5 sess (DONE) | MCP-spec field. Other 160+ tools follow the conservative defaults; annotate as touched. |
| A3  | ~~**Skill evaluation loop — draft → test with/without skill → grade → improve**~~ ✅ **DONE 2026-05-08 (L3)**. Shipped as `src/tuning/skill-eval-loop.ts` — `runSkillEval(skill, baselineSys, cases, inferFn)` runs each case twice (baseline / with-skill), grades `{text, evidence}` assertions (substring or RegExp), returns `SkillEvalReport` with per-case deltas + aggregate metrics + `recommendation` (adopt/refine/discard/reject). Heuristic downgrades adopt → refine for n<3. `emptyCaseIds` surfaces fixture gaps. NOT wired into cron — operator activates manually. +15 tests.                                                                                                                                                                                                                                                                     | anthropic `skill-creator` (Session 69)            | 1 sess (DONE)   | v7.5 anchored. Complements existing `src/tuning/` mutation pipeline.                    |
| A4  | ~~**RationalRewards — Prometheus reflector per-dimension critiques (replace pass/fail with evidence)**~~ ✅ **DONE 2026-05-08 (L3)**. `ReflectionResult.dimensions?: DimensionalCritique[]` — 5 axes (completion / correctness / evidence_quality / effort / domain_coverage). System prompt asks for the array; `sanitizeDimensions()` drops malformed entries; `lowestDimension()` picks the replan target. Dimensions auto-dropped when score-override pathway fires (audit W1) so they never contradict the kept score. +8 tests.                                                                                                                                                                                                                                                                                                                              | RationalRewards paper (Session 69)                | 0.5 sess (DONE) | v7.5 anchored. Improves Prometheus reflect signal quality.                              |
| A5  | ~~**RationalRewards — predictive consistency gate (rationale predicts outcome blind to answer)**~~ ✅ **DONE 2026-05-08 (L3)**. Shipped as `src/tuning/predictive-consistency.ts`. `runPredictiveCheck()` probes ≤3 cases per mutation, asking the LLM to predict pass/fail given ONLY the hypothesis + case message. Wired in `overnight-loop.ts` after eval, before keep/discard, opt-in via `TUNING_PREDICTIVE_CONSISTENCY=true`. Failed gate adds `'rejected'` status branch; does NOT bump `consecutiveRegressions` (audit W2). 0.5 boundary treated as fail (audit W3). +12 tests.                                                                                                                                                                                                                                                                           | RationalRewards paper (Session 69)                | 0.5 sess (DONE) | v7.5 anchored. Tightens skill-evolution validator.                                      |
| A6  | ~~**F7 — BM25 reflection memory** (per-agent banks; inject top-2 lessons from past P&L into next prompts)~~ ✅ **DONE 2026-05-08 (L6)**. `src/finance/reflection-memory.ts` — hand-rolled Robertson-Walker BM25 (no `wink-bm25-text-search` per CLAUDE.md). `ReflectionBank` + `addLesson`/`retrieveTop`/`formatLessonsBlock`/serialize-deserialize/`ReflectionRegistry`. Defensive IDF floor (audit S1), single-digit numerics preserved (W2), divide-by-zero guard (W1). 14 tests.                                                                                                                                                                                                                                                                                                                                                                               | `reference_trading_agents.md` (Session 69, ~220L) | 1 sess (DONE)   | F7 ships without it; this is an additive lift. Pure code, no API.                       |
| A7  | ~~**F7 — Adversarial critic pass** (single bull/bear critic over Portfolio Manager draft + judge reconciliation, ~150L)~~ ✅ **DONE 2026-05-08 (L6)**. `src/finance/adversarial-critic.ts` — `runAdversarialCritique()` runs bull + bear via `Promise.allSettled` (audit C1 — token-preservation on partial failure), then judge. Per-call `withTimeout` (default 30s), fail-open to draft on any error. Trust-model JSDoc on `context` field (audit W4). 13 tests including parallelism timing + C1 token-preservation regression.                                                                                                                                                                                                                                                                                                                                | `reference_trading_agents.md` (Session 69)        | 0.5 sess (DONE) | Same session as A6 — shared inference budget.                                           |
| A8  | ~~**F7 — Black-Litterman signal combiner** (multi-agent signals as views into posterior, mathjs, ~150L)~~ ✅ **DONE 2026-05-08 (L5)**. `src/finance/black-litterman.ts` — He-Litterman 1999 closed form (`posteriorμ = inv(M) · (inv(τ·Σ)·π + Pᵀ·inv(Ω)·Q)`, `M = inv(τ·Σ) + Pᵀ·inv(Ω)·P`, `posteriorΣ = Σ + inv(M)`). Public API: `blackLitterman()`, `blackLittermanFromSignals()` w/ Idzorek-style confidence→Ω mapping at canonical `τ·σ²/confidence` scale (audit W3/W4 fix), `equilibriumReturnsReverse()`. **No mathjs** — added `src/finance/matrix.ts` (Gauss-Jordan inverse w/ partial pivoting + matMul/transpose/diag/identity/add) per CLAUDE.md no-deps invariant. Non-diagonal Ω falls back from invertDiagonal to matInverse (W6). Configurable `epsilon` for τ·Σ conditioning (W5). δ≤0 rejected (W8). Mutation-discipline tested (W7). 49 tests. | `reference_skfolio.md` (Session 69)               | 1 sess (DONE)   | Replaces heuristic confidence-weighted sum.                                             |
| A9  | ~~**F7 — HRP weight allocator** (López de Prado hierarchical risk parity)~~ ✅ **DONE 2026-05-08 (L4)**. Shipped `src/finance/hrp.ts`. Full pipeline: correlation matrix → distance → single-linkage clustering → quasi-diagonal leaf order → recursive bisection by inverse-variance. Diagonal-only `clusterVariance` (skfolio mode; full slice-cov reserved for follow-up). 25 tests including hand-computed 4-leaf tie-break determinism + floating-point overshoot defense. Float-clamp also added at the source in `alpha-linalg.correlation()` (audit W2). Library-only — F7 callers wire when ready.                                                                                                                                                                                                                                                        | `reference_skfolio.md` (Session 69)               | 0.5 sess (DONE) | Replaces heuristic in ranking step.                                                     |
| A10 | ~~**F7 M1 — Inverse-vol + equal-weight baseline allocators** (~30L)~~ ✅ **DONE 2026-05-08 (L4)**. Shipped `src/finance/allocators.ts`. `equalWeight(N)`, `inverseVolatility(returns)` with median-variance substitution for flat assets + last-asset rounding-error absorb so weights sum to exactly 1. `varianceVector()` exported as shared helper used by both this module and HRP. 12 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `reference_skfolio.md` (Session 69)               | 0.5 sess (DONE) | Baselines exist before HRP ships, used as fallback.                                     |
| A11 | ~~**v7.4.3.6 — Skill gate markdown**~~ ✅ **DONE 2026-05-08 (L1)**. Shipped as `src/video/html-skills.ts` — 3 typed catalogs (`HTML_COMPOSE_SKILL_GATE`, `HTML_COMPOSE_HOUSE_STYLE`, `HTML_COMPOSE_VISUAL_STYLES`) + `htmlCompositionSkillSection()` injector wired into `video_html_compose` tool description after `motionVocabSection()`. Discoverable surface via `HTML_COMPOSE_SKILLS` const for v7.5 engine. +5 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                       | hyperframes #5                                    | 0.5 sess (DONE) | Was blocked on v7.5 — now closed.                                                       |

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

| Session | Items                       | Description                                                                                                            |
| ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| L1      | A1 + A11                    | ✅ DONE 2026-05-08 — v7.4 worker-pool wired + skill-gate shipped (`1b08c19`).                                          |
| L2      | A2                          | ✅ DONE 2026-05-08 — 20 tools annotated w/ MCP hints + invariant tests (`736a445`).                                    |
| L3      | A3 + A4 + A5                | ✅ DONE 2026-05-08 — skill eval loop + reflector dimensions + predictive gate (`ba0a088`).                             |
| L4      | A10 + A9                    | ✅ DONE 2026-05-08 — inverse-vol baselines + HRP (`33a54f5`).                                                          |
| L5      | A8                          | ✅ DONE 2026-05-08 — Black-Litterman + matrix primitives (`88f4839`).                                                  |
| L6      | A6 + A7                     | ✅ DONE 2026-05-08 — BM25 reflection memory + adversarial critic. **Tier-A backlog cleared.**                          |
| L7      | B1 + B2                     | **Ads API clients** — only when operator provisions FB + Google creds.                                                 |
| L8      | B3 + B4 + B5                | **Ads automation** — bid mgmt + CRM attribution + perf ritual. After L7.                                               |
| L9      | B6 + B7 + B8 + B9           | **AI media stack** — higgsfield + fal + ElevenLabs + lip-sync. After all 4 keys land. Otherwise split per key arrival. |
| LT      | C-tier items                | **Trigger-fire** — no scheduled session. Each item activates on its named signal. Re-check during weekly retros.       |
| LD      | D1 (optional), D2 (Phase δ) | **Phase-gated** — F10 only if crypto is requested; F11 only after F8 hits 30d positive paper record.                   |

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
