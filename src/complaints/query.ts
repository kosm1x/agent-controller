/**
 * SQL for the complaints digest (scripts/complaints-digest.ts). One SELECT,
 * run only by scripts/complaints-digest.sh through `sqlite3 -readonly -json`.
 *
 * Bound parameters (set by the printed script with `.parameter set`):
 *   @since, @now  UTC 'YYYY-MM-DD HH:MM:SS', the same shape as tasks.created_at.
 *
 * One row per recurring task in the window: a task whose metadata carries a
 * `ritualId` or a `schedule:<id>` tag. Every JSON read is behind json_valid /
 * json_type, so a malformed metadata or output value never fails the query:
 * malformed metadata leaves the task untyped (dropped), malformed output
 * leaves its audit empty while the run itself is still returned. The window
 * is (@since, @now]. The reply tail falls back to tasks.error when the reply
 * text is missing or blank. `tools` counts the run's `tool.called` trace
 * events: calls the model attempted, not calls a tool ran.
 *
 * With `facts` (the database has task_completion_facts, schema 18 on): the
 * concern text is the task's non-blank task_completion_facts.concern_detail,
 * else the task_outcomes one, and the row carries the task's `build` (NULL
 * when the task has no facts row or no known build). Status and time stay
 * from tasks: a facts row exists from the start of a run, and its created_at
 * is not read. Without `facts` the SQL has no `build` column and never names
 * that table, so it runs on older databases.
 *
 * With `guards` (ledger mode only; the digest and verdict SQL are unchanged
 * without it): one more column, `guard_tools`, what a ledger guard counts per
 * tool: `tool.called` rows minus the run's `tool.gated` rows whose decision is
 * in GATED_NOT_RUN (floored at 0), both written no later than the run's
 * completed_at second (inclusive; a row with no completed_at keeps them all).
 * There is no trace event for a call that ran, so a call refused anywhere
 * else (external-request policy, secret-reference check) or one that ran and
 * errored still counts. The completed_at bound keeps a run's counts final: a
 * run failed by the stuck-task watchdog while its runner is still alive could
 * otherwise gain rows after it was counted.
 * Columns match TaskRow in src/complaints/digest.ts.
 */

/**
 * Every `tool.gated` decision written in src (gateSdkToolCall in
 * src/inference/claude-sdk.ts, noteUndeclaredRefusal in
 * src/tools/task-executor.ts). Each is written on a path that hands the model
 * a refusal or a confirmation card instead of running the tool; an approved
 * card runs later in the router, outside the run. digest.test.ts pins this
 * list against the decision literals in those two files.
 */
export const GATED_NOT_RUN = [
  "confirmation_required",
  "queued_with_pending",
  "queued_duplicate",
  "refused_already_pending",
  "refused_turn_ended",
  "refused_placeholder",
  "refused_cannot_ask",
  "refused_no_context",
  "refused_undeclared",
];
const OUTCOME_DETAIL = `(SELECT o.concern_detail FROM task_outcomes o
    WHERE o.task_id = b.task_id AND trim(coalesce(o.concern_detail, '')) <> ''
    ORDER BY o.id DESC LIMIT 1)`;

const FACTS_DETAIL = `(SELECT f.concern_detail FROM task_completion_facts f
    WHERE f.task_id = b.task_id AND trim(coalesce(f.concern_detail, '')) <> '')`;

export function complaintsSql(facts: boolean, guards = false): string {
  const concernDetail = facts ? `coalesce(${FACTS_DETAIL},\n  ${OUTCOME_DETAIL})` : OUTCOME_DETAIL;
  const build = facts ? `,\n  (SELECT f.build FROM task_completion_facts f WHERE f.task_id = b.task_id) AS build` : "";
  const guardTools = guards
    ? `,
  (SELECT json_group_object(c.tool, c.n) FROM (
     SELECT e.tool, max(0, sum(CASE e.name WHEN 'tool.called' THEN 1 ELSE -1 END)) AS n FROM task_trace_events e
     WHERE e.task_id = b.task_id AND e.tool IS NOT NULL
       AND (e.name = 'tool.called' OR (e.name = 'tool.gated'
         AND CASE WHEN json_valid(e.attrs) THEN json_extract(e.attrs, '$.decision') END IN (${GATED_NOT_RUN.map((d) => `'${d}'`).join(", ")})))
       AND (b.completed_at IS NULL OR replace(substr(e.ts, 1, 19), 'T', ' ') <= b.completed_at)
     GROUP BY e.tool ORDER BY e.tool) c) AS guard_tools`
    : "";
  return `WITH base AS (
  SELECT t.task_id, t.status, t.created_at, t.output, t.error${guards ? ", t.completed_at" : ""},
    CASE WHEN json_valid(t.metadata) AND json_type(t.metadata, '$.ritualId') = 'text'
      THEN nullif(json_extract(t.metadata, '$.ritualId'), '') END AS ritual_id,
    CASE WHEN json_valid(t.metadata) AND json_type(t.metadata, '$.tags') = 'array' THEN
      (SELECT nullif(substr(j.value, 10), '') FROM json_each(t.metadata, '$.tags') j
        WHERE j.type = 'text' AND substr(j.value, 1, 9) = 'schedule:' ORDER BY j.id LIMIT 1)
    END AS schedule_id
  FROM tasks t
  WHERE t.created_at > @since AND t.created_at <= @now
)
SELECT b.task_id, b.status, b.created_at, b.ritual_id, b.schedule_id,
  (SELECT s.name FROM scheduled_tasks s WHERE s.schedule_id = b.schedule_id) AS schedule_name,
  (SELECT json_group_object(c.tool, c.n) FROM (
     SELECT e.tool, count(*) AS n FROM task_trace_events e
     WHERE e.task_id = b.task_id AND e.name = 'tool.called' AND e.tool IS NOT NULL
     GROUP BY e.tool ORDER BY e.tool) c) AS tools${guardTools},
  CASE WHEN json_valid(b.output) AND json_type(b.output, '$.numbers_audit') = 'object'
    THEN 1 ELSE 0 END AS has_audit,
  CASE WHEN json_valid(b.output) AND json_type(b.output, '$.numbers_audit.unverified') = 'array'
    THEN json_extract(b.output, '$.numbers_audit.unverified') END AS unverified,
  ${concernDetail} AS concern_detail,
  substr(coalesce(nullif(trim(CASE WHEN json_valid(b.output) AND json_type(b.output, '$.text') = 'text'
    THEN json_extract(b.output, '$.text') END, ' ' || char(9, 10, 13)), ''), b.error), -600) AS reply_tail${build}
FROM base b
WHERE b.ritual_id IS NOT NULL OR b.schedule_id IS NOT NULL
ORDER BY b.created_at, b.task_id;`;
}
