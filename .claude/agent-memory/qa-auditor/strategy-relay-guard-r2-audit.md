# strategy-relay-guard-r2-audit (2026-09-05)

Target: uncommitted `src/dispatch/classifier.ts` + `classifier.test.ts` — R1 folds for
`isStrategyRelayOrReadback` (definite/indefinite gating, lead-in strip, design-verb block).
Verdict: **FAIL** — 1 R1-listed expected-fast input still routes heavy; 2 new mechanisms
mis-fire; the INDEFINITE fold is unpinned by any test AND is the cause of the mis-fires.

## Doctrine crumbs

1. **JS `\b` is ASCII-only, so a bare `a` alternative in a Spanish regex fires on the LAST
   LETTER of the previous word.** `INDEFINITE_STRATEGY` (classifier.ts:455) lists `|a|an|`
   among the indefinite articles. `/\ba\s/.test("Envía la")` === **true** (the `í` is a
   non-word char to ASCII `\b`, so "Enví|a" opens a boundary). Every ES verb ending in an
   accented vowel or `ñ` + `a` — envía, diseña, reseña, enseña, confía, guía — reads as
   "a <noun>". The `u` flag does NOT fix `\b`. Fix: drop `|a|an|` or gate them behind
   `(?<![\p{L}])` with `/u`.
2. **A test can pass on the WRONG guard.** The C3 case "Diseña la estrategia y ponla en un
   doc" was added to pin `DESIGN_TARGETS_STRATEGY`; neutralizing that regex left it GREEN —
   it is actually blocked by the `Diseñ|a` artifact from crumb 1. Mutation (a) turned only
   ONE of the two C3 cases RED. Always mutate the fold, not just add a case that "should"
   exercise it.
3. **A bounded gap window swallows the destination's own article.**
   `(?:\S+\s+){0,2}?` between the article and the noun means "Escribe en **un doc la
   estrategia**" reads as an indefinite strategy. ES verb+destination+object word order is
   ordinary, so the guard silently declines to demote it.
4. **The full mutation matrix is the only way to see a dead fold.** Dropping
   `INDEFINITE_STRATEGY` entirely → **0/126 RED**: `!DEFINITE_STRATEGY` already rejects every
   indefinite case in the suite. The block is pure liability. `DEFINITE` → 1 RED,
   `READBACK_LEAD_IN` → 3 RED, `DESIGN_TARGETS_STRATEGY` → 1 RED.
5. **A verb-stem sweep must cover the ACCENTED clitic form, not just the clitic.** W2 added
   `\w*` stems for envía/manda/guarda/sube but left `compart\w*`, `peg[aá]\w*`,
   `copi[aá]\w*`, `vuelc\w*`, `transcrib\w*`, `export\w*` unable to match
   compártela/pégala/cópiala/vuélcala/transcríbela/expórtala — Spanish REQUIRES the accent
   once a clitic is attached, so the plain stem never sees the real spelling.
6. **`opensWithReadback` splits on clauses, so ONE benign clause licenses the whole
   message.** "Muéstrame la estrategia y compárala con la de la competencia" and
   "What is our strategy for Q4 and how should we adapt it?" demote to fast. Per-clause
   splitting was the W1 fix for lead-ins; it also widened the admit side.
7. **Definiteness is a weak proxy for existence.** "Escribe la estrategia de draft para 10
   equipos en un doc" (a strategy that does not exist yet) demotes to fast — the same shape
   as the pinned motivating case. Rework verbs (actualiza/mejora/ajusta/revisa/optimiza/
   refina) are absent from `DESIGN_TARGETS_STRATEGY`, so every "improve the strategy and
   save it" demotes too.
8. **Direction matters for severity.** False-HEAVY here is the pre-change status quo (the
   cost bug simply persists); false-FAST is NEW behaviour the change introduces. Score them
   differently.
9. Mutation harness that never touches the source: `cp classifier.ts __mut_classifier.ts` +
   `sed 's#./classifier.js#./__mut_classifier.js#' classifier.test.ts > __mut_classifier.test.ts`,
   run scoped vitest on the mut file, `rm` both, `md5sum -c` the originals.
10. No ReDoS: all four regexes are bounded; worst 7.8 ms on a 40 KB adversarial input.
