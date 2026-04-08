---
name: v6.4 CL1 Comprehension Layer Audit
description: Audit of CL1 (5 components): semantic scope classifier, precedent resolution, ASSUME mode, normalization, triggerPhrases. Key bugs found.
type: project
---

## v6.4 CL1 Comprehension Layer — Audit 2026-04-07

**Commit**: ca02f6b — 16 files, 631 lines added
**Verdict**: PASS WITH WARNINGS

### Critical Issues (1)

1. **scope.ts line 352**: `preClassifiedGroups.size >= 0` always true — empty Set bypasses regex fallback. Router wrapper masks this via its own `size > 0` check, but scope.ts is exported and used by eval-runner. Should be `size > 0`.

### Warnings (5)

1. **Double LLM call on non-PASS**: enhancer `analyzePrompt()` + classifier `classifyScopeGroups()` both call `infer()` — potentially 2 LLM calls per message when enhancer returns ASK/SPLIT. However, the enhancer returns before scope classification if it blocks (returns early at router line 1033), so only PASS messages reach the classifier.
2. **setTimeout leak**: scope-classifier creates a `setTimeout` deadline promise but never clears it if `infer()` resolves first. Timer remains dangling for up to 3s. Same pattern in prompt-enhancer (10s and 15s timers).
3. **normalizedText used for classifier but msg.text for scope**: Router passes `normalizedText` to `classifyScopeGroups()` (line 1179) but `msg.text` (original) to `scopeToolsForMessage()` (line 1185). When classifier times out and regex fallback runs, the regex sees the un-normalized text — typos won't match regex patterns.
4. **precedent.ts taskRef regex greediness**: Pattern `/(?:tarea|task|reporte|report|schedule)\s+["']?([^"'\n,]{3,40})["']?/gi` captures entire match including the keyword, not the capture group — `.match()` returns full matches, not groups.
5. **No precedent tests**: `precedent.ts` has zero test coverage.

### Standards Violations (1)

1. **ASSUME assumption text is discarded**: ASSUME decision logs the assumption but never surfaces it to the user or injects it into the system prompt. The user gets no signal that Jarvis interpreted their ambiguous message with a specific assumption. The comment says "The LLM receives the assumption as precedent context" but no code does this.

### Pattern Note

- The router+scope.ts dual `scopeToolsForMessage` naming (one wrapping the other via alias) is confusing but not blocking.
- triggerPhrases add ~20-40 chars per deferred tool to catalog. With ~25 deferred tools, this adds ~500-1000 chars — acceptable.
