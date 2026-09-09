# Usability Phase 1 R3 — R2 folds verified + what they broke (2026-08-23)

Scope: same bundle (`scope-miss.ts`, `router.ts`, `telegram-stream.ts`,
`prompt-sections.ts`, `scope-classifier.ts`, `fast-runner.ts`). tsc clean;
`src/messaging` + `src/skills` = 1159 pass / 31 files.

**Verdict: PASS WITH WARNINGS — 0 Critical, 5 Warnings, 1 Standards violation.**
All 9 R2 folds land. Detector re-replayed independently: 25 hits / 0 FP /
1 known miss (12021, ask beyond the 700-char tail) ⇒ recall ~96%.

## Doctrine (transferable)

1. **A weak/strong distinction added to ONE branch of a detector consumer must be
   added to its SIBLING branches.** R2's C2 fold taught `rerunWithWiderScope` to
   deliver a weak scope MENTION as-is — but the sibling `else if (miss)` arm
   (router.ts:2661-2667, re-run replies + background-agent replies) still
   REPLACES the whole reply with a canned line and never consults `miss.strong`.
   A correct answer that happens to end "…no tengo OCR en este scope" becomes
   "No pude usar la herramienta que esto necesita ni al reintentar" — a false
   statement plus total content loss. **Rule: when you add a
   guard-condition/parameter to a handler, grep every OTHER call site of the
   same detector and ask whether the new condition applies there too.**
2. **A re-submitted turn writes a SECOND telemetry row whose `message` is
   router-authored — and the tuning corpus reads that column as if a user typed
   it.** `recordScopeDecision("[scope-miss rerun] " + originalText, …)`
   (router.ts:3390) feeds `case-miner.ts:355` (`SELECT message, tools_called
   FROM scope_telemetry …` → pinned positive eval case) and
   `flywheel-bridge.ts:58` (praised task → pinned case). Neither filters the
   prefix. **Rule: before writing a synthetic row into a table, grep every
   SELECT of the column you are synthesizing — a prefix is not a filter unless
   someone filters on it.**
3. **A Critical fixed by "return separate objects" needs an identity assertion,
   not a value assertion.** Mutation: re-alias `decideActiveGroups`' inherited
   branch (`const shared = new Set(prior); return {groups: shared, base: shared}`)
   ⇒ 119/119 tests still GREEN. The R2 C1 fix is unpinned; the only pin is the
   author's memory. A killing test must MUTATE the returned `groups` and assert
   `base` unchanged (`d.groups.add("x"); expect(d.base.has("x")).toBe(false)`).
   Mutation `strong: STRONG_ASK_RE.test(tail)` → `false` DOES kill 12465's test.
4. **`mockResolvedValueOnce` queued and never consumed leaks into the NEXT
   test.** Under mutation 3 the 12465 test stopped consuming its queued re-run
   value and the *following* test (11723) failed too — its `handleInbound` got
   `taskId: "test-task-halluc"` so `task.completed` for `test-task-123` found no
   pending reply. Cascade failures in this suite are not independent evidence;
   read the first RED, not the count.
5. **The placeholder-close fix landed only on the path that was being touched.**
   `armPendingTimers(..., {rerun:true, stream})` closes the ⏳ on abandon
   (router.ts:3296-3303) — but the FIRST run calls it with no opts
   (router.ts:2238-2243) although `streamController` is in scope, so an
   abandoned first turn still leaves a live caret placeholder + a separate
   timeout message. Pre-existing, now asymmetric.

## Verified-good (do not re-flag)

- C1 fold real: all four `decideActiveGroups` returns hand out a fresh `base`
  Set (router.ts:428-459). Only residual aliasing: the non-sticky semantic
  branch returns the CALLER's `semanticGroups` as `groups` — harmless, the
  classifier has no cache and the router does not reuse the var.
- C2 fold real: `spec.tools` IS the post-`applyCommunityChannelScopeOverride`
  list (router.ts:2062-2064 assigns `tools` before the spec captures it), so
  `missing` is computed against what the first run actually had. The correction
  note does NOT contradict `## REGLA CRÍTICA` — that section's second paragraph
  ("si la herramienta SÍ aparece en tu lista, está autorizada") says the same
  thing. No loop: re-run pending (router.ts:3447) carries `rerunOf`, no
  `rerunSpec`.
- W4 fold real: `buildDescription` re-runs `buildJarvisSystemPrompt(widenedTools,…)`,
  which recomputes the tool-gated skills block (`listSkillsForTools(tools)`,
  router.ts:324) and every flag-gated protocol section. Captured `variableTail`
  (patternBlock from the FIRST turn's activeGroups + checkpointBlock) is stale
  by one widening — cosmetic.
- W1/W2/W3/W5/W6/W7 land. Independent 45d replay: 813 router exchanges,
  25 hits (23 strong / 2 weak: 12464, 11723 — both correctly delivered as-is),
  93 undetected candidates, 11 with an ask-shaped marker, **none a real ask**.

## Reproduction commands

- Replay: `npx tsx` script importing `detectScopeMiss` +
  `getAllAvailableTools` by ABSOLUTE path with
  `createRequire("/root/claude/mission-control/package.json")` for
  better-sqlite3 (scratchpad scripts cannot resolve the project's node_modules).
- Mutation harness: back up to scratchpad + `md5sum -c` to restore; two
  python3 in-place replacements; `npx vitest run src/messaging/router.test.ts
  src/messaging/scope-miss.test.ts --reporter=dot`.
