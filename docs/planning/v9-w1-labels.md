# V9 W1 — shadow grader labels

Label ledger for the shadow-to-enforce verdict in `v9-w1-decision-2026-10.md` §6.
Shadow armed 2026-10-06 03:35 UTC (`TASK_GATES_GRADER=shadow`). One row per
graded task. The grader's own rows are the `gates.graded` trace; this file holds
only what the grader cannot know: whether the task was really done.

## Label rules

- **"excelente" = really done.** The operator's single eval word (ruled
  2026-07-12) recorded on the task as `task_outcomes.feedback_signal = 'positive'`.
  A graded task with that signal is labelled `really done` without a manual read.
- **Explicit negative = not done.** `feedback_signal = 'negative'` ("no quedó
  excelente", "no", …) labels the task `not done`.
- **Everything else is unlabelled** (`none`, `implicit_positive`, `rephrase`,
  `implicit_rephrase`). Silence is not success. The operator labels these by
  reading the task; the sampling rule from §6 applies to them: every task the
  grader flagged `failed`, plus a fifth of the rest.
- Attribution caveat: an "excelente" lands on the last reply inside the feedback
  window (or by thread lookup / the in-memory last-reply marker, unproven by real
  use). If a row's signal clearly belongs to a different exchange, overwrite the
  label by hand and say so in the note.
- A label never changes a `gates.graded` row or a task. Labels live here only.

## Derived definitions (§6)

- **False positive** = label `really done` and grader verdict `failed` on any criterion.
- **Catch** = final status `completed` or `completed_with_concerns`, label `not done`,
  grader `failed`, and the operator accepts the grader's evidence (`catch = yes`).
- **FP rate** = false positives ÷ rows labelled `really done`. Budget ≤ 10 %.

## Seed query (read-only; append new rows, never rewrite old ones)

Lists every real grade (no `reason`, no `error`) in the window with the
auto-label from the explicit signal. Run from the repo root:

```
sqlite3 -readonly -header -column data/mc.db "
SELECT e.task_id,
       substr(e.ts,1,16) AS graded_utc,
       CASE WHEN EXISTS (SELECT 1 FROM json_each(json_extract(e.attrs,'\$.criteria')) c
                         WHERE json_extract(c.value,'\$.verdict')='failed')
            THEN 'failed' ELSE 'met' END AS grader,
       COALESCE(t.status,'?') AS final_status,
       COALESCE(o.feedback_signal,'-') AS signal,
       CASE o.feedback_signal WHEN 'positive' THEN 'really done'
                              WHEN 'negative' THEN 'not done' ELSE '' END AS label
FROM task_trace_events e
LEFT JOIN tasks t ON t.task_id = e.task_id
LEFT JOIN task_outcomes o ON o.id = (SELECT id FROM task_outcomes WHERE task_id = e.task_id ORDER BY id DESC LIMIT 1)
WHERE e.name='gates.graded' AND e.ts >= datetime('now','-7 days')
  AND json_extract(e.attrs,'\$.reason') IS NULL AND json_extract(e.attrs,'\$.error') IS NULL
ORDER BY e.id;"
```

Per-criterion verdicts, criterion text and failed evidence for a row:
`./mc-ctl gates graded 7` (disagreement list). Before quoting any aggregate
below: `./mc-ctl audit-claim`.

## Rows

| task_id | graded (UTC) | grader | final status | signal | label | catch | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `9a7f547e-9fa1-4436-a8a8-a29fec733699` | 2026-10-06 05:03 | met | completed | - | really done | no | scheduled heavy root (05:0x UTC ritual) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `19d27d55-ddfd-42ed-99de-7afa230a6d78` | 2026-10-06 14:18 | met | completed | - | really done | no | swarm child Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `108642de-d0dc-4eac-8d69-1645fc203e3a` | 2026-10-07 05:02 | met | completed | - | really done | no | scheduled heavy root (05:0x UTC ritual) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `1769b7c0-3d18-4179-8265-f052ba855cd7` | 2026-10-08 05:02 | met | completed | - | really done | no | scheduled heavy root (05:0x UTC ritual) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `ca333512-e8be-45b3-aee2-218fb041e0d3` | 2026-10-08 13:40 | failed | completed | - | not done | **yes** | swarm child (parent 19b7d51a); operator read 10-09. Claimed a new section + verified URL written to a bet-book source file; the section exists in no file on disk, in no `jarvis_files` row, and the URL nowhere (checked 10-09). Run called `file_edit` (code-editing tool, self-improvement scope, no read-back gate) twice instead of `jarvis_file_write`; both returned `{error}`; the child still reported the goal complete. Grader: 3/3 criteria failed, correctly. First confirmed catch. Class queued §2026-10-08 (late) item 10. |
| `292ea4dc-c9d0-4bd3-909f-5e690b322e35` | 2026-10-08 13:41 | met | completed | - | really done | no | swarm child Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `5fd673a8-b999-4558-b4d2-dc4134193bc8` | 2026-10-08 13:41 | failed | completed_with_concerns | - | really done | no | **FALSE POSITIVE, cause = stale ground truth.** Operator read 10-09: the bet-book legal file on disk is 12,719 bytes, mtime 13:40 UTC inside the run, with the three country sections, the MP 1.394 note and 18 official URLs (all four plan criteria hold on disk). The run wrote it with `file_edit` (FS only); `jarvis_files` still holds the 5,4xx-byte pre-run copy, and the grader's `sql_check` reads that table, so both grader criteria failed against a copy the task never touched. The shell gates failed for the already-fixed cwd reason (`c583ed8`). Class queued §2026-10-08 (late) item 11 (KB registry/disk parity: 40/1,260 rows diverge). |
| `df61c55d-d281-44cd-b66d-5a6abf16d536` | 2026-10-08 13:43 | met | completed_with_concerns | - | really done | no | Operator read 10-09. Wrote the combat/LatAm section via `jarvis_file_update` (read-back met, registry current); section present on disk at L70 with 50 URL lines, checked 10-09. Grader met on both criteria, correctly. The 2 failed shell gates are the pre-fix cwd class (`c583ed8`), which is what demoted it to concerns. Grader right, gates wrong. |
| `443b5f42-99d2-4a78-99f5-cc8ec8be733d` | 2026-10-08 13:47 | met | completed_with_concerns | - | really done | no | Operator read 10-09. Wrote the 10-chapter index + source-status table into the bet-book README via `jarvis_file_update` (read-back met, 9,609 chars); grader met 3/3 on that content. The README was later restructured by chat tasks (17,564 → 2,689 chars at 03:46 UTC 10-09; index + table now live in the decisions-history file, 13 chapter lines), so the artifact is no longer in the README: judged at completion. 3 failed shell gates = cwd class. Its narration claimed the Shin section existed in fuente-6 (it does not, see `ca333512`): a false statement about a sibling's work, not about its own deliverable. |
| `dd9d01e4-a1f9-45fd-9c23-421c47035fe2` | 2026-10-08 15:21 | met | completed | - | really done | no | swarm child (10-08 15:2x batch) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `a58fc029-6d8f-42b1-b3d2-6dc4b80808d4` | 2026-10-08 15:21 | met | completed | - | really done | no | swarm child (10-08 15:2x batch) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `17b23349-8f61-456b-9a1a-eb651f4bbecb` | 2026-10-08 15:22 | met | completed | - | really done | no | swarm child (10-08 15:2x batch) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `b0ea0fe5-0588-4615-ab0c-3c8962887d62` | 2026-10-08 15:22 | met | completed | - | really done | no | swarm child (10-08 15:2x batch) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `6293dff3-2f13-46f3-baf7-e0f6ce970ef7` | 2026-10-08 15:24 | met | completed | - | really done | no | swarm child (10-08 15:2x batch) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `084d4c84-f825-49cc-a09f-46f40e9b01ac` | 2026-10-09 03:20 | met | completed | none | really done | no | heavy root; only row with a task_outcomes row (signal none) Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `341a6c51-bffb-4bb9-81d7-37943abc986f` | 2026-10-09 04:50 | met | completed | - | really done | no | ritual root (04:50 UTC), 1 gate met Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `be4e0d40-fc28-471f-ba16-bc1a9193f144` | 2026-10-09 04:58 | met | completed | - | really done | no | ritual root (04:58 UTC), 0 gates Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `371ccb8c-407a-41a3-baf3-847844e03bc5` | 2026-10-09 05:02 | met | completed | - | really done | no | ritual root (05:02 UTC), 9 criteria, 0 gates Operator label 10-09 ("gave me what I needed"); grader met = correct. |
| `ee92e973-d357-4bd3-85cc-c8c4169aefc6` | 2026-10-10 05:02 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual (05:0x UTC); report figures recomputed from task_outcomes over the same 7d window and match; get_data called, no deactivation claimed or made. |
| `b67f601b-03f9-4c25-a65c-a530574ad261` | 2026-10-11 05:02 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match; no deactivation claimed or made. |
| `24734e85-e843-4a2b-8dfb-d2373a42debf` | 2026-10-12 02:03 | met | completed | none | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). roadmap-status chat root; 5 enforce shell gates met against live HEAD/build/port. |
| `b822a8e7-e443-4f81-8f31-d31b4a0da22f` | 2026-10-12 04:09 | met | completed | none | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). venture-status chat root; KB reads traced, unverified items flagged as such; grader met 7/7. |
| `81be7850-a877-41c1-82b3-e7e61fae1f3f` | 2026-10-12 05:02 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; heavy/swarm/total match; one rounding slip (fast shown as 100 %, actual 99.7 %). |
| `60c6bf31-01a1-47cc-b295-563e796b9b72` | 2026-10-12 05:49 | met | completed | none | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). strategy-pivot context + 3 profiling questions; README readback gate met, new section present. |
| `10892384-4f51-4000-b3a6-3600ecd1856c` | 2026-10-12 22:40 | failed | completed_with_concerns | positive | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). **FALSE POSITIVE, cause = unmeetable criterion drawn from the ask.** Warehouse holds 2 tables; the ask assumed 3 plus sales data. 16 MCP calls; the answer states the gap with reasons and invents nothing; runner already flagged concerns. Operator's positive signal belongs to this task (accepted 10-19). Queue 4v. |
| `6c0b358c-7dbb-41cb-a5ba-94314f86d6cc` | 2026-10-13 05:02 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual with a 3d/7d comparison; both windows recomputed and match. |
| `188aa1be-6764-4a00-9af8-87716fcf1ba4` | 2026-10-14 05:02 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match. |
| `acc93cee-485d-4965-8128-e07169f32c87` | 2026-10-15 05:01 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match. |
| `72be95b9-c353-4827-9bbb-b9ebd6ef5eb8` | 2026-10-15 08:12 | met | completed | - | really done | no | swarm child; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). book-title record + collision search (swarm child); readback gate met, title present in README. |
| `fac38970-04d3-4242-a704-e0d9c1a18de5` | 2026-10-15 08:34 | met | completed | - | really done | no | swarm child; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). backup-title catalog search (swarm child); 9 web reads traced, one catalog flagged unreachable; manual gate abandoned. |
| `8f14a4cc-2fbc-412e-941e-0c4ac5bd02bd` | 2026-10-16 05:01 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match. |
| `f9a07113-6099-4c5b-bf77-7b4abd7df76d` | 2026-10-17 05:01 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match. |
| `38bf3002-45bb-48c2-bcb7-38dc34ecc59d` | 2026-10-17 21:40 | failed | completed | - | really done | no | swarm child; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). **FALSE POSITIVE, cause = evidence ordering.** Grader cited a folder listing taken BEFORE the gdrive_create call; the enforce readback gate shows the created sheet (A1:G2, 2 rows, header matches). Public-access inheritance unverifiable from traces (CLI results not stored). Queue 4v. |
| `359a48f0-6251-4835-afa8-32bbff868851` | 2026-10-17 22:20 | failed | completed_with_concerns | - | not done | **yes** | swarm child; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). **NOT DONE, catch.** Consolidation of four critic reports integrated one and marked another unrecoverable, although all four siblings had completed 1–2 min before it started (about 25 task_history calls; the reports reached the KB only ~30 min later). Grader failed 2/7 on exactly this; runner flagged concerns. |
| `b1a70e9d-2ed7-4e9c-853b-e075be71d6bd` | 2026-10-18 00:49 | met | completed | none | not done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). **NOT DONE.** Per-chapter plans correct, but the consolidated general plan (the goal-graph deliverable) contradicts them: two chapter titles wrong, chapter 4 swaps the requested concepts for two absent from the draft file (grep 0), a chapter 3 item dropped. Grader graded only the 2 inventory criteria and never examined it: grader `met` is a miss, not a FP by definition (no failed verdict). |
| `26651b19-207d-4dfc-a590-8c1c96e1e6d4` | 2026-10-18 05:01 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; recompute differs by 1 row (timing); runner figures match. |
| `2ab1c8c1-0d31-4ee9-8dee-f10c4063a1bb` | 2026-10-19 05:01 | met | completed | - | really done | no | root; operator accepted the Opus pre-label 10-19 (reader checked deliverable, gate rows, artifacts). scheduled evolution-report ritual; figures recomputed and match. |

## Rows — count 2 (grader prompt v2, from 2026-10-19 19:55 UTC)

Opened after count 1 missed the FP budget (3 > 2) and the grader was fixed (queue 4v: `db5bb68`, DEPLOYED 2026-10-19 19:55 UTC as build `17c4ff5`). Only grades whose `gates.graded` trace carries `prompt_v=2` count here; the count-1 rows above stay as history and are never relabelled. Seed query: the one above with `AND json_extract(e.attrs,'\$.prompt_v') = 2` added to the WHERE clause. First readout owed ~2026-10-26 (~12–16 gradeable heavy tasks per week → 30 labels in 2–3 weeks).

| task_id | graded (UTC) | grader | final status | signal | label | catch | note |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Tally (recompute from the rows, newest run first)

| as of (UTC) | graded | labelled really done | false positives | FP rate | labelled not done | catches | unlabelled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-19 19:55 (count 2 opened, `prompt_v=2` only) | 0 | 0 | 0 | – | 0 | 0 | 0 |
| 2026-10-19 18:0x (count 1 CLOSED) | 56 | 34 | 3 | 8.8 % (n=34; causes: stale ground truth ×1 (item 11), unmeetable criterion ×1, evidence ordering ×1 (queue 4v)) — **BUDGET MISSED (≤2)** | 3 | 2 | 19 (swarm children of the 10-17/10-18 batches, no failed verdicts) |
| 2026-10-09 07:0x | 18 | 17 | 1 | 5.9 % (n=17; the FP's cause = stale ground truth, item 11) | 1 | 1 | 0 |
| 2026-10-09 06:4x | 18 | 3 | 1 | 33 % (n=3; the FP's cause = stale ground truth, item 11) | 1 | 1 | 14 |
| 2026-10-09 06:2x | 18 | 1 | 1 | 100 % (n=1; cause = stale ground truth, item 11) | 1 | 1 | 16 |
| 2026-10-09 06:0x | 15 | 1 | 1 | 100 % (n=1; cause = stale ground truth, item 11) | 1 | 1 | 13 |
| 2026-10-09 05:4x | 15 | 0 | 0 | – | 1 | 1 | 14 |
| 2026-10-09 04:3x | 15 | 0 | 0 | – | 0 | 0 | 15 |
| 2026-10-06 03:50 | 0 | 0 | 0 | – | 0 | 0 | 0 |

## Population (owed weekly count, first reading 2026-10-09)

Grader population proxy = heavy tasks completed per ISO week (roots + swarm children; every grade so far was a heavy task): W35 37 · W36 13 · W37 18 · W38 11 · W39 12 · W40 16 (to 10-09). 15 grades in the first 3 days of shadow (10-06 → 10-09) came with one 5-child swarm plus a 5-child batch; the steady rate is ~12–16 per week, so 30 `really done` labels is 2–3 weeks of traffic, not days. 14 of the 15 rows have no `task_outcomes` row (scheduled roots and swarm children never get a chat rating), so the auto-label cannot fire for this population: labels are manual reads for this population (queue §2026-10-08 item 10 RULED (i) 10-09: outcome rows would carry no rating for unrated tasks, so they add 0 labels; only a rating that reaches a ritual root, i.e. reply-to attribution, would auto-label it). **Operator labelling recipe, one task at a time from the repo root: `./mc-ctl task <task_id>` then `./mc-ctl gates <task_id>`; write `really done` / `not done` in the label column and `yes` in catch when a grader `failed` matches a real defect. Start with the two grader-failed rows.**

## Activation checklist (all three, §6)

- [ ] ≥ 30 rows labelled `really done` with ≤ 2 false positives (0/30 is the only count that bounds the true rate at 10 %). **34/30 as of 2026-10-19 but 3 FP: MISSED. Per the rule below: fix the grader (queue 4v: unmeetable-criterion + evidence-ordering defects), then restart the count in a new Rows section.** **Count 1 CLOSED at 34 really done / 3 FP; grader fixed (4v `db5bb68`, DEPLOYED 2026-10-19 19:55 UTC); count 2 OPEN from 19:55 UTC on `prompt_v=2` grades: 0/30.** Earlier: 17/30 as of 2026-10-09, 1 FP (stale-registry cause, item 11). Operator rule for labelling, ruled 10-09: a task is `really done` when the operator got what they needed from it when it arrived; no re-read required.**
- [x] ≥ 1 confirmed catch — `359a48f0` (2026-10-19: consolidation claimed four reports integrated, one integrated) and `ca333512` (2026-10-09, operator read): completed-claim with no artifact, grader failed 3/3 criteria.
- [ ] Median added latency and cost per graded task reported (`./mc-ctl gates graded 30`, `cost_ledger` agent_type `v9:grader`) and accepted by the operator. **Reported 2026-10-09 (n=15, 10-06 → 10-09, read-only SQL over `gates.graded` + `cost_ledger`; `mc-ctl audit-claim` has no grader metric, operator re-reads with `./mc-ctl gates graded 30`):** latency median 20.4 s (min 9.2 s, max 30.5 s; shadow runs in the background so no task waited; under enforce this is added wall-clock per graded task) · cost median $0.20 per task, total $3.11, 15 ledger rows under `v9:grader` match the 15 traces · 64 criteria graded (4.3 per task). Acceptance = operator.
- [x] Before enforce: queue §2026-10-06 item 1 (enforce-mode concurrency cap) shipped — `e7629fa` 2026-10-09 (one 4-slot pool across modes; over the cap the grade rows are ABANDONED `skipped_concurrency`, never demoted; 3 tests, 8 mutants caught, audit R1 folded). DEPLOYED 2026-10-09 05:12 UTC as build `a87ddb8` (PID 2596714, health 200, 0 startup errors).

If the FP budget is missed: fix the grader prompt or the criterion selection, then
restart the count from a new "Rows" section. Never lower the bar.
