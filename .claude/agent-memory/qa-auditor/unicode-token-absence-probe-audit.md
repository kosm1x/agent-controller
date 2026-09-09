# Unicode token class + recall absence-probe + §17 window (2026-08-14)

**Bundle**: `src/lib/v8-2/critic.ts` (sanitizeFtsQuery `[a-z0-9]`→`[\p{L}\p{N}]/gu`, new
`recallAbsenceProbe`, prompt rule 4), `src/briefing/v82-activation-gate.ts` (check-4 window
7d→30d + `unfixableBreakdown`), `src/memory/jme.ts` (same regex class), 3 test files.
**Verdict**: PASS WITH WARNINGS (0 Critical, 4 Warning).

## Doctrine

- **A guard whose FAILURE is indistinguishable from its PASS licenses the exact act it
  guards.** `recallAbsenceProbe` swallows every probe exception per-variant and still
  returns `"no KB matches (lexical FTS + substring probe)"` — the string the system
  prompt turns into "you may delete this claim as undocumented". Empirically forced:
  FTS table present + base table absent → the strongest absence message with zero probes
  executed. Fix shape: count SUCCESSFUL probes, not attempted ones.
- **A prompt that states a tool's guarantee in absolute terms is wrong on every branch
  that doesn't meet it.** Rule 4 says recall_check "only reports 'no KB matches' after
  BOTH" passes; the `<3 chars` branch reports `no KB matches … (lexical).` with no probe.
  When a prompt asserts an invariant, enumerate the tool's EARLY-RETURN branches.
- **Widening a gate window is honest only if you compute both.** 7d=15% (3/20) vs
  30d=9.9% (8/81) on the live DB — still FAIL, so no self-serving flip. Always run the
  old and new predicate side by side before accepting a window change.

## Verified facts (re-usable)

- `jarvis_files_fts` = `fts5(title, content, path UNINDEXED, tokenize='unicode61
  remove_diacritics 2')` — folds diacritics BOTH directions at match time, and `path` is
  UNINDEXED (so a slug-only match is an FTS blind spot a LIKE-on-path probe covers).
- SQLite `LIKE ? ESCAPE '\'` with `[\\%_]` escaped is wildcard-tight: `%z\%z%` → 0 hits
  where unescaped `%z%z%` → 3. Escaping `\` itself is what keeps a trailing backslash
  from eating the closing `%`.
- Live `jarvis_files` = 883 rows / ~7 MB → a full-scan LIKE miss is **5.9 ms**
  (`SCAN jarvis_files`). Two variants × ≤5 critic tool calls ≈ 60 ms/run. Bounded.
- FTS5 **barewords legally contain any codepoint > 127**, so a `\p{L}\p{N}` token class
  is injection-safe even unquoted (jme joins tokens with " OR " unquoted). Verified with
  accented/CJK/Greek/Arabic-Indic input — no throw.
- 3 sibling `extractKeywords` exist: `memory/jme.ts` (fixed), `memory/sqlite-backend.ts:100`
  (already `\p{L}\p{N}`), **`dispatch/keywords.ts:109` `split(/[^a-z0-9]+/)` — NOT swept**.

## Repo conventions confirmed

- `evaluateV82Gate` is tsx-only (`scripts/briefing-gate.ts`, `scripts/judgments.ts`) —
  never in-service `dist/`, so gate changes need no deploy.
- The §17 "single-source gate" spec block is `docs/planning/v8-capability-2-spec.md:600-625`
  — window changes must be mirrored there (line 615 was left stale at 7d).
