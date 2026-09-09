# Memory-architecture plan v2.0 — R4 narrow audit (2026-08-28)

R3 folds verified. Verdict **PASS WITH WARNINGS**, 0 Critical. 161/161 scoped tests green
(4 mandated files + `numbers.test.ts`, added because the C2 fold MOVED code into
`numbers.ts`), tsc clean. All 3 mutable folds mutation-RED.

## What closed

- **C1 (indented-code shield deleted).** Re-derived the identity replay independently:
  3,032 live `tasks.output` deliverables, `stripSharedFindings(x) === x.trimEnd()` for all,
  0 with a section, and the STRONGER `restoreCode(shieldCode(x)) === x` bijection also 0/3,032.
  Harness proven able to fail: re-adding `INDENTED_CODE_RE` in a SCRATCH copy reproduced
  exactly R3's 5 rows (6241, 7500, 7503, 7637, 8766).
- **C2 (second `auditNumbers` caller).** Exactly 2 production callers (`consumer.ts:188`,
  `provenance-gate.ts:209`), both stripped; `taskDescription()` has 1 caller; the only other
  `tasks.description` readers (`implicit-deadlines.ts:180`, `events/retrieval.ts:262`) are not
  evidence corpora. Mutation-RED. On the ONE live swarm-child description the strip cuts
  2,477 to 601 chars. The heading-literal duplication IS pinned end-to-end at
  `swarm-runner.test.ts:515-550` (calls the real `buildSubTaskDescription`, asserts the strip
  yields "Setup database") — the R2 "hand-built heading pins nothing" lesson is answered.
- **W1/W2** both mutation-RED off ONE fixture (`jme.test.ts:295-352`). `1.0` is now reachable
  only via `mc-ctl:1687` (`UPDATE jme_facts SET confidence = 1.0`): one production INSERT path
  (`INSERT_FACT_SQL` from `upsertFact` from `consolidateAll:958`), no other writer in src/.
- **W3** re-derived: the `## Coordination` block is 69 non-empty words (JS `split(/\s+/)` gives
  70 on the isolated block because of the leading newline). **Standards** both closed.

## The one NEW warning

`shieldCode`'s placeholder is a space-delimited `CODE<n>` token — **prose can spell it**.
`restoreCode` (swarm-runner.ts:255) `text.replace(/ CODE(\d+) /g, (_, i) => blocks[Number(i)])`
rewrites any such token in the ORIGINAL text: `n >= blocks.length` gives the literal string
`undefined`; `n < blocks.length` splices in a foreign code block. Reproduced all three ways.
A markdown error-code table (`| CODE0 | fallo de red |`) is the realistic shape. 0/3,032 live
instances, so it is a Warning. Fix: a placeholder using a codepoint prose cannot carry
(e.g. NUL-delimited) plus `?? _` in the replacer.
CLASS: *a placeholder substituted INTO user text must be unspellable BY user text; a
bijection replay over the live corpus proves absence today, not impossibility.*
This is the same parser's 4th round (R1 `indexOf`, R2 anchored-vs-JSON, R3 nested shield,
R4 spellable placeholder). Substitute-in-text is still the wrong shape; mask-by-line-index
remains the durable one.

## Process lesson — cost me a scare

**`git checkout -- <file>` to undo a planted mutation DESTROYS the uncommitted work** when the
bundle is uncommitted (the whole point of a pre-commit audit). It reverted the C2 fold to HEAD.
Recovered only because the full `git diff` hunk was already in the transcript. Rule: `cp` the
file to the scratchpad BEFORE planting, restore with `cp`, verify with `md5sum -c`. Never
`git checkout --` in an audit of uncommitted changes.

## Agreeing with the accepted W4

`orderForInjection`'s single wiring point (`fast-runner.ts:936`) is genuinely single —
`queryMemory` has no other production consumer (`planner.ts:176`, `executor.ts:267`,
`memory.ts:108` are the OTHER store, `getMemoryService().recall`). So W4 is "unpinned", not
"uncovered", and reverting it degrades prompt ordering only — no correctness or safety path.
Accepting is right. Worth one queue line so a future refactor dropping it is not read as intent.
