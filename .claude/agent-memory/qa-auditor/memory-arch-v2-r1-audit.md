# Memory-architecture plan v2.0 — R1 audit (2026-08-28)

Scope: `jme_signals` migration v5 · `preference-signals.ts` tagger · `writeEpisodic` signal write ·
`orderForInjection` · consolidator prompt rule · planner ownership rule · swarm `## Shared findings`
forwarding · `mc-ctl jme-preferences`. Verdict **FAIL**, 4 Critical. 124/124 tests green, tsc clean,
`bash -n` clean — every finding survives a green suite.

## The four Criticals

1. **A calibration corpus drawn from a RECALL-QUERY column is not the operator's messages.**
   The replay used `SELECT DISTINCT query FROM recall_audit WHERE source='jme' LIMIT 3000`.
   Verified composition: 664 operator · 221 system-reminder prompt text · 176 Jarvis-authored
   `Fede …` fact strings · 131 other ⇒ **56% operator**. `MAX(LENGTH(query))=500` with 238 rows
   AT the cap, and the column spans 45 days vs 156 days of real chat in `conversations`.
   Reproduced 1215/5 hits exactly — then read all 5: every one is a TASK INSTRUCTION
   ("Haz un deep search … Resumelo."), not a reply correction. **Precision 0/5 on the corpus that
   licensed the ship.** Broad replay over 5,075 distinct operator messages: 17 hits (0.335%), two of
   them at char 1081/5351 and char 7377/9703 — inside pasted third-party documents, structurally
   invisible to a 500-char corpus.
   → CLASS: *replay a text detector against the column the PRODUCER writes, not a column that merely
   quotes it*; and check `MAX(LENGTH())` + a composition histogram before believing a corpus.

2. **An H2 section a child is told to publish leaks verbatim to the operator.**
   `extractDeliverableText` selects a FIELD, it does not filter text; `collectFinalAnswer`
   (`src/prometheus/final-answer.ts:18-27`) raw-joins per-goal results with `\n\n`; the router prefers
   `finalAnswer`. Nothing in `deliverable-filter.ts` strips headings (its only heading rule is
   `GOAL_BANNER_RE`). → CLASS: *any new agent-to-agent contract carried IN the deliverable needs a
   stripper at the delivery seam, added in the same ship.*

3. **A forwarded sibling section becomes the receiving child's provenance evidence.**
   `consumer.ts:180` — `auditNumbers(deliverable, [...evidence, args.taskDescription])`, and
   `taskDescription` IS the `buildSubTaskDescription` output. A sibling's unverified `3.6%` lands in
   the description, the receiving child quotes it, and the numbers audit marks it verified — the
   `(sin verificar)` annotation is silently defeated. → extends
   [[evidence-corpus-typed-by-what-tool-does]]: sibling PROSE is not an observing tool.

4. **`indexOf` over untrusted LLM prose is not a heading parser.** Verified with a verbatim
   re-implementation: a `## Shared findings` inside a ```` ``` ```` fence WINS over the real section
   (forwards `"- PLACEHOLDER EXAMPLE\n```"`); a mid-line mention (`"See the ## Shared findings below."`
   — which the brief makes likely, since it names the heading in quotes) wins and yields `"below."`;
   `## Shared Findings` (title case) → `null`, silently; `## Shared findings:` leaks the colon; the
   prompt asks for a **final** heading but the code takes the **first**. Every failure is silent.

## Reusable checks this round earned

- **Measure the budget before trusting an ordering rationale.** `orderForInjection` says it runs
  "before the token-budget cut so truncation eats episodic facts". Live: `MAX(LENGTH(fact_text))=302`,
  the 8 LONGEST facts sum to **2,412 chars**, threshold is **6,000**. The cut is unreachable by 2.5×.
  Same shape as [[budget-ruling-5-1400-audit]] — a cap whose branch no population can reach.
- **A stated/inferred discriminator must match what the producer actually emits.** mc-ctl splits on
  `confidence >= 1.0`; live `jme_facts` preferences run **0.72–0.99, none at 1.0** ⇒ all 32 label
  "inferred" and the gate's "once ≥5 inferred preferences exist" precondition is met at t=0 by rows
  predating the feature. The clamp is `Math.max(0, Math.min(1, fact.confidence ?? 1))` — the "≤0.7"
  ceiling is prompt-only, and a MISSING confidence defaults to **1.0**, auto-promoting an inferred
  fact to "stated".
- **Mirror a planner rule into REPLAN_SYSTEM.** The ownership rule landed in `PLAN_SYSTEM` only;
  `REPLAN_SYSTEM` explicitly re-states the workload-sizing rule, so the file's own convention is to
  mirror. Replans fire on timeout — exactly when fan-out needs ownership most.
- **A "precedence" test that uses a string matching ONE pattern cannot fail.** `"prefiero la tabla,
  no la prosa"` matches only `explicit` (the format alternation wants `dame la tabla` / `en (una )?tabla`).
  0/15 test strings match >1 kind; **fully reversing PATTERNS changes 0 test outcomes.**
- **Hand-copied DDL in a test fixture is not a migration test.** `jme.test.ts` mocks
  `../db/index.js` wholesale (`getDatabase: () => mockDb`, `writeWithRetry: (fn) => fn()`) and builds
  its own `jme_signals`. Deleting migration v5 leaves all 124 tests green. The repo already has the
  right shape (`src/db/v8-2-phase0-schema.test.ts`, real `initDatabase`).
- **A second `writeWithRetry` on one code path is a second throw surface.** The router calls
  `writeEpisodic` twice inside ONE `.then()`; a throw from the user-turn SIGNAL write (BUSY exhaustion
  after 10 retries) now drops the JARVIS turn — the pair is 23/23 today and nothing detects the skew.
- **Description growth changes ROUTING.** `swarm-runner.ts:814` says `// agentType NOT set — classifier
  auto-routes`, and `classifier.ts:545-555` scores word count (>50/+1, >100/+2, >200/+4; ≥6 ⇒ heavy,
  ≥3 ⇒ nanoclaw). The fixed `## Coordination` block is 48 words; forwarded blocks are 1,500 chars EACH
  with no aggregate cap (14 siblings ⇒ ~3,500 words). Prompt scaffolding is a routing input.
- **SQLite 3.45.1 has no `%V`** (verified: `strftime('%Y-W%V', …)` returns empty). `%W` splits the
  New-Year week (`2025-12-30` → `2025-W52`, `2026-01-01` → `2026-W00`). Both sides of the mc-ctl join
  are UTC (`datetime('now')` and `'unixepoch'`), so week ALIGNMENT is correct — only the boundary splits.
- **`LIMIT 8` cannot show a 29-week baseline.** Denominator measured at 114–220 chat turns/week; at the
  0.34% hit rate that is ~0.6 signals/week, so the plan's own "fewer than 20 signals is not a verdict"
  needs ~29 weeks. The mc-ctl banner prints the SUCCESS rule and omits the inconclusive clause.
- `SELECT changes()` after an UPDATE in one `sqlite3` invocation works (returns 1 even when the value
  was already the target); `$id` is `^[0-9]+$`-validated, so no injection. Both migration paths
  (fresh `user_version=0` and a real v4 copy) verified GREEN empirically.
