# Drive drift reconcile plan (queue item 3z), 2026-10-17

Read-only classification of `drive_file_map` against `jarvis_files` (snapshot
2026-10-17 ~17:15 MX, `sqlite3 -readonly`). Nothing was run against Drive. Counts
and folder-level groups only: the full per-path lists (with Drive file ids and
dates) are kept outside the repo for operator review, because this repo is public.

**Rule (queue 3z):** list first, the operator says yes to each batch, and there is
never a full-Drive run.

## Headline counts

| | Count | Note |
| --- | ---: | --- |
| `drive_file_map` rows | 3,425 | queue said 3,426 |
| `jarvis_files` rows | 1,288 | |
| **A. Orphans** (map row, no KB row) | **2,332** | live, untrashed Drive files |
| **B. Missing** (KB row, no map row) | **195** | 144 day-logs + 51 others (queue said 194: one more day-log since then) |
| **C. Duplicate map paths** | 0 | also 0 duplicate `drive_id`s and 0 case-only duplicate paths |
| **C. Map rows for root `INDEX.md`** | 1 | 2 rows in total have basename `INDEX.md`; none are odd-path variants |

`drive_file_map.updated_at` is written when the map row is written, not when the
Drive copy is patched. For example, the root `INDEX.md` row still reads
2026-04-09 16:20:51. So the "oldest/newest" columns below show when map rows were
written, not how fresh each Drive copy is.

## A. Orphans (2,332)

| Group | Orphans | Oldest map ts | Newest map ts | Class |
| --- | ---: | --- | --- | --- |
| `workspace/` (all directly in the folder, no subfolders) | 1,291 | 2026-05-22 | 2026-10-11 | plain orphans (bulk cleanup) |
| `knowledge/execution-patterns/` | 1,006 | 2026-05-23 | 2026-10-11 | plain orphans (bulk cleanup) |
| `knowledge/` (file directly in the folder) | 1 | 2026-04-10 | 2026-04-10 | move-pair: its live successor is under `knowledge/domain/` |
| `projects/eurekaMS/` | 24 | 2026-06-20 | 2026-08-13 | **case-rename move-pairs**: all 24 live successors are under `projects/eurekams/`, and none of them has a Drive copy |
| `projects/intelligence-ops-mcp/` | 1 | 2026-06-27 | 2026-06-27 | move-pair, ambiguous (basename matches 3 live paths; likely successor `projects/eurekams/intelligence-ops-mcp/`) |
| JUNK: absolute paths (`/…`) | 3 | 2026-04-10 | 2026-05-23 | junk |
| JUNK: absolute path with the slash stripped (`root/…`) | 1 | 2026-05-23 | 2026-05-23 | junk |
| JUNK: vitest fixtures (`p/` 3, `a/` 2) | 5 | 2026-08-23 | 2026-08-23 | junk (queue said 4; there are 5) |

- Junk total is 9, which matches the queue.
- Move-pairs total 26: 24 case-renames, 1 `knowledge/` → `knowledge/domain/` move, and 1 ambiguous older copy. For 25 of them the live successor has **no Drive copy**. Trashing those orphans before a backfill would leave the file with no Drive copy at all, so a backfill must come first.
- `workspace/` filenames start with the task prompt's first word, so the folder has no structure to batch by. Batching it needs `--limit`.
- `knowledge/execution-patterns/` filenames start with a date, which splits the orphans by month: 2026-05 92 · 06 191 · 07 230 · 08 203 · 09 193 · 10 97. The 45 live files in this folder are all dated 2026-10.

## B. Missing (195)

| Group | Missing | Created (KB) | Cause signal |
| --- | ---: | --- | --- |
| `logs/day-logs/` | 144 | 2026-05-22 to 2026-10-17 | by design (direct SQL INSERT); 54 older day-logs do have map rows |
| `projects/eurekams/` (4 subfolders) | 26 | 2026-06-20 to 2026-10-12 | 24 are moveFile targets of the `eurekaMS` orphans; 2 have no source and no synced sibling |
| `projects/proyectos-extraordinarios-27-tva/tmn/` | 9 | 2026-07-10 to 2026-07-11 | 8 are in folders that have synced siblings; 1 (`brand/`) is in a folder with none |
| `directives/` | 6 | 2026-05-28 to 2026-08-28 | folder has 16 synced files, so this suggests a failed create or a write path that skips sync |
| `projects/agent-controller/` | 2 | 2026-04-05, 2026-05-26 | siblings synced (28) |
| `knowledge/domain/` | 1 | 2026-05-23 | moveFile target (its source is the `knowledge/` orphan) |
| `knowledge/` (file directly in the folder) | 1 | 2026-09-12 | siblings synced (3) |
| `projects/{denue-data-analysis, mexico-necesario-ac, pulso-aura-upfront, solera-properties, uncharted-lite, williams-entry-radar}` | 6 (1 each) | 2026-05-27 to 2026-10-11 | 5 are in folders with synced siblings; `denue-data-analysis` has none |

How the 51 non-day-log rows split:

| Cause signal | Rows | Reading |
| --- | ---: | --- |
| moveFile target (a same-path or same-basename orphan exists) | 25 | moveFile leftover: the old Drive copy was never moved or re-synced |
| no source, folder has other synced files | 22 | suggests a failed create, or a create path that never reaches Drive |
| no source, folder has no synced files | 4 | suggests a never-synced folder (`projects/eurekams` 2, `denue-data-analysis` 1, `tmn/brand` 1) |

By folder: 11 folders (23 rows) have other synced files and 7 folders (28 rows)
have none. Most of the folders with none are in the renamed `eurekams` tree.

## Tooling facts that shape the plan

1. **Prerequisite P1 is built (pending commit): `scripts/reconcile-kb-drive.ts` now takes `--prefix` and `--limit`.** Before P1, `--apply` trashed every orphan, all 2,332, which is the full-Drive run the queue forbids. Its usage now reads:
   ```
   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts                              # dry run: every orphan (overview)
   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=<p> [--limit=<n>]   # dry run: one batch
   npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=<p> --limit=<n> --apply   # trash that batch
   ```
   `--prefix` is a case-sensitive `startsWith` on the map path. `--limit` takes digits only and selects at most n orphans in path order. `--apply` is refused (exit 2, one line) unless `--prefix` is non-empty, `--limit` is 1..300, and the open db is the live `mc.db` (an `MC_DB_PATH` pointed at a snapshot cannot trash live Drive files). Right before each trash, the path is re-checked against `jarvis_files`: a path re-created during the run is skipped (`skipped-live`), and a map row is dropped only by its exact (`path`, `drive_id`) pair. The dry run lists exactly what the same flags would trash (all of them with `--limit`, otherwise the first 15). Both modes print `prefix`, `limit` and `matched` first; apply then prints `will trash`, then the per-file lines, then `trashed / already-gone / skipped-live / failed`. Because applied rows leave the map, rerunning the same `--prefix`/`--limit` takes the next N orphans, so here `limit` pages through the set. That is not true for the backfill `limit`. Until P1 is committed, only the dry run may be used.
2. **`scripts/backfill-kb-drive.ts` takes no flags.** It uploads every unmapped row, including the 144 day-logs, so do not use it. The prefix-capable path is the admin endpoint `POST /api/admin/drive-backfill?prefix=<p>&limit=<n>`, live since build `5d88ca0`. On that endpoint `limit` is a canary, not paging: already-mapped rows count toward it. The endpoint has no dry run, so the list step is the read-only count query below.
3. Both scripts call `requireOperatorContext`. Run them from the Panel login session; a `systemd-run` unit or a Jarvis task is refused. Neither script loads `.env` (`src/google/auth.ts` reads the `GOOGLE_*` names from `process.env`). The form below uses Node 22's `--env-file` so `.env` is never shell-sourced; since P1 it is also the usage text in `reconcile-kb-drive.ts`'s header, while `backfill-kb-drive.ts`'s header still says "run via the service EnvironmentFile".
4. `ensureFolder` looks folders up with Drive `name='<segment>'` and `pageSize=1`. Drive name matching may be case-insensitive (not verified). If it is, a `projects/eurekams/` backfill can land inside the existing `eurekaMS` Drive folder, next to the old copies with the same names. Trash works by `drive_id`, so only the old copies go. The folder keeps the `eurekaMS` spelling (cosmetic). Trashing files leaves the emptied Drive folders behind (`eurekaMS`, `p`, `a`, `root/…`).
5. **Accepted race in `--apply`:** between the per-row `jarvis_files` re-check and the trash call returning there is one Drive API round trip. A path re-created inside that window can lose its live Drive copy to the trash; the next write of that file creates a new Drive copy, and the trashed one stays recoverable from Drive trash for 30 days.

## Commands

All commands run from `/root/claude/mission-control` in the Panel login session.

List step (read-only) for a trash prefix `P`:
```
sqlite3 -readonly data/mc.db "SELECT count(*) FROM drive_file_map m WHERE substr(m.path,1,length('P'))='P' AND NOT EXISTS (SELECT 1 FROM jarvis_files f WHERE f.path=m.path);"
```
List step (read-only) for a backfill prefix `P`:
```
sqlite3 -readonly data/mc.db "SELECT count(*) FROM jarvis_files f WHERE substr(f.path,1,length('P'))='P' AND NOT EXISTS (SELECT 1 FROM drive_file_map m WHERE m.path=f.path);"
```
Trash (after P1). Dry run first, then apply:
```
npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=P --limit=N
npx tsx --env-file=.env scripts/reconcile-kb-drive.ts --prefix=P --limit=N --apply
```
Backfill (available now; the header mirrors `mc-ctl`'s `api()`):
```
curl -sf -X POST -H "X-Api-Key: $(grep -oP '(?<=MC_API_KEY=).*' .env | tr -d "\"'")" "http://localhost:8080/api/admin/drive-backfill?prefix=P&limit=N"
```

## Batch plan

The operator says yes per batch. Rerun the list query before every batch. Each batch trashes or uploads ≤ 300 files.

| # | Kind | Prefix (`P`) | `limit` | Expected | Needs | Stop if |
| --- | --- | --- | ---: | ---: | --- | --- |
| T1a | trash junk | `/` | 10 | 3 | P1 | dry-run count ≠ 3, or any listed path is not absolute |
| T1b | trash junk | `root/` | 10 | 1 | P1 | count ≠ 1 |
| T1c | trash junk | `p/` | 10 | 3 | P1 | count ≠ 3 |
| T1d | trash junk | `a/` | 10 | 2 | P1 | count ≠ 2 |
| T2–T6 | trash workspace | `workspace/` | 300 | 300, 300, 300, 300, 91 | P1 | `failed` > 0 after one retry rerun; dry-run total grows between batches (a KB cleanup ran, so re-list); any listed path has a live KB row |
| T7–T12 | trash knowledge | `knowledge/execution-patterns/2026-05` … `/2026-10` (one month each) | 300 | 92, 191, 230, 203, 193, 97 | P1 | count ≠ expected; `failed` > 0 after one retry rerun; the 2026-10 batch lists any of the 45 live files (impossible by definition, so it would mean a bug) |
| B1 | backfill | `projects/eurekams/` | 3 (canary), then none | 3, then 23 | none | `failed` > 0; `uploaded` ≠ expected; after the canary, check in Drive which folder (`eurekams` or `eurekaMS`) the 3 copies landed in before the rest |
| B2 | backfill | `knowledge/` | none | 2 (`knowledge/domain/` 1 + `knowledge/` root 1) | none | `uploaded` ≠ 2 (prefix scans 165 rows; mapped rows are skipped) |
| B3 | backfill | `directives/` | none | 6 | none | `uploaded` ≠ 6 |
| B4 | backfill | `projects/proyectos-extraordinarios-27-tva/` | none | 9 | none | `uploaded` ≠ 9 |
| B5 | backfill | `projects/` (after B1, B4) | none | 8 | none | backfill list query shows ≠ 8 before the run; `uploaded` ≠ 8 |
| T13 | trash move-pairs | `projects/eurekaMS/` | 300 | 24 | P1, B1 | backfill list query for `projects/eurekams/` ≠ 0 (a successor still has no Drive copy) |
| T14 | trash move-pair | `knowledge/google_slides_analysis_` | 10 | 1 | P1, B2 | dry run lists anything other than the one `knowledge/` root orphan; `knowledge/domain/` successor unmapped |
| T15 | trash move-pair | `projects/intelligence-ops-mcp/` | 10 | 1 | P1, B1 | operator has not confirmed the successor (ambiguous: 3 basename matches) |

Never use a backfill prefix that covers `logs/` (the 144 day-logs stay
unmapped by design) or an empty prefix. Never run `scripts/backfill-kb-drive.ts`,
and never run `reconcile-kb-drive.ts --apply` without `--prefix`.

Totals: trash 2,332 (9 junk, 2,297 bulk-cleanup orphans, 26 move-pairs) and
backfill 51. After the last batch, both list queries over all paths (excluding
`logs/day-logs/` for missing) should return 0.

## Related, not in this plan

The root causes that keep creating drift remain open: bulk deletes skip Drive by
design, `moveFile` leaves the old row behind, there were 5 delete timeouts, and
queue 4a (no live-DB guard; updates that never reach Drive). Expect new orphans
after each weekly KB cleanup until those are fixed.
