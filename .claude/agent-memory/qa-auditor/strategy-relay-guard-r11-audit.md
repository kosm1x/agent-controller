---
name: strategy-relay-guard-r11-audit
description: R11 allow-by-shape rewrite of isStrategyRelayOrReadback verified 2026-09-05 — PASS-WITH-NOTES, 0 Criticals, 11/11 folds RED; doctrine on closing every slot of a shape.
metadata:
  type: project
---

# R11 — `isStrategyRelayOrReadback` (classifier.ts), 2026-09-05

Verdict PASS-WITH-NOTES. Corpus replay 0/220 mismatches; 11/11 planted mutants ≥1 RED
(a=18, b=4, c=4, d=4, e=1, f=1, g=1, h=1, i=2, j=2, k=1); 310 tests green; tsc 0.

## Doctrine crumbs

- **Rounds 1–10 chased a deny-list; R11 won by inverting to allow-by-shape with BOTH
  ends anchored (`^ … $`) and EVERY slot a closed class.** After ten rounds of
  "one more verb / one more separator", the fix that finally held was structural:
  consume the whole head clause, and let anything unlisted fall through to the
  status quo (heavy). This is the same lesson as [[flag-deny-never-converges]].
- **A case-SENSITIVE marker inside a case-blind pipeline needs BOTH sides pinned.**
  `RECIPIENT_NAME` = `/\b(a|to)\s+…\p{Lu}\p{L}*/gu` — the *lowercase* `(a|to)` is what
  makes ALL-CAPS and Title-Case input safe (0/140 pinned-heavy rows flip under either
  register; I replayed the whole heavy corpus uppercased and title-cased). Had the
  literal been `[Aa]`, shouting would have demoted every `a mejorar` row. Verify a
  case-sensitive gate by replaying the corpus in the OTHER registers, not by reading it.
- **Closing a slot moves the attack to the slot's neighbour.** Every residual false-FAST
  I could build lives in the two slots that must stay open to be useful: `TOPIC_PP`
  (3 free tokens — topics naturally contain infinitives: "para ganar el draft" is a
  PINNED fast) and `NP_ADJ`'s `\p{L}+(ad[ao]s?|id[ao]s?)` participle (an existence
  marker that also spells "mejorada"/"rehecha"). Both were accepted deliberately.
- **A participle carrying its own complement is blocked, which is what keeps the
  participle class a Warning** — `NP_ADJ` is followed only by `TAIL`, and `CON_PP` is
  reachable only after a `TOPIC_PP`, so "la estrategia mejorada con precios nuevos"
  and "la estrategia ajustada a los nuevos precios" both fall to heavy. Verified.
- **Harness note**: a mutant copy of `src/` under `/tmp` cannot resolve `better-sqlite3`
  (classifier → db/task-outcomes → db/index). Symlink the repo's `node_modules` into the
  mutant root and copy `package.json`; then `import()` the mutant path under `tsx`.
  Top-level `await` needs an `async main()` wrapper (tsx emits CJS for a bare `.ts`).
