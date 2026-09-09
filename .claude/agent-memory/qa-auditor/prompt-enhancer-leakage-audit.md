---
name: prompt-enhancer-leakage audit (2026-05-07)
description: Audit of RC1-RC5 fixes preventing raw LLM output leaking as clarifying questions in src/messaging/prompt-enhancer.ts + router.ts
type: project
---

# prompt-enhancer-leakage audit — 2026-05-07

**Scope**: `src/messaging/prompt-enhancer.ts`, `src/messaging/router.ts:1330-1405`, `src/messaging/prompt-enhancer.test.ts` (new groups only).

**Verdict**: PASS WITH WARNINGS. Leak closed; 5 warnings + 3 recs.

## What landed

- **RC1** — parse failure → returns `"PASS"` (not `raw`). `prompt-enhancer.ts:282-292`.
- **RC2** — SPLIT path returns typed marker `"SPLIT:${plan}"`; router strips at `router.ts:1370-1384` and frames as `📋 Plan sugerido:`.
- **RC3** — cold-start guard: `decision !== PASS|ASSUME && recentContext.trim() < 50 && clarity >= 5 → PASS`. Lines `:300-310`.
- **RC4** — ASK count = `lines.filter(l => /^\s*\d+[\.\)]\s/.test(l)).length`. `router.ts:1397-1400`.
- **RC5** — `parseCiricdResponse` rejects non-string and non-enum decisions. `:218-230`.
- 12 new tests; all 32 pass.

## Real risks identified

**W1 (most important)**: cold-start guard ignores `risk=high`. Destructive first-message after `/compact` or fresh channel will PASS instead of ASK. Suggest `risk !== "high"` in the predicate.

**W3**: SPLIT marker collision — `splitPlan` starting with `"SPLIT:"` would double-prefix; router only strips first occurrence. Probability low; sanitizer is one-line.

**W4**: SPLIT path calls `setWaiting(channel, original, plan)` storing plan in `questions` slot. On user reply, `buildEnhancedPrompt` receives plan-as-questions; builder semantics undefined. No e2e test.

**W5**: Router-level branches (ASSUME/SPLIT/ASK/PASS ordering) untested. Reordering the `else if` chain regresses silently.

## Pattern: leakage-prevention bundles

When auditing "raw LLM output reaches user" fixes:
1. **Trace every return** in the analyzer — confirm none return `raw`/`result.content` directly.
2. **Check marker collision** — typed prefixes (`SPLIT:`, `ASSUME:`) need a sanitizer if the inner content could ever start with the marker.
3. **Check state-machine downstream** — `setWaiting` stores the message that gets fed back into the builder; type confusion (plan-vs-questions) bypasses leak fix without restoring it.
4. **Verify producer/consumer regex pairs** are tested together — RC4 regex is fine because RC2's formatter is fixed, but they're in different files.
5. **Cold-start / empty-context guards** need risk-tier carve-outs — destructive first messages need protection.
