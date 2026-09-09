# strategy relay/readback guard — R1 audit (2026-09-05)

**Change**: `src/dispatch/classifier.ts` — `isStrategyRelayOrReadback()` demotes a chat from
heavy→fast when the strategy/roadmap NOUN is the sole heavy cue and the phrasing is relay
("escribe … en un google doc") or readback ("cuál es …"). Tasks 9246/9244 cost $3.43/$4.31 on heavy.
**Verdict**: FAIL (R1). 3 Critical, 5 Warning. tsc clean, 104/104 scoped tests green.

## Doctrine crumbs

- **A destination is not an intent.** relay-verb + destination cannot tell "put the EXISTING
  strategy in a doc" from "AUTHOR a strategy into a doc". Proof that lands every time: take the
  change's OWN "must stay heavy" test string and append the destination —
  `"Escribe una estrategia de contenido para TikTok"` (heavy, pinned) →
  `+" en un google doc"` (fast). The test comment even names the discriminator
  ("relay verb, no destination → design"), so the contradiction is self-documented.
- **`^\W*` skips punctuation, never a word.** `\W` = `[^A-Za-z0-9_]`, so an anchored readback
  regex survives `¿`, `"` and emoji but dies on any greeting/vocative: "Hola Jarvis, cual es la
  estrategia…", "Buenos días. Cuál es…", "Can you show me…" all stay heavy. Anchoring a
  conversational-verb pattern at string start = calibrating on the 2 logged messages, not the corpus.
- **Determiner carries the read/formulate distinction in ES/EN**: "dame LA estrategia" (existing)
  vs "dame UNA estrategia" (formulate). A readback verb list with no determiner test admits design.
- **Recurrence, 3rd time in this file**: bare Spanish stems + `\b` miss enclitics/accents.
  `classifier.ts:373-377` already documents the fix ("Stem + `\w*` so the clitic suffix is
  absorbed. (qa-W1, 2026-06-26)") — the new list used `manda|env[ií]a|comparte|guarda` and misses
  Envíame / Mándame / Guárdala / Súbela / Compártela. Grep the FILE's own comments for the class
  before writing a new verb list.
- **`\w*`-suffixed verb stems eat adverbs and nouns**: `gener\w*` matches "en **general** la
  estrategia" → forced heavy; `desarroll\w*` matches the noun "**desarrollo** de la estrategia";
  `cre[ae]\w*` matches "**creemos** que". `scope.ts:547` already shows the guard form: `creo(?!\s+que\b)`.
- **Mutation-test each new construct separately.** Deleting `DESIGN_TARGETS_STRATEGY` (the biggest
  new regex, and live-load-bearing — it is the only thing keeping "Diseña la estrategia y ponla en
  un doc" on heavy) leaves **0 of 16** new assertions RED. Simulate the mutant in a `tsx` probe when
  the audit is read-only; don't edit the file.
- Index binding `HEAVY_REASONING_PATTERNS[3]` IS caught by the tests (rebinding to [0] → 7 RED),
  but declaring the const first and splicing it into the array by reference removes the class.
- A demotion that returns the SAME reason string as ordinary chat ("messaging task → fast") cannot
  be scored against the tasks table later — the very method that found the regression.
- Tier asymmetry to check on any ES/EN routing change: `CAPABLE_MSG_PATTERNS` carries `estrategia`
  but not `strategy|roadmap`, so EN "What's the roadmap?" lands fast+**flash** (`tierToEffort`
  → "low"), the tier with the file's own documented fabrication incident (task b59dbab6).
- Bounded `(?:\s+\S+){0,3}?` is NOT a ReDoS risk (measured 0-1 ms on 4k-20k-token strings).
- Prettier: HEAD pre-image was clean, the change is not (classifier.ts:476, test:370/372).
