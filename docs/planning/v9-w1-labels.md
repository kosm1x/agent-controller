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

## Tally (recompute from the rows, newest run first)

| as of (UTC) | graded | labelled really done | false positives | FP rate | labelled not done | catches | unlabelled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-06 03:50 | 0 | 0 | 0 | – | 0 | 0 | 0 |

## Activation checklist (all three, §6)

- [ ] ≥ 30 rows labelled `really done` with ≤ 2 false positives (0/30 is the only count that bounds the true rate at 10 %).
- [ ] ≥ 1 confirmed catch.
- [ ] Median added latency and cost per graded task reported (`./mc-ctl gates graded 30`, `cost_ledger` agent_type `v9:grader`) and accepted by the operator.
- [ ] Before enforce: queue §2026-10-06 item 1 (enforce-mode concurrency cap) shipped.

If the FP budget is missed: fix the grader prompt or the criterion selection, then
restart the count from a new "Rows" section. Never lower the bar.
