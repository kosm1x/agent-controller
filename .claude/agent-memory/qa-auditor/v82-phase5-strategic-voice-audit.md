---
name: v82-phase5-strategic-voice-audit
description: V8.2 Phase 5 strategic-voice prompt + cache-prefix audit (2026-06-03) — PASS WITH WARNINGS, Docker prompt_modules omission + substring identity-guard
metadata:
  type: project
---

# V8.2 Phase 5 — Strategic-voice prompt + stable cache prefix (2026-06-03)

Verdict: PASS WITH WARNINGS. Build clean, 53/53 tests pass, spec §10 block byte-identical to `prompt_modules/strategic_voice_principle_v1.md`. All 5 SDK call sites (decompose + 3 perspectives + synthesizer) correctly use `strategicVoiceSystemPrompt()` as the byte-identical systemPrompt and route per-call role/task text through `composeV82UserPrompt` into the user turn (mirrors flattenMessagesForSdk cacheable:false routing). Fully dormant — no live producer wires the libs in (grep for consumers outside /v8-2/ = empty).

## Findings (2 warnings, all forward-looking)

- **W1 (Docker prefix omission)**: `Dockerfile:37-39` copies dist/ + schema.sql + public/ but NOT `prompt_modules/`. `principleFilePath()` resolves `resolve("prompt_modules")` against cwd. Under systemd WorkingDirectory=/root/claude/mission-control this is correct (host path verified present). But a containerized runner (nanoclaw/heavy when HEAVY_RUNNER_CONTAINERIZED) has cwd=/app → `/app/prompt_modules/...md` missing → loader throws fail-loud. Dormant today. Fix at producer-wiring time: `COPY prompt_modules/ ./prompt_modules/` (mirror schema.sql precedent) or set MC_PROMPT_MODULES_DIR in container env. **General lesson: any new cwd-relative non-TS asset load (.md/.json/.sql under repo root) needs a matching Dockerfile COPY OR it silently works on systemd-host but throws in containerized runners.**
- **W2 (weak identity-guard test)**: `strategic-voice.test.ts:64-75` asserts each of the 7 principles via leading-clause substring only. An edit to a principle BODY (e.g. line 9 "Soft-pedaling truth..." text) passes silently. For byte-stability/identity-load-bearing text, a substring guard is too weak — recommend full-string `toBe` against a golden OR a pinned SHA-256 of trimmed content, forcing a deliberate `..._vN.md` version bump on any byte change. **General lesson: when a test guards "byte-identical / must-not-drift" text whose whole point is exact stability (cache key, identity block), substring/`toContain` assertions are a false sense of coverage — use full-string equality or a content hash.**

## Verified-correct (challenged design claims that held)

- Memoization is race-free: no await between the `cachedPrinciple!==null` guard and assignment; readFileSync is sync → single-threaded Node cannot interleave a concurrent first-call. The "bogus dir after first load" memo test genuinely proves no-re-read (a re-read would throw).
- Harness `verify-v82-cache.ts` ratio math correct: claude-sdk.ts:540 accumulates promptTokens = input + cacheCreation + cacheRead (all three), so cacheReadTokens ⊆ promptTokens; denominator right. Token burn guarded (requires --run/env; default dry returns 3). ~436-tok prefix < 1024 min → pre-warn fires, cacheRead≈0 documented EXPECTED (honest §10 caveat, NOT incompleteness).
- `JUDGMENT_CITATION_CONTRACT_V1` faithful to spec §9; kept OUT of the byte-stable identity block by design (versions independently) — documented divergence from §9 build-note's "wire into §10 prompt" phrasing, correct call. Dormant-by-design, not dead code.
- nudge/diversity-retry reaches synthesizer in the VARIABLE user body (buildSynthesizerPrompt), correctly NOT in the cached prefix.
- multi-option dispatch-by-shape mock still correct after system→user move: detectRole keys on DEVIL/SEEKER markers now in opts.prompt; synthesizer still detected via extraTools.length>0.

Pin: [[cache_prefix_variability]], [[sdk_systemprompt_single_cache_block]], [[v82-phase2-decompose-audit]], [[v82-phase3-multioption-audit]].
