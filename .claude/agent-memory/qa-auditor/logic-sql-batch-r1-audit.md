# logic + SQL correctness batch (F1–F24), R1 — 2026-09-10

Working-tree diff vs `c15de65`, 40 files, +339/−76. **FAIL, 2 Critical.**
tsc clean; 9 changed test files green (669 tests across 3 scoped batches).

## The two Criticals

**1. F19 declared `ESCAPE '\'` without escaping the escape char.**
`src/db/jarvis-fs.ts:592` (searchFiles LIKE fallback) and `:410` (listFiles prefix)
escape `%` and `_` but never `\`. Proven on the live DB:

```
sqlite3 -readonly data/mc.db "SELECT 'zdz' LIKE '%\d%' ESCAPE '\', 'zdz' LIKE '%\d%';"
1|0
```

So `\d` now matches a bare `d`, and a query ending in `\` matches nothing (returns 0,
no error). Pre-fix the backslash was literal. **Class: adding an ESCAPE clause is only
half a fix — the escaper must escape the escape character FIRST.** Order matters:
`.replace(/\\/g,"\\\\")` before the `%`/`_` replaces.

**2. F7 activated a fallback that is blind to cache tokens.**
`cost_ledger.prompt_tokens` INCLUDES `cache_read_tokens` — proven by a priced row
(prompt 2,056,175 / cache_read 1,924,412 / SDK-booked $1.6269; full list rate on the
whole prompt count would be $6.17). `calculateCost` (`src/budget/pricing.ts:78`) prices
the entire `prompt_tokens` at the uncached rate and ignores the `cacheRead`/`cacheCreation`
fields `CostRecord` already carries. The biggest fallback row (id 7922, `fast`,
4.81 M prompt of which 4.68 M cache-read) would book **$14.43 where the list-equivalent
is ≈$2.3 — a 6× overstatement**. F7's stated goal ("the ledger is one currency") is
therefore unmet in the direction it claims to fix. **Class: before switching a $0 pricing
row to a real rate, check what the token column actually counts.**

The rates themselves are correct against the Anthropic list table (Opus 4.7/4.8 $5/$25,
Sonnet 5 $2/$10, Sonnet 4.5/4.6 $3/$15, Haiku 4.5 $1/$5), and `getPricing` prefix-matches,
so the dated id `claude-haiku-4-5-20251001` (136 live rows) is covered.

## Verified-correct (with the probe that proved it)

- **F21 month boundary.** `TZ=America/Mexico_City sqlite3` →
  `datetime(strftime('%Y-%m-01 00:00:00','now','localtime'),'utc')` = `2026-09-01 06:00:00`,
  the right UTC instant; under `TZ=UTC` it degrades to a correct no-op. `cost_ledger.created_at`
  is `datetime('now')` = UTC. Daily/hourly windows are rolling/UTC, so no split-brain.
- **F6 canary cutoff.** Live count: ISO-format cutoff matches **13** rows in 24 h, the
  space-format cutoff matches **87**. Real bug, real fix.
- **F4 find args.** Ran the exact arg list on a temp tree: prunes `node_modules`/`.git`,
  and `-path './src/*.tsx'` matches nested `./src/a/b/x.tsx` (`*` spans `/` in `-path`).
- **F18 expression index.** EXPLAIN QUERY PLAN in a replica DB: `SCAN knowledge_triples`
  → `SEARCH … USING INDEX idx_kt_subj_pred_lower (<expr>=? AND <expr>=?)`. Also helps
  `queryTriples`' subject-only path.
- **F17 cannot empty a recall.** `normalize()` divides by the list max, so the top hit of
  each non-empty layer scores 1.0 → merged 0.5, always ≥ the 0.12 floor. Embedding-only
  hits are all ≥0.15 (the `sim>0.3` gate ÷ max ≤1.0). The feared empty-recall does not exist.
- **F5 does NOT accept NaN.** zod 4.4.3: `z.coerce.number().safeParse("abc")` FAILS.
  `z.toJSONSchema` is unchanged for `number` and *improves* for `integer`
  (`type:"integer"` + safe-int bounds where it used to emit `type:"number"`).
- **F24 `*/N` unchanged.** Widening `max` 6→7 only affects the `N/step` upper bound and
  the extra `dow===0 → probe value 7` call; `*/2` still matches 0,2,4,6.

## Warnings worth remembering as classes

- **A guard that short-circuits makes its sibling fold untestable.** The F1 test feeds a
  746-char string, but `head.length > 300` returns before any regex — reverting the
  `{0,4}` bound to `*` keeps the test GREEN. Pin each fold with an input the *other* fold
  cannot absorb.
- **`grep -c` + `--max-count N` caps the reported COUNT per file** (GNU grep 3.11: a file
  with 5 matches reports 2). F3 mirrored a pre-existing rg-path defect into the grep
  fallback. `--max-count` is per-FILE, never a total bound.
- **`fd` is MISSING on this box** (`rg` is present). So `file_find`'s live path is the
  `find` fallback and `code_search`'s live path is rg. F4's `truncated: all.length > maxResults`
  is correct only because fd is absent — fd caps `all` at `maxResults`, so installing fd
  would silently make `truncated` always false and turn the new test red.
- **An `await` moved onto the hot path inherits the callee's whole deadline.** F13 turns
  `expandQuery` (own 5 s `Promise.race` deadline) into a serial await before the pgvector
  leg, so a chat turn can now cost 5 s + 4 s instead of max(4 s, …) whenever
  `COMMIT_DB_KEY` is set. `isPgvectorEnabled()` itself is pure (`!!process.env.COMMIT_DB_KEY`)
  and the dynamic import is cached — those were not the problem.
- **F11 removed the last RETRY, not just its unread verdict.** The unassessed round's
  output was still returned as `finalContent`; the change trades one improvement round for
  tokens. `selfAssessRounds` now maxes at 1 and `inferWithTools` at 2.
- **F10 forwarded `ORCHESTRATOR_TIMEOUT_MS=900000` into containers whose host timeout is
  also 900_000** (`heavyRunnerTimeoutMs`/`nanoclawTimeoutMs` defaults). Zero margin for the
  in-container orchestrator to write its partial result; only the activity-aware `resetTimer`
  saves it.
- **F8's `/\baborted\b/` is wider than "operator intent"** — undici/fetch AbortError text
  ("The operation was aborted") is transient and now escalates with no retry.
  `TRANSIENT_PATTERNS` became dead code (it was already subsumed pre-diff by the
  unconditional `attempt < maxAttempts-1` RETRY on the next line).

## Repo hygiene at audit time

Untracked in the repo root: `atchRitualTask(taskIdp` (164 KB, a botched shell redirect)
plus 11 `tmp_*.cjs` scratch scripts. A `git add -A` would commit them.
