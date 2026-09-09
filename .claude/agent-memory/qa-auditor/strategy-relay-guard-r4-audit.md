---
name: strategy-relay-guard-r4-audit
description: R4 verification of the strategy relay/readback fast-runner demotion in src/dispatch/classifier.ts (2026-09-05) - FAIL, 1 Critical false-FAST introduced by the R3 homograph fold
metadata:
  type: project
---

# R4 - strategy relay/readback guard (src/dispatch/classifier.ts, uncommitted)

**Verdict: FAIL (1 Critical).** All seven R3 folds are mutation-RED and the whole
corpus replays clean (81 test strings + 30 R3 probes x2 spellings = 0 mismatches,
171/171 green, prettier/tsc green, <1.5 ms on 5k adversarial words). The FAIL is a
NEW false-FAST the R3-W2/W3 fold itself introduced.

## The Critical (proven new, not inherited)

`REWORK_OR_ANALYSIS` classifier.ts:501 gates homograph stems on the determiner
being **adjacent**: `(?:mej[oo]r|arm|aj[uu]st|c[aa]mbi|rev[ii]s)(?:a|e|en|es|emos)\s+${ES_DET}`.
One intervening word defeats it. The corpus pins
`"Revisa la estrategia y mandamela por correo"` HEAVY; `"Revisa **bien** la
estrategia y mandamela por correo"` goes **FAST**. Same for `Mejora un poco...`,
`Ajusta un par de cosas...`, `Cambia todo en...`, and on the EN branch (:504)
`Review carefully the strategy...`, `Update pricing in the strategy...`.
Attribution proven by re-running the probes under mutation (c)/(c2) - the pre-fold
bare-finite regex routed all six HEAVY.

**Doctrine: "imperative position" is not "verb + determiner".** Spanish and
English both allow an adverb / quantifier / object between an imperative and its
article. Test any positional gate by inserting ONE adverb into the fold's own
pinned string.

**Verified fix** (171/171 stay green, all six close, corpus unchanged): union the
determiner branch with a **clause-initial** branch -
`(?:^|[.!?;:\n,]\s*|\by\s+)(?:stems)(?:a|e|en|es|emos)\b` (EN: `...|\b(?:and|then)\s+`).
Clause-initial is what "imperative position" actually means, and it still rejects
`los mejores jugadores` / `de mejora continua` / `el ajuste de precios` /
`the strategy update` / `for final review`, which sit mid-clause.

## Pre-existing false-FAST (all rounds, not this fold)

A rework verb ABSENT from the stem list + a relay destination => fast:
`Rehaz la estrategia desde cero y ponla en el doc`, `Corrige...`, `Reescribe...`,
`Simplifica...`, `Agrega dos jugadores a...`, `Rewrite the strategy and put it in
the doc`, `Expand the strategy and save it to the KB`. Note the R3-W1 pin
`"Rehaz la estrategia desde cero. Dame el doc con lo que salga"` passes for a
DIFFERENT reason than it claims: `Rehaz` is caught by nothing - the string is
heavy only because `Dame el doc` has no `preposition + doc` destination. **A pin
that goes green for the wrong reason does not cover the verb it names.**

Also pre-existing: the status-question opener `(?:en\s+qu[ee]|c[oo]mo)\s+(?:va|vamos|est[aa])`
(:480) admits the periphrastic future - `Como va a ser / va a quedar la estrategia?`,
`How is the strategy going to change?` -> FAST - while the design deliberately
excludes `cual sera` for exactly that intent. Same rule, two spellings, opposite
outcomes.

## Mutation matrix (scratch copy, 171 tests)

a DESIGN_TARGETS_STRATEGY inert = 2 RED - b REWORK_OR_ANALYSIS inert = 13 -
c ES homograph det-gate reverted = 4 - c2 EN det-gate reverted = 6 -
d EXISTING_ADJ removed = 2 - e opensWithReadback `.some` = 1 -
f clause-skip -> `[0]` = 1 - g pleasantries removed = 1. **No fold is unpinned.**

## Method notes

- Mutation harness: `cp -r src` + `package.json`/`tsconfig`/`vitest.config` into
  scratch, `ln -s` the real `node_modules`, then `npx vitest run <file>` from the
  scratch root. Sources never touched (`md5sum -c` clean before/after).
- Anchor-check every mutation string BEFORE running (`split(from).length-1 === 1`)
  - an anchor miss silently produces a 0-RED "finding".
- Replaying probes under a mutation is how you tell a NEW false-FAST from an
  inherited one; without it every miss looks like the current round's fault.
