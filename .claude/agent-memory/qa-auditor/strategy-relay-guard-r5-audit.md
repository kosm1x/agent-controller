---
name: strategy-relay-guard-r5-audit
description: R5 verification of the strategy relay/readback fast-demotion guard in src/dispatch/classifier.ts (2026-09-05) — R4 folds all mutation-RED and the R4-C1 regression is fixed, but 3 structural false-FAST classes remain (re- prefix, proclitic/subordinate position, unlisted rework verbs)
metadata:
  type: project
---

# strategy relay/readback guard — R5 (2026-09-05)

Verdict: **FAIL** (3 Critical false-FAST classes). R4-C1 regression: **VERIFIED FIXED**.

## What held
- Corpus replay 107 strings (48 fast pins + 52 heavy pins + 6 R4-C1 probes + 1 swarm probe): **0 mismatches**.
- Mutation matrix, all 6 folds RED against 190 tests: clause-initial ES branch 4 RED · clause-initial EN branch 2 RED · R4-W1 verbs 7 RED · periphrastic-future lookaheads 3 RED · `adaptad[ao]s?` 1 RED · `opensWithReadback` → `.some` 1 RED. No unpinned fold.
- Perf on 5k adversarial words: every regex < 0.3 ms; `needsHeavyReasoning` 0.58 ms.

## The class that keeps recurring (round 5 of the same regex)
The guard **admits** on shape (definite noun + relay verb + destination, or readback opener)
and **denies** on an ENUMERATED verb list (`REWORK_OR_ANALYSIS`, `DESIGN_TARGETS_STRATEGY`).
Any rework/formulate verb the list does not spell reaches the fast runner. R1→R4 each
added verbs; R5 found 30+ more misses in one pass. Three are structural, not vocabulary:

1. **The Spanish/English `re-` prefix defeats the DESIGN list.** `\bformul`, `\bplante`,
   `\bdefin`, `\belabor`, `\bconstruy`, `\barm`, `\bcre` never match `reformula`,
   `replantea`, `redefine`, `reelabora`, `reconstruye`, `rearma`, `recrea` — JS `\b` sits
   before `re`, not before the stem. `redise[ñn]` is hand-special-cased in BOTH lists,
   which is the tell the authors hit one member of the family and stopped. `re-design`
   (hyphen = word boundary) is caught; `redesign` is not — it only routes heavy because
   the separate `\bredesign\b` HEAVY pattern makes `matched.length === 2`.
2. **Proclitic + subordinate clause.** The homograph branch accepts finite+determiner,
   enclitic (`mejórala`), clause-initial and after `y`. Spanish puts the object pronoun
   BEFORE a finite verb in subordinate clauses — `cuando la mejores`, `ya que la ajustes`,
   `si la cambias`, `una vez que la completes` — none of those positions match.
3. **`vuelve a` + non-design verb**: `vuelve a hacer/escribir la estrategia` is a redo the
   list cannot see (`escribe` is itself a RELAY verb).

Recommended architecture (not a 6th verb round): make the demotion require that the
message's ONLY verb targeting the noun is a relay/readback verb — allow-by-membership on
the admit side — instead of denying an open-ended verb vocabulary.
See [[feedback_flag_deny_list_never_converges]] in the operator memory index.

## Reusable crumbs
- A pin can be green because a SIBLING pattern fires: `isStrategyRelayOrReadback` returns
  TRUE for "Redesign the strategy and put it in the doc"; only the second heavy cue saves
  it. Assert the guard's own return value, not just the runner, when pinning.
- Live corpus for this feature is 4 rows (`tasks` titles matching the strategy noun);
  frequency cannot justify a vocabulary gate. Check corpus size before weighting.
- Mutation harness: copy `src/` + `package.json` + `tsconfig.json` + `vitest.config.ts`
  into scratch and **symlink** `node_modules`; vitest runs there unchanged and the real
  tree is never touched (`md5sum -c` afterwards).
