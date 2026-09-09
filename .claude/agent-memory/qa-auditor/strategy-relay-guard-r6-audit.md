---
name: strategy-relay-guard-r6-audit
description: R6 verification of the INVERTED (allow-by-shape) strategy relay/readback guard in src/dispatch/classifier.ts — 0/157 corpus mismatches, 2 unpinned folds, comma-asyndeton + missing coordinators are new false-FASTs
metadata:
  type: project
---

# R6 — strategy relay/readback guard, allow-by-shape inversion (2026-09-05)

Verdict FAIL (2 Critical, false-FAST). Corpus replay 0/157 mismatches (51 fast pins + 71 heavy pins
+ 31 R5 heavy probes + 3 R5 fast + 1 swarm). `npx vitest run src/dispatch/classifier.test.ts` 212/212,
tsc + prettier clean.

## The doctrine crumb

**Inverting a deny-list to allow-by-shape moves the leak from the VERB axis to the SEPARATOR axis.**
R1–R5 chased verbs (reformula/pule/tweak…); R6's inversion kills that class dead (all 31 R5 verb
probes route heavy) — and the same "second action" now arrives through punctuation instead:

- The clause splitter is `t.split(/[.!?;:\n]+/)` — **the comma is not a separator**, and `SECOND_ACTION`
  lists conjunctions only. So `<relay verb> … , <rework imperative>` demotes to FAST:
  "Manda la estrategia por correo, mejora los precios primero" (the pinned-heavy twin is the SAME
  string with `pero` added — that is the tell), "Pon la estrategia en el doc, agrégale dos jugadores",
  EN "Send me the strategy by email, add the new prices".
- `SECOND_ACTION` has `y|and|pero|but|sino` but **no disjunction/copulative** `o|u|e|ni|or|nor`:
  "Dame la estrategia o arma el plan de precios" → fast.
  Verified fix `\b(?:y|e|o|u|ni|or|nor|and|…)` is corpus-safe: 0/157 regressions.

Asymmetry worth remembering: `RELAY_SHAPE`'s `^\W*` anchor saves `<rework>, <relay>`
("Rehaz la estrategia, mándamela por correo" → heavy) but NOTHING saves `<relay>, <rework>`.

## Mutation matrix (RED over the 157-case corpus)

a SECOND_ACTION inert 19 · b single-clause check removed **0** · c EVALUATIVE_AFTER_NOUN inert 2 ·
d RELAY_SHAPE `^\W*` removed **0** · e EXISTING_ADJ removed 2 · f future lookaheads removed 3 ·
g lead-in strip removed 7.

Both 0-RED folds are live-load-bearing but **unpinned** — witnesses that flip only under the mutant:
- (b) "Dame la estrategia. Rehaz el plan de precios." / "Muéstrame la estrategia. Ahora arma el plan de ejecución con presupuesto."
  The existing 2-sentence pins don't discriminate: their clause[0] fails the shape anyway.
- (d) "Rehaz la estrategia, mándamela por correo". The existing comma-relay pin is carried by `y`.

## Ambiguity limits the header explicitly accepts (NOT defects)

Definiteness proxies existence, so relative/purpose clauses that ask to DECIDE still demote:
"Dame la estrategia que deberíamos seguir", "Pon en el doc la estrategia que mejor nos convenga",
"Show me the strategy you'd propose", "Escribe la estrategia desde cero en un doc". A convergent
(closed-class, 2-token) tightening exists if wanted: `desde cero|from scratch`.

Perf: all 5 regexes < 0.26 ms/op on a 5 000-word adversarial full-scan input; whole guard 0.18 ms.
