# Strategy relay/readback guard — design note (2026-09-05 → 09-06)

**Shipped** `90cc494`, deployed 2026-09-06 03:57 UTC (pid 3796940). Code:
`src/dispatch/classifier.ts` (`isStrategyRelayOrReadback`, wired into
`needsHeavyReasoning` and the messaging fast-return of `classify`). Tests:
`src/dispatch/classifier.test.ts` describe "strategy relay/readback (2026-09-05)".

## Problem

The bare noun `estrateg\w*` / `strateg\w*` / `roadmap` is a `HEAVY_REASONING_PATTERNS`
cue. Chat turns like «Escribe la estrategia en un google doc para revisarla»
(task 9246) and «Cual es la estrategia de draft con 10 jugadores?» (9244) therefore
ran on heavy — Opus tier, orchestrator, 3.6–4.3 min, $3.43/$4.31 — to copy or read
back a strategy that already sat in the KB. Three such turns were $12.73 of $33
chat spend that day.

## Decision

Operator ruling: tighten, not the kill switch (`MESSAGING_HEAVY_ESCALATION=false`
remains the blunt lever). When the strategy noun is the **sole** heavy cue and the
message is a relay or readback of an **existing** strategy, route fast (capable
tier) with the scoreable reason `messaging task → fast (strategy relay/readback)`.

## What eleven audit rounds taught (the design rule)

1. **A deny-list over an open class never converges.** R1–R5 tried to keep real
   work on heavy by listing design/rework verbs. Each round found more (reformula,
   pule, tweak, «cuando la mejores», the `re-` prefix hiding stems behind `\b`,
   proclitics). Verbs are open; conjunctions and morphology are not.
2. **Allow by shape.** R5 inverted: admit exactly two shapes — readback (opener +
   definite strategy NP) and relay (relay verb + definite strategy NP + destination)
   — and block only on closed classes (conjunctions/subordinators/coordinators,
   post-comma discourse markers, the Spanish gerund, an evaluative adjective glued
   to the noun, indefinite/bare nouns, future openers, a second sentence).
3. **Every slot must be closed AND both ends anchored.** R9 found the object was
   free («Dame tu recomendación sobre la estrategia» → fast). R10 found three more
   free slots (a «≤2 words» slack, the destination slack, the unanchored clitic
   branch), and probing R10's diagnosis before editing surfaced a fourth: the tail
   after the noun («Escribe la estrategia con mejoras en el doc»). One root cause,
   fixed once: the head clause must be consumed entirely (`^…$`) and each slot is a
   word list or a morphological form — `TOK`, `TOPIC_PP`, `CON_PP`, `NP_ADJ`,
   `DEST_PHRASE`, `RECIPIENT` (capitalised name marked case-sensitively), `PURPOSE`
   (consumption verbs only), `TAIL_ADV`, `RB_ADV`.
4. **Unknown ⇒ heavy** is the status quo, so every residual fails safe.

## Accepted residuals (do not chase)

- A change **noun** inside an admitted phrase: «la estrategia de precios con los
  cambios», comma fragment «…, con mejoras», «…, en serio ajusta precios».
- Post-nominal participles are existence markers: «la estrategia mejorada» is fast
  like the pinned «corregida»; a participle with its own complement stays heavy.
- The topic slot's tokens accept an infinitive + object («para reescribir el
  roadmap») — same slot as the pinned «para ganar el draft».
- Bare EN compound heads («the roadmap changes») admit an authoring reading.
- A mid-sentence capitalised infinitive fools the recipient marker («a Mejorar»);
  Title-Case/ALL-CAPS replays 0/140 flip; excluding -ar/-er/-ir would drop
  Javier/Pilar/Omar.
- E-mail recipients ⇒ heavy (the dot splits the sentence); lowercase names ⇒ heavy;
  an unlisted word after a fronted destination («en el doc nuevo la estrategia») ⇒ heavy.
- Definiteness is a proxy for existence: «escribe la estrategia de draft para 10
  equipos en un doc» demotes; fast can write it.

## How to extend

- A new destination/adverb/purpose/existence word: add it to the matching closed
  list and pin one fast case. Never add a verb deny-list.
- A new false-fast: first ask which **slot** admitted it. If a slot is open, close
  the slot; if a noun did it, it is the documented residual.
- Every fold must turn ≥1 pin red when mutated (the R11 audit matrix is the model).

## Verify / measure

- Journal: `Inbound from telegram → task … (fast)` on the next «estrategia» relay.
- Count: `sqlite3 -readonly data/mc.db "SELECT count(*) FROM tasks WHERE classification LIKE '%strategy relay/readback%'"`.
- Offline: `npm run tune:baseline:dry` — Classification 100 / Scope 94.5 unchanged.
