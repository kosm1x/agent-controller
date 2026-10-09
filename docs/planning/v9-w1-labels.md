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
| `9a7f547e-9fa1-4436-a8a8-a29fec733699` | 2026-10-06 05:03 | met | completed | - |  |  | scheduled heavy root (05:0x UTC ritual) |
| `19d27d55-ddfd-42ed-99de-7afa230a6d78` | 2026-10-06 14:18 | met | completed | - |  |  | swarm child |
| `108642de-d0dc-4eac-8d69-1645fc203e3a` | 2026-10-07 05:02 | met | completed | - |  |  | scheduled heavy root (05:0x UTC ritual) |
| `1769b7c0-3d18-4179-8265-f052ba855cd7` | 2026-10-08 05:02 | met | completed | - |  |  | scheduled heavy root (05:0x UTC ritual) |
| `ca333512-e8be-45b3-aee2-218fb041e0d3` | 2026-10-08 13:40 | failed | completed | - |  |  | swarm child (parent 19b7d51a, 10-08 13:38); grader failed — READ FIRST (candidate catch) |
| `292ea4dc-c9d0-4bd3-909f-5e690b322e35` | 2026-10-08 13:41 | met | completed | - |  |  | swarm child |
| `5fd673a8-b999-4558-b4d2-dc4134193bc8` | 2026-10-08 13:41 | failed | completed_with_concerns | - |  |  | swarm child (parent 19b7d51a); grader failed — READ FIRST (candidate catch) |
| `df61c55d-d281-44cd-b66d-5a6abf16d536` | 2026-10-08 13:43 | met | completed_with_concerns | - |  |  | swarm child |
| `443b5f42-99d2-4a78-99f5-cc8ec8be733d` | 2026-10-08 13:47 | met | completed_with_concerns | - |  |  | swarm child |
| `dd9d01e4-a1f9-45fd-9c23-421c47035fe2` | 2026-10-08 15:21 | met | completed | - |  |  | swarm child (10-08 15:2x batch) |
| `a58fc029-6d8f-42b1-b3d2-6dc4b80808d4` | 2026-10-08 15:21 | met | completed | - |  |  | swarm child (10-08 15:2x batch) |
| `17b23349-8f61-456b-9a1a-eb651f4bbecb` | 2026-10-08 15:22 | met | completed | - |  |  | swarm child (10-08 15:2x batch) |
| `b0ea0fe5-0588-4615-ab0c-3c8962887d62` | 2026-10-08 15:22 | met | completed | - |  |  | swarm child (10-08 15:2x batch) |
| `6293dff3-2f13-46f3-baf7-e0f6ce970ef7` | 2026-10-08 15:24 | met | completed | - |  |  | swarm child (10-08 15:2x batch) |
| `084d4c84-f825-49cc-a09f-46f40e9b01ac` | 2026-10-09 03:20 | met | completed | none |  |  | heavy root; only row with a task_outcomes row (signal none) |

## Tally (recompute from the rows, newest run first)

| as of (UTC) | graded | labelled really done | false positives | FP rate | labelled not done | catches | unlabelled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-09 04:3x | 15 | 0 | 0 | – | 0 | 0 | 15 |
| 2026-10-06 03:50 | 0 | 0 | 0 | – | 0 | 0 | 0 |

## Population (owed weekly count, first reading 2026-10-09)

Grader population proxy = heavy tasks completed per ISO week (roots + swarm children; every grade so far was a heavy task): W35 37 · W36 13 · W37 18 · W38 11 · W39 12 · W40 16 (to 10-09). 15 grades in the first 3 days of shadow (10-06 → 10-09) came with one 5-child swarm plus a 5-child batch; the steady rate is ~12–16 per week, so 30 `really done` labels is 2–3 weeks of traffic, not days. 14 of the 15 rows have no `task_outcomes` row (scheduled roots and swarm children never get a chat rating), so the auto-label cannot fire for this population: labels are manual reads until queue §2026-10-08 item 10 is ruled, and even then only chat-rated tasks auto-label.

## Activation checklist (all three, §6)

- [ ] ≥ 30 rows labelled `really done` with ≤ 2 false positives (0/30 is the only count that bounds the true rate at 10 %).
- [ ] ≥ 1 confirmed catch.
- [ ] Median added latency and cost per graded task reported (`./mc-ctl gates graded 30`, `cost_ledger` agent_type `v9:grader`) and accepted by the operator. **Reported 2026-10-09 (n=15, 10-06 → 10-09, read-only SQL over `gates.graded` + `cost_ledger`; `mc-ctl audit-claim` has no grader metric, operator re-reads with `./mc-ctl gates graded 30`):** latency median 20.4 s (min 9.2 s, max 30.5 s; shadow runs in the background so no task waited; under enforce this is added wall-clock per graded task) · cost median $0.20 per task, total $3.11, 15 ledger rows under `v9:grader` match the 15 traces · 64 criteria graded (4.3 per task). Acceptance = operator.
- [x] Before enforce: queue §2026-10-06 item 1 (enforce-mode concurrency cap) shipped — `e7629fa` 2026-10-09 (one 4-slot pool across modes; over the cap the grade rows are ABANDONED `skipped_concurrency`, never demoted; 3 tests, 8 mutants caught, audit R1 folded). DEPLOY PENDING (operator).

If the FP budget is missed: fix the grader prompt or the criterion selection, then
restart the count from a new "Rows" section. Never lower the bar.
