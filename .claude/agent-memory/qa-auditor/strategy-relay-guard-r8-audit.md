---
name: strategy-relay-guard-r8-audit
description: R8 verification of isStrategyRelayOrReadback (BENIGN_FRAGMENT two-token cap + CLITIC_VERB + discourse markers + `del`) — FAIL, 1 Critical false-FAST through the SIBLING alternative the fold did not cap
metadata:
  type: project
---

# R8 — strategy relay/readback guard (2026-09-05)

Corpus replay 176/176 clean (158 pinned + 18 R7 probes). prettier/tsc/`vitest run src/dispatch/classifier.test.ts` (248) green; regexes < 3 ms on 190 KB adversarial input.

## Crumbs (generalizable)

- **A cap applied to one alternation branch leaves its SIBLING uncapped.** R7 flagged
  `PREP + [^,]{1,40}`; R8 capped exactly that branch to `det? + <=2 tokens` and left the
  APPOSITIVE branch of the same regex (`${DEFINITE_NP}(?:\s+(?:de|del|para|of|for)\s+[^,]{0,30})?`,
  classifier.ts:516) with the identical unbounded tail — so the pinned-heavy rework imperative
  ("… ponla al día", "rehazla") rides in through the sibling and demotes to FAST. When a fold
  narrows one alternative, diff EVERY alternative of the same regex for the same shape.
- **A fold can be 0-RED over the corpus and still be live-load-bearing.** Removing the whole
  discourse-marker class from SECOND_ACTION left 176/176 GREEN — every pinned R7-C1 string is
  already blocked by the two-token cap. The markers' only live effect is on UNPINNED shapes
  (2-token "…, de paso ajusta" → correct heavy; "…, primero/finalmente" mid-sentence → FALSE
  heavy). Pin a fold with a string the SIBLING folds do not also kill (mutant-by-mutant check).
- **A blocker matched anywhere in the sentence pays for its position-specific intent.**
  `primero|first|finalmente|finally` were added for the post-comma "…, por cierto arma…" shape
  but are tested globally, so plain relays escalate: "Manda la estrategia por correo primero",
  "Send me the strategy first", "Dame la estrategia finalmente aprobada" → heavy. Anchor a
  position-specific marker class to its position.
- **A vowel-final stem class misses the vosotros imperative.** `CLITIC_VERB` (`\p{L}+[aáeé]` +
  clitic) catches usted ("revísela"), voseo ("mandámela") and tú forms, but not `-ad/-ed/-id`
  ("revisadla", "ponedla", "hacedlo") — the stem ends in `d`. Low risk for an MX operator.
- **Widening a preposition list to fix one idiom also admits the genitive.** `del` was added to
  RELAY_DESTINATION for the POSITION idiom "al final del doc"; it also makes the SOURCE genitive
  a destination ("Escribe la estrategia del doc/del KB" — heavy before, fast now).
- Scratch-mutation recipe that keeps the tree clean: copy classifier.ts to the scratchpad with
  its 3 relative imports rewritten to absolute paths, run the replay against `MC_CLASSIFIER`.
  `md5sum -c` the sources afterwards.
