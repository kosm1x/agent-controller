/**
 * task_history — lets the LLM query its own past task executions.
 *
 * Solves the "Jarvis confabulates about what it did" problem: when asked
 * "what did the schedule do?", the LLM can now look up actual execution
 * records instead of fabricating answers.
 *
 * v5.0 S2: addresses Issue 2 from the scheduled task diagnosis.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { toMexTime } from "../../lib/timezone.js";

/** ~200 chars around the first case-insensitive occurrence of any of the
 * `terms` in `text` (earliest position wins); undefined when none is present
 * (title/ID matched, not the output). */
export function matchSnippet(
  text: string,
  terms: string | readonly string[],
): string | undefined {
  const list = typeof terms === "string" ? [terms] : terms;
  const lower = text.toLowerCase();
  let idx = -1;
  let len = 0;
  for (const t of list) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      len = t.length;
    }
  }
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + len + 100);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).replace(/\s+/g, " ") +
    (end < text.length ? "…" : "")
  );
}

export const taskHistoryTool: Tool = {
  name: "task_history",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  definition: {
    type: "function",
    function: {
      name: "task_history",
      description: `Query your own past task execution history. Use this to answer questions about what scheduled tasks did, what tools were called, and whether tasks succeeded or failed.

USE WHEN:
- User asks "what did the schedule do?" or "did you complete X?"
- You need to verify what actually happened in a past execution
- You want to check if a scheduled task ran and what its output was
- User asks what you FOUND or CONCLUDED in an earlier task ("¿qué encontraste sobre X?", "el análisis que hiciste de X") — hits with matchedIn:'output' quote the finding; the returned taskId is your citation

DO NOT USE WHEN:
- You need real-time data (use web_search, shell_exec)
- You're looking for user preferences (use user_fact_list)

Returns the last N executions matching the query (tasks still running sort last) plus total_matched (how many matched before the limit), each with: title, status, tools called, exit reason, rounds completed, output preview, matchedIn ('title' = title or task ID | 'output'), outputMatch, and timestamps.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "One or more keywords (any order); EVERY keyword must appear in the task title, the task ID, or the task's output text. Example: 'aviación', 'dentistas Oaxaca', '1e8b10b1'. Not a literal phrase: 'daily report' matches a title containing both words anywhere.",
          },
          limit: {
            type: "number",
            description:
              "Max results to return (default 3, max 10). Use 3 for recent history, 10 for deeper investigation.",
          },
          scheduled_only: {
            type: "boolean",
            description:
              "If true, only return scheduled task executions (filters out chat tasks). Default false.",
          },
          search_output: {
            type: "boolean",
            description:
              "Default true: keywords also match each task's OUTPUT (any run of the task); such hits carry matchedIn:'output' and, when the match is in the human-readable text, outputMatch (~200 chars around the keyword the title did not have). Set false to match titles/IDs only. Matching is case-insensitive for ASCII only — write accented terms as they appear ('Juárez', not 'JUÁREZ'). Keywords are literal ('shell_exec' matches the underscore).",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
    const scheduledOnly = (args.scheduled_only as boolean) ?? false;
    const db = getDatabase();

    // Keywords, not a phrase: the whole query bound as ONE `LIKE` made
    // "dentistas Oaxaca" find nothing while "dentistas" found task 9465
    // (task 9495, 2026-09-09 — same class as the 2026-05-07 em-dash KB
    // search bug). Every token must match; order is free.
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      return JSON.stringify({ results: [], message: "query is required" });
    }
    // Keywords are literal: `_` and `%` are LIKE wildcards, and this
    // operator's vocabulary is full of `shell_exec` / `task_id` (audit W2).
    const params: Record<string, string | number> = { limit };
    tokens.forEach(
      (t, i) => (params[`q${i}`] = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
    );

    // search_output (2026-09-09, filesystem-memory paper plan A.1): the run
    // output is the verbatim episode log. It is ON by default: a two-token
    // question ("dentistas Oaxaca") is itself a TITLE match once it becomes
    // a task, so any "title first, output as fallback" scheme lets the
    // question shadow the answer (task 9465 hidden behind task 9495).
    const searchOutput = args.search_output !== false;
    const E = "ESCAPE '\\'";
    const titleHit = (i: number) =>
      `(t.title LIKE @q${i} ${E} OR t.task_id LIKE @q${i} ${E})`;
    // Match across ALL of a task's runs (a finding in an earlier retry must
    // stay findable — audit W6/W7); the display row is pinned separately.
    const tokenClause = (i: number) =>
      searchOutput
        ? `(${titleHit(i)} OR EXISTS (SELECT 1 FROM runs x WHERE x.task_id = t.task_id AND x.output LIKE @q${i} ${E}))`
        : titleHit(i);
    const matchCols = tokens.map((_, i) => tokenClause(i)).join(" AND ");
    const titleFilter = scheduledOnly
      ? `t.title LIKE '%[Scheduled]%' AND ${matchCols}`
      : matchCols;
    // title_hit uses the SAME LIKE predicate that selected the row, so the
    // label cannot disagree with the filter (audit W2).
    const titleHitAll = tokens.map((_, i) => titleHit(i)).join(" AND ");
    // One row per task: the LEFT JOIN pins ONE run for display (runs.task_id
    // is not unique; a re-run task used to eat the whole LIMIT — qa-audit
    // W4): the one whose output matched the first token, else the latest.
    // Tasks still running (typically the question being answered right now)
    // sort LAST so they never consume the budget ahead of history.
    const pinOrder = searchOutput ? `(output LIKE @q0 ${E}) DESC, ` : "";
    const rows = db
      .prepare(
        `SELECT
           t.task_id,
           t.title,
           t.status,
           t.agent_type,
           t.created_at,
           t.completed_at,
           r.output,
           r.status AS run_status,
           r.error,
           (${titleHitAll}) AS title_hit,
           COUNT(*) OVER () AS total_matched
         FROM tasks t
         LEFT JOIN runs r ON r.id = (
           SELECT id FROM runs WHERE task_id = t.task_id
           ORDER BY ${pinOrder}created_at DESC, id DESC LIMIT 1
         )
         WHERE ${titleFilter}
         ORDER BY (t.status = 'running') ASC, t.created_at DESC
         LIMIT @limit`,
      )
      .all(params) as Array<{
      task_id: string;
      title: string;
      status: string;
      agent_type: string;
      created_at: string;
      completed_at: string | null;
      output: string | null;
      run_status: string | null;
      error: string | null;
      title_hit: number;
      total_matched: number;
    }>;

    if (rows.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No tasks found matching "${query}" in titles, IDs${searchOutput ? " or outputs" : ""}. Try fewer or broader keywords.`,
      });
    }

    const results = rows.map((row) => {
      let toolCalls: string[] = [];
      let exitReason: string | undefined;
      let roundsCompleted: number | undefined;
      let maxRounds: number | undefined;
      let outputPreview: string | undefined;
      let outputText: string | undefined;

      if (row.output) {
        try {
          const parsed = JSON.parse(row.output);
          toolCalls = parsed.toolCalls ?? [];
          exitReason = parsed.exitReason;
          roundsCompleted = parsed.roundsCompleted;
          maxRounds = parsed.maxRounds;
          if (parsed.text) {
            outputText = String(parsed.text);
            outputPreview =
              outputText.length > 500
                ? outputText.slice(0, 500) + "..."
                : outputText;
          }
        } catch {
          // old format — output is raw text
          outputText = row.output;
          outputPreview = row.output.slice(0, 500);
        }
      }

      // Only the human-readable text is quotable; a hit inside the JSON
      // envelope (toolCalls, exitReason) stays undefined rather than showing
      // machinery as prose (qa-audit W5).
      // "title" = every token matched the title or task ID; "output" = the
      // run output carried at least one of them.
      const matchedIn = row.title_hit ? "title" : "output";
      // Quote the token(s) the title did NOT carry — the earliest token is
      // usually the one the title already had, i.e. the least informative
      // (audit W1: "dentistas Oaxaca" quoted the table header, not Oaxaca).
      const titleId = `${row.title}\n${row.task_id}`.toLowerCase();
      const outputOnly = tokens.filter((t) => !titleId.includes(t.toLowerCase()));
      const outputMatch =
        searchOutput && outputText !== undefined
          ? matchSnippet(outputText, outputOnly.length > 0 ? outputOnly : tokens)
          : undefined;

      return {
        taskId: row.task_id,
        title: row.title,
        status: row.status,
        runStatus: row.run_status,
        agentType: row.agent_type,
        createdAt: toMexTime(row.created_at),
        completedAt: toMexTime(row.completed_at),
        error: row.error,
        toolsCalled: toolCalls,
        exitReason,
        roundsCompleted,
        maxRounds,
        outputPreview,
        matchedIn,
        ...(outputMatch !== undefined ? { outputMatch } : {}),
      };
    });

    return JSON.stringify({
      results,
      returned: rows.length,
      // Pre-LIMIT count: "3 of 204" must never read as "only 3 ever" (audit W4).
      total_matched: rows[0]?.total_matched ?? 0,
    });
  },
};
