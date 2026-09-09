# task_history keyword-AND + output-default-ON — R3 audit (2026-09-09)

Bundle: `jarvis-fs.ts` `asText` hoisted + coercion in `getFile`/`getFilesByQualifier`/`appendToFile`;
`task-history.ts` whitespace-tokenized AND search, `search_output` **ON by default**, `matchedIn`,
`ORDER BY (t.status='running') ASC`. 138/138 scoped tests, `tsc` exit 0.
**Verdict: PASS WITH WARNINGS (0 Critical).** Design changed mid-audit (fallback → default-ON).

## The headline: an honest quote can still be the wrong quote

`matchSnippet(outputText, tokens)` anchors on the **earliest-occurring** token. When one token also
matched the TITLE, that token usually appears first in the output too — so the quote shown as the
evidence for `matchedIn:'output'` omits the token that is the whole reason the row matched.
Live: **13/74 (17.6%)** of `matchedIn:'output'` hits quote none of the output-only tokens, and
**9/74 (12.2%)** have it in neither `outputMatch` nor the 500-char `outputPreview` — no evidence
anywhere in the payload. Hits the motivating query itself: `"dentistas Oaxaca"` → task 9465's snippet
is the generic "Top 10 densidad de dentistas" table header (window `[0,189]`), while `Oaxaca` sits at
offset 253 in a genuinely relevant row (`Oaxaca de Juárez | Oaxaca | 626 | 23.10`).

**CLASS: anchor a citation on the DISCRIMINATING term, not the earliest one.** Under an all-token AND
matcher the earliest token is the least informative — it is the one the cheaper predicate already
matched. Same shape as R1's W3 (`locateMatch` first-ANY-token under an all-token FTS AND), recurring
one layer up. Fix: anchor on `tokens.filter(t => !titleId.includes(t))`, fall back to all tokens.

## Two labels for three sources, computed by a different engine than the filter

`matchedIn` is derived in JS (`titleId.includes(t)`) while the row was selected by SQL `LIKE`. The two
disagree in both directions:
- `_` is a LIKE wildcard: token `shell_exec` matched **27 live titles** via `_`→any-char, all labeled
  `matchedIn:'output'` (e.g. id=9235 "Auto-skill: browser markdown + file edit + shell exec").
- SQL `LIKE` is ASCII-case-insensitive; JS `toLowerCase()` is full-Unicode → accented tokens mislabel
  the other way.
- A `task_id`-only hit is labeled `'title'` (verified: query `86a511ff` → `matchedIn:'title'`, title
  does not contain it). Description advertises title/ID/output; the label has two values.

**CLASS: a label that explains WHY a row matched must be computed from the same predicate that
selected it.** Recomputing it in the host language re-derives the answer with different semantics.

## Default-ON changed the population, not just the recall

`search_output: args.search_output !== false` flipped an opt-in scan into the default path:
- Live matching population grows 6–17×: `trustr` 33→176, `denue` 12→127, `mission control` 8→204.
  `total: rows.length` is computed **post-LIMIT**, so the model reads `total: 3` when 204 matched —
  a confabulation surface in the tool that exists to stop confabulation.
- Latency 7–9 ms → 64–92 ms on **every** call (8.48 MB / 3,335 `runs.output` rows).
- The WHERE reads the raw output JSON envelope, so tool names in `toolCalls` match: `shell_exec`
  matched 1000+ tasks. 3.5% of live `matchedIn:'output'` rows carry no `outputMatch` at all.
- R2's W7 pin fix `(output LIKE @q0) DESC` only prioritizes the FIRST token's run, so with ≥2 tokens
  spread across runs the task is dropped — now on the default path. 0 live (3354 tasks / 3354 runs,
  **0 multi-run tasks**).

## Verified-clean (don't re-litigate)

- **better-sqlite3 does NOT throw on unused named params** (probed): `.all({q0,q1,limit})` against a
  statement referencing only `@q0` returns rows. Missing params DO throw (`Missing named parameter`).
  So the `@q0`-only pin subquery is safe, and N-token binding is correct for N=1,2,3,5.
- `scheduled_only` precedence is right — each token clause is parenthesized before the `AND` join;
  live 18 → 3 with 425 `[Scheduled]` titles.
- **ORDER BY guard is mutation-RED**: removing `(t.status='running') ASC` flips the question task from
  rank 3 to rank 1. And `tasks.status='running'` really is set during execution (dispatcher.ts:1218),
  so the guard fires for the in-flight question — but note **0 of 3354 live rows are 'running'** at
  rest, so the guard is invisible in any static DB probe.
- Motivating case fixed live: `"dentistas Oaxaca"` → 9495, **9465 at rank 2**, 9457 — inside default
  `limit: 3`.
- `getFile` spread `{...row, content}` preserves every column and key order; all 20 call sites
  destructure fields, none rely on identity.
- Live `jarvis_files`: **1068 text / 0 blob** — the two poisoned rows are repaired.
- Blob regression tests are non-vacuous (plant the Buffer with `UPDATE` after `upsertFile`, per R2).

## Carried warning — the coercion is at 3 of ~12 read sites, and the WRITE is unguarded

`upsertFile(path, title, content: string, …)` has no runtime type check, so nothing prevents a Buffer
from being stored again. Direct readers that bypass the coerced accessors and would still throw:
`src/detection/stalled-projects.ts:158` (`l.content.toLowerCase()`), `session-end-writer.ts:97`,
`implicit-deadlines.ts:196`, `pgvector-backfill.ts:69` (`.slice` on a Buffer silently slices BYTES).
Cheap durable fix: `CHECK(typeof(content)='text')` or a coercion in `upsertFile`.

## Test gaps found (all 9 task-history tests green, but)

`scheduled_only` is **entirely absent** from the test file; no ≥3-token test; no `%`/`_` token test;
no `matchedIn` test for a task_id-only match; nothing asserts the snippet contains the output-only
token (the W1 defect ships GREEN).
