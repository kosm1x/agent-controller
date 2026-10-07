# Scheduled jobs: zero-tool runs under Sonnet 5.5 (queue §2026-10-07 item 1)

Date: 2026-10-07. Source: `data/mc.db` read-only (`tasks`, `task_trace_events` `name='tool.called'`, `cost_ledger`, `scheduled_tasks`, `ritual_sent_items`). All times UTC.

## Windows

| Window | From | To | Fast-tier model |
| --- | --- | --- | --- |
| prior | 2026-09-21 11:08 | 2026-09-29 05:09 | claude-sonnet-4-6 |
| canary | 2026-09-29 05:09 | 2026-10-06 23:10 | claude-sonnet-5-5 (low) |

The aggregate numbers reproduce: scheduled (`metadata.tags` has `scheduled`) fast tasks averaged 5.74 tools/task in the prior window (n 34) and 3.12 in the canary (n 42). Ritual fast tasks averaged 7.45 (n 49) and 5.59 (n 49).

## The two zero-tool schedules

Per-run counts are `tool.called` events per task.

| Schedule | Window | Runs | Runs with 0 tools | Tools/run | Output tokens/run |
| --- | --- | --- | --- | --- | --- |
| Transición al Posthumanismo (`9081e6cd`, plus predecessor `bdb82f0c` before 09-23) | prior | 7 | 0 | 2.4 (1–3) | 1,095 |
| | canary | 6 | **6** | 0 | 830 |
| BAD OSTRICH family: Waiver Wire `2360d3a6`, Lineup Lock `1acc4af2`, Chequeo Final `74fb732c` | prior | 3 | 0 | 1 | 318 |
| | canary | 4 | **4** | 0 | 340 |

Per run:

| Schedule | Run (created_at) | Model | Tools | Out tokens | Status |
| --- | --- | --- | --- | --- | --- |
| Posthumanismo | 09-23 18:00 (`bdb82f0c`) | 4.6 | 1 | 907 | completed |
| Posthumanismo | 09-23 20:07 | 4.6 | 2 | 1,101 | completed |
| Posthumanismo | 09-24 18:00 | 4.6 | 2 | 1,059 | completed |
| Posthumanismo | 09-25 18:00 | 4.6 | 3 | 1,280 | completed |
| Posthumanismo | 09-28 18:00 | 4.6 | 3 | 1,280 | completed |
| Posthumanismo | 09-29 18:00 | 5.5 | 0 | 814 | completed |
| Posthumanismo | 09-30 18:00 | 5.5 | 0 | 769 | completed |
| Posthumanismo | 10-01 18:00 | 5.5 | 0 | 746 | completed |
| Posthumanismo | 10-02 18:00 | 5.5 | 0 | 851 | completed |
| Posthumanismo | 10-05 18:00 | 5.5 | 0 | 980 | completed |
| Posthumanismo | 10-06 18:00 | 5.5 | 0 | 822 | completed |
| Waiver Wire | 09-22 15:00 | 4.6 | 1 | 323 | completed |
| Waiver Wire | 09-29 15:00 | 5.5 | 0 | 177 | completed |
| Waiver Wire | 10-06 15:00 | 5.5 | 0 | 495 | completed_with_concerns |
| Lineup Lock | 09-24 22:00 | 4.6 | 1 | 274 | completed |
| Lineup Lock | 10-01 22:00 | 5.5 | 0 | 277 | completed |
| Chequeo Final | 09-27 15:00 | 4.6 | 1 | 358 | completed |
| Chequeo Final | 10-04 15:00 | 5.5 | 0 | 382 | completed |

(The 09-21/09-22 Posthumanismo rows ran under the predecessor schedule `bdb82f0c`, 1 `jarvis_file_read` each; the 09-23 18:00 row is the last of those.)

## What 5.5 is now obeying

### Posthumanismo: a conditional tool step

The stored prompt (`scheduled_tasks.description`, schedule `9081e6cd`, tools `web_search`, `web_read`) makes the search conditional on citing someone:

> `2. **Si vas a citar a un autor o atribuir una idea específica a alguien** (Bostrom, Haraway, Kurzweil, Tegmark, etc.):` → `Usa web_search para verificar…`

It also states the no-citation route outright:

> `…o simplemente no la atribuyas — desarrolla la idea en primera persona como reflexión propia.`
> `Si no hay cita externa: cerrar con una pregunta abierta para Fede.`
> `Una reflexión honesta sin cita gana a una reflexión brillante con cita fabricada.`

Side by side: every 4.6 run opened by announcing it would research a topic, then cited a verified source with a URL. Every 5.5 run is titled as its own reflection and closes with an explicit "no external citation" note and the open question. That is the branch the prompt allows, taken every time. The output stayed in the required format (title, 3–5 paragraphs, closing question), but it no longer uses any source.

### BAD OSTRICH: a fixed message plus a "do not repeat" list

All three prompts end with:

> `El mensaje anterior ES el deliverable — entrégalo tal cual.`

- **Lineup Lock and Chequeo Final are correct at 0 tools.** The single 4.6 call was a gratuitous `jarvis_file_read` ("check the project memory"), and the delivered text matched the template both before and after the swap. Nothing needs fixing here.
- **Waiver Wire is a real defect, and it is in code.** `promptExtras` (`src/rituals/dynamic.ts`) appends `sentBeforeBlock` (`src/rituals/sent-before.ts`). Because the reminder repeats its own fixed points every week, that block listed those three points as `## YA ENVIADO en los últimos 14 días — NO lo repitas`. 4.6 ignored the block (09-22: the block was present and the reminder still went out in full). 5.5 obeyed it:
  - On 09-29 it replaced the reminder with a "nothing new this week" line.
  - On 10-06 the block also carried the 7d3faa6 line `Primero reúne los hallazgos de hoy con tus herramientas, como pide la tarea`. The model added a disclaimer that it had consulted no data source, and the task closed `completed_with_concerns`. A fixed reminder with no data source cannot follow that line.

  This is the same class as 7d3faa6: an injected instruction aimed at one population (schedules that find new items) also reached a population it does not fit (fixed-message schedules).

## Fix

1. **Code (Waiver Wire and any fixed-message schedule).** `sentBeforeBlock(ritualId, days, template)` drops every recently sent item that repeats a line of the schedule's own prompt. It uses the ledger's own identity: the same key, or a token Jaccard of at least 0.6, so a reworded copy of a template line counts too. `promptExtras` passes `schedule.description`. When every listed item is template text, the block is empty and the reminder goes out as written.
   - `src/rituals/sent-before.ts`: `sentBeforeBlock`.
   - `src/rituals/dynamic.ts`: `promptExtras`, the non-Morning-Sync branch. It is the only caller, and both the cron path and `executeScheduleNow` go through it.
   - Tests: `src/rituals/sent-before.test.ts` ("leaves the schedule's own template lines off the list") and `src/rituals/dynamic-budget.test.ts` ("omits lines of its own prompt"). Mutation check: disabling the filter turns both RED; dropping the `schedule.description` argument turns the promptExtras test RED.
   - **Blast radius** (read-only replay over each active schedule's current 14-day ledger):
     - Waiver Wire: drops 3 of 3, so the block becomes empty.
     - Renovar redlightinsider: drops 1 of 5. That item is the prompt's own "Ve a 👉 hpanel…" step.
     - Pharma (137), Posthumanismo (12) and Morning Sync (46): 0 dropped. Morning Sync does not take this path anyway.
     - Every other active schedule: the ledger is empty, so there is nothing to drop.
2. **DB (Posthumanismo): an operator paste. The DB was not written.** The SQL changes step 2 so that one `web_search` and `web_read` is mandatory in every run, while the citation itself stays optional. The verification rules are unchanged. It is idempotent: the `WHERE` requires the old line and the absence of the new one, so a second run reports `rows_updated 0`. It was dry-run twice on an in-memory one-row table built from the stored text: first run `rows_updated 1`, second run `0`. The scheduler reads `scheduled_tasks` every minute, so no restart is needed.
   - File: `/root/claude/mission-control/docs/planning/sched-tool-regression-2026-10-07/fix.sql`
   - Paste: `cd /root/claude/mission-control && ./mc-ctl db < /root/claude/mission-control/docs/planning/sched-tool-regression-2026-10-07/fix.sql`. With no argument, `mc-ctl db` runs `sqlite3` on stdin.
   - Verify (read-only): `sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT instr(description,'web_search al menos una vez')>0 AS search_mandatory, length(description) FROM scheduled_tasks WHERE schedule_id='9081e6cd-fa0b-45f7-ad67-71deabc99275'"` should print `1|2110`.
   - Undo: the same `replace()` with the two strings swapped.
   - Whether a sourced reflection is what the operator wants is a content ruling. The 4.6 behaviour, and the web tools attached on 09-23, point that way.

## Residuals (not the two zero-tool schedules)

- **Morning Sync, 7.9 → 5.8 tools.** Partly by design. Since `634e4c5` (10-01), the system pre-loads the day-logs and tells the model not to re-read them, so `jarvis_file_list` and `jarvis_file_read` drop out of most runs (10-03 to 10-06: 4–5 tools, no `jarvis_file_list` on 3 of 4).
- **Pharma, 10.5 → 3.9 tools/run and 6.5k → 2.7k output tokens.** The prompt asks for `mínimo 6 queries`. After the fix, 5.5 runs 3–7 tools, `web_search` plus `gmail_send`, so it under-obeys that line rather than over-obeying one. Every post-fix run is `completed_with_concerns`. Its sent-before list holds 137 heads under `NO lo repitas`, which is a plausible cause of the shorter reports. Not diagnosed here; it belongs with queue item 2 (concern step) or its own ticket.

## Re-measure: 7 days after the deploy and the operator SQL

Read-only. Set `:since` to the later of the two (deploy time or SQL time):

```sql
SELECT substr(metadata, instr(metadata,'schedule:')+9, 8) AS sid,
       substr(title, 13, 40) AS schedule, count(*) AS runs,
       sum((SELECT count(*) FROM task_trace_events e WHERE e.task_id=t.task_id AND e.name='tool.called') = 0) AS zero_tool_runs,
       round(avg((SELECT count(*) FROM task_trace_events e WHERE e.task_id=t.task_id AND e.name='tool.called')), 2) AS tools_per_run,
       round(avg((SELECT sum(completion_tokens) FROM cost_ledger c WHERE c.task_id=t.task_id))) AS out_tokens,
       sum(status='completed_with_concerns') AS concerns
FROM tasks t
WHERE created_at >= :since AND metadata LIKE '%"scheduled"%'
GROUP BY sid ORDER BY sid;
```

Pass criteria:

- Posthumanismo: at least 1 `web_search` in every run.
- Waiver Wire (Tuesdays): the full reminder text is delivered, the status is `completed`, and 0 tools is fine.
- Lineup Lock and Chequeo Final: unchanged, with the template delivered.
