# KB citation + search_output + kb-health — R1 audit (2026-09-09)

Bundle: A.2 `locateMatch` line/section citation in `searchFiles`; A.1 `task_history.search_output`;
B.3 `scripts/kb-health.ts` + `mc-ctl kb-health`. 4 test files, 27/27 green, `tsc --noEmit` clean.
**Verdict: FAIL (1 Critical).**

## Critical — a `string`-typed column that is a Buffer for 2/1066 live rows

`jarvis_files.content` is declared `TEXT NOT NULL DEFAULT ''`, but **SQLite TEXT affinity does not
convert a BLOB** — `SELECT typeof(content) … GROUP BY 1` on the live mc.db returns `blob|2, text|1064`
(`projects/mexico-necesario-ac/docs/protocolo-publicacion.md`, `directives/x-posting-card.md`).
better-sqlite3 hands those back as `Buffer`. The row cast at jarvis-fs.ts:532 (`content: string`) is an
unchecked `as`, so nothing catches it until `content.split("\n")` at :476.

The *shape* of the damage is the lesson, not the type error:

- The FTS path's new `locateMatch(r.content, tokens)` at :542 sits **inside** the `try` whose `catch {}`
  at :545 exists to fall through to LIKE. One poisoned row therefore **discards all 15 good FTS hits**.
- The LIKE fallback then returns 0 (its literal-phrase `content LIKE` can't match, and LIKE on a BLOB is
  false — so it does not even re-throw).
- Net, measured before/after on the live corpus: `jarvis_file_search("scope classifier")` **15 hits → 0
  hits, "No files found"**. Same for "protocolo publicacion" and "tarjeta de operacion" — 3 of 24
  sampled real queries (12.5%), any query whose top-15 bm25 window includes either blob row.

**CLASS: a new JS-side read of a column the previous code only touched in SQL inherits every value the
column can hold, not the values the type says.** The pre-change FTS path never called a string method on
`r.content` (it used SQL `snippet()`), so it was immune; the LIKE path's `r.content.toLowerCase()` at
:576 carried the same assumption but was only a fallback. Probe with
`SELECT typeof(col), COUNT(*) … GROUP BY 1` before trusting a declared column type — TEXT affinity is
not a constraint.

**CLASS: a swallowing `catch` around a degradation path converts a crash into silent zero-recall.** The
`catch {}` was correct for its original job (FTS5 operator-parse errors); widening the try's body to
include JS post-processing made it a mute button on the primary result set. Keep per-row work outside
the guard that means "the query engine rejected this", or `catch` per row.

## Warnings worth carrying

- **A description that teaches arithmetic can teach an out-of-range call.** `jarvis_file_read(path,
  lines='<L-20>-<L+40>')` (jarvis-files.ts:741): 115/183 live hits (62.8%) cite L≤20, and
  `parseLineRanges` (src/lib/file-slicing.ts:67) rejects both `-15-45` and `0-45`. Poka-yoke = say
  `max(1, L-20)` or ship the range in the envelope already computed.
- **first-ANY-token citation under an all-token AND matcher**: `buildFtsMatch` joins tokens with implicit
  AND; `locateMatch` returns the first line containing *any* token. 159/256 live multi-token hits (62.1%)
  cite a partial-token line — `"docker ufw bypass"` cites L251 where the all-token line is L532.
- **kb-health P1 flags the series it was written to protect.** The comment (kb-health.ts:15-17) says a
  rule "must not punish a series whose names differ BY DESIGN by a date" — dates are guarded by the
  `(?<=[a-z])` lookbehind at :67, but `-(?:v\d+|…)$` at :64 collapses `-v2/-v3/-v4/-v5`. **6 of 7 live
  collisions are deliberate version series (85.7% FP)**; only the `_` vs `-` northstar pair is real.
  A copy-marker list must distinguish "this is a stale duplicate" from "this is edition N".
  FN in the same rule: `plan-v2-old` → `plan-v2` ≠ `plan-v2` → `plan`, so a `-old` copy never collides
  with its own original — the exact signature P1 targets.

## Verified-clean (don't re-litigate)

- Perf: 30× full scan of the largest KB file (147,366 chars / 2,362 lines, no match) = **58 ms**;
  0.7 ms/hit over 256 live hits. No O(n²). `r.output LIKE` over 8.08 MB / 3,347 runs = **73 ms**.
- `task_history` new branch is parameterized (`@query`); only the column list is built from a boolean.
- `runs.task_id` has **no UNIQUE** (only `run_id`), so one task × N runs → N duplicate rows that eat the
  default `limit:3` — reproduced with a 4-run task, but **0 live occurrences** (3347/3347 tasks have
  exactly 1 run). Latent, pre-existing shape, widened by `search_output`.
- `outputMatch` is honestly `undefined` when the hit was in `toolCalls` JSON rather than `.text` — but
  when `parsed.text` is *absent* the `?? row.output` fallback snippets **raw JSON** as "what you wrote".
- kb-health `main()` realpath guard fires correctly under `npx --no-install tsx` from mc-ctl (ran it);
  `readonly: true` handle; P5's `startsWith(f + "/")` correctly rejects the `a/b` vs `a/bc` prefix trap.
- `LENGTH(content)` is **characters, not bytes** — 9,133,972 vs 9,531,925 (4.4% under-report against the
  15 MB byte threshold; not near it today).

---

# R2 verification (2026-09-09, same day) — PASS WITH WARNINGS

31/31 scoped tests, `tsc --noEmit` exit 0 / 0 errors. Every R1 finding folded; W6 moved into the
param description instead of code. Verified each fold with a live or mutation check:

- **C1 CLOSED, and the regression test is load-bearing** (the part worth remembering): the test plants
  the blob with `UPDATE jarvis_files SET content = <Buffer>` *after* `upsertFile`. That matters — an
  earlier direct `INSERT` of a Buffer produced a row the FTS query never returned, i.e. a vacuous test.
  The UPDATE fires the `jarvis_files_au` trigger, so the row is re-indexed and **does** come back from
  `MATCH`, as a `Buffer`; calling `.split` on it still throws. Probe before trusting a "poisoned row"
  fixture: assert `typeof(content)='blob'` AND that the row appears in the MATCH result set.
  Live: "scope classifier" 15/15 cited, "protocolo publicacion" 15/15, "tarjeta de operacion" 11/11,
  0 throws. Fix shape: `asText()` coercion + collecting FTS rows in the try and mapping them AFTER the
  catch, so a per-row defect can no longer mute the set.
- **W3 CLOSED, mutation-RED**: all-needles-first with any-needle fallback. Live partial-token citations
  62.1% → **37.6%** (residual = docs with no single all-token line). Old impl returns L3 on the test
  fixture, test asserts L7. Cost: when no all-token line exists the scan no longer short-circuits —
  54 ms for 15× the largest file (147 KB / 2,362 lines). Bounded, fine.
- **W1 CLOSED end-to-end**: envelope prints `lines='1-43'` for L3; fed back verbatim,
  `jarvis_file_read` returns no error and clamps (`slice_lines: 6` of `total_lines: 6`). R1's taught
  arithmetic was `lines=-17-43`.
- **W2/S1/S2 CLOSED**: live P1 collisions **7 → 1**, and the 1 is the true positive. `-vN`/`-N`/dates
  kept, copy markers stripped in a loop (`plan-old-copy-old` → `plan`); `-final.md` → `""` is skipped
  by the `key === ""` guard, not a crash.
- **S3 CLOSED**: `LENGTH(CAST(content AS BLOB))` → 9.09 MB, matches the byte total exactly.
- **W5 CLOSED**: JSON-without-`.text` now yields `outputMatch: undefined` (no JSON-as-prose); legacy
  raw-text output still snippets.

## New R2 warning — the W4 fix traded a noisy defect for a silent one

`LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id=t.task_id ORDER BY created_at DESC,
id DESC LIMIT 1)` de-duplicates correctly (3 same-second runs → one row citing attempt 3; the
`id DESC` tiebreak is load-bearing because `runs.created_at` is `datetime('now')`, 1-second
resolution). Plan is indexed (`SEARCH runs USING COVERING INDEX idx_runs_task_created`), 71 ms.

**But `r` is now bound to the latest run before the WHERE runs, so `r.output LIKE @query` only ever
searches the latest attempt.** Reproduced: a 3-run task whose finding is in run 1 and whose runs 2–3
are failed retries is **not returned at all** for that finding's term. `search_output` exists to
recall "¿qué encontraste sobre X?", so this is a silent false negative in the tool's core population.
0 live occurrences (3347/3347 tasks have exactly one run), same as the duplicate defect it replaced.

**CLASS: de-duplicating a JOIN by pinning one row changes which rows the WHERE can see.** If a
predicate reads the joined table, pin for *display* and match with `EXISTS` over all rows — or order
the pinned pick by `(output LIKE @query) DESC, created_at DESC` so the cited run is the matching one.
