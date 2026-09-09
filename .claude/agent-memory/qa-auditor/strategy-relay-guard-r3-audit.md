---
name: strategy-relay-guard-r3-audit
description: R3 verification of the strategy relay/readback fast-runner demotion in src/dispatch/classifier.ts (2026-09-05) — PASS-WITH-NOTES, 0 Critical
metadata:
  type: project
---

# strategy-relay guard — R3 (2026-09-05)

Verdict **PASS-WITH-NOTES**, 0 Critical / 5 Warning. R1+R2 corpus replay 61/62
matches (the 1 miss, "Reseña la estrategia del trimestre" → heavy, was
pre-flagged as legitimate: `reseña` is in neither RELAY_VERB nor
READBACK_OPENER). All 6 R2 folds VERIFIED FIXED behaviourally; 5 of 6 pinned.

## Doctrine crumbs

- **Two overlapping guards, only the broader one is pinned.** Mutation (e)
  (revert `opensWithReadback` first-clause → `.some` over clauses) left
  **0 RED / 150**. Reason: the multi-clause cases it was written for
  ("Muéstrame la estrategia … y compárala …") are joined by `y`/comma, and the
  clause split is `[.!?;:\n]+` — commas are NOT separators, so those strings are
  ONE clause and REWORK_OR_ANALYSIS is what actually rejects them. The
  first-clause rule is still behaviour-bearing (`"Rehaz la estrategia desde
  cero. Dame el doc"` → heavy today, fast under `.some`) — it is simply
  untested. **When two folds land in the same round, mutate each and check the
  RED sets are DISJOINT; an overlapping pair hides an unpinned member.**
- **A verb-stem blocker collides with nouns/adjectives sharing the stem.**
  `(?:mej[oó]r|arm|aj[uú]st|…)(?:a|e|en|es|…)` fires on `mejores` (best),
  `mejora` (improvement), `arma` (weapon), `ajuste` (adjustment). EN
  `update|change|review` + `(?:s|d|ed|ing)?` fires on the nouns/participles
  `update`, `changes`, `updated`. Every one of these fails toward the status
  quo (heavy) — so Warning, not Critical — but they erase the demotion on the
  exact production shape it was built for.
- **A single-token lookbehind exempts only the adjacent spelling.**
  `(?<!\b(?:for|to)\s)` saves "for review" and nothing else: "for a review",
  "for final review", "for later review" and "for&nbsp;&nbsp;review" (two
  spaces) all fire. A test that pins only the adjacent form proves nothing about
  the class.
- **A lead-in strip that stops at the first unlisted char can leave a
  punctuation-only first clause.** `"Hola Jarvis 👋. Dame la estrategia"` →
  body `"👋. Dame…"` → first clause `"👋"` → no opener → heavy. The strip's
  trailing char class `[\s,.!¡¿?:;-]*` has no emoji, so the emoji survives and
  the following `.` becomes the clause boundary.
- **A determiner-adjacency proxy for definiteness dies on any adjective.**
  `\b(?:la|el|…)\s+estrateg\w*` rejects "la última estrategia" / "the updated
  strategy" — a second, independent blocker that the report must separate from
  the REWORK one (probe each predicate individually, don't infer from the
  runner verdict).
- Perf on a 5,012-word adversarial input (34 KB): DESIGN_TARGETS_STRATEGY
  0.42 ms, REWORK_OR_ANALYSIS 0.002 ms, needsHeavyReasoning e2e 0.26 ms. The
  lazy `(?:\s+\S+){0,3}?` bridge does not backtrack pathologically.

## Method that worked

Mutation copy at `src/dispatch-mut/` (classifier.ts + classifier.test.ts copied,
`keywords.ts` symlinked to the real one so the transitive `../db` / `../runners`
imports resolve), driven by a python harness that mutates the CALL SITE
(`DESIGN_TARGETS_STRATEGY.test(t)` → `false`) rather than the regex literal —
anchor-miss raises instead of silently no-op'ing. Sources md5-verified untouched
afterwards; scratch dir removed before the final `git status`.

## Mutation matrix (RED / 150)

a DESIGN_TARGETS_STRATEGY inert 2 · b REWORK_OR_ANALYSIS inert 9 ·
c drop DEFINITE_STRATEGY 6 · d revert lead-in strip 5 ·
**e revert first-clause→.some 0 (UNPINNED)** · f revert clitic RELAY_VERB stems 6.
