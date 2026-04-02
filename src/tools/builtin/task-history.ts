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

export const taskHistoryTool: Tool = {
  name: "task_history",
  definition: {
    type: "function",
    function: {
      name: "task_history",
      description: `Query your own past task execution history. Use this to answer questions about what scheduled tasks did, what tools were called, and whether tasks succeeded or failed.

USE WHEN:
- User asks "what did the schedule do?" or "did you complete X?"
- You need to verify what actually happened in a past execution
- You want to check if a scheduled task ran and what its output was

DO NOT USE WHEN:
- You need real-time data (use web_search, shell_exec)
- You're looking for user preferences (use user_fact_list)

Returns the last N executions matching the query, with: title, status, tools called, exit reason, rounds completed, output preview, and timestamps.`,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search term to match against task titles. Use keywords from the schedule name or task description. Example: 'Conducta Humana', 'Pharma', 'daily report'.",
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
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const limit = Math.min((args.limit as number) ?? 3, 10);
    const scheduledOnly = (args.scheduled_only as boolean) ?? false;

    const db = getDatabase();

    const titleFilter = scheduledOnly
      ? "t.title LIKE '%[Scheduled]%' AND t.title LIKE @query"
      : "t.title LIKE @query";

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
           r.error
         FROM tasks t
         LEFT JOIN runs r ON r.task_id = t.task_id
         WHERE ${titleFilter}
         ORDER BY t.created_at DESC
         LIMIT @limit`,
      )
      .all({
        query: `%${query}%`,
        limit,
      }) as Array<{
      task_id: string;
      title: string;
      status: string;
      agent_type: string;
      created_at: string;
      completed_at: string | null;
      output: string | null;
      run_status: string | null;
      error: string | null;
    }>;

    if (rows.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No tasks found matching "${query}". Try broader keywords.`,
      });
    }

    const results = rows.map((row) => {
      let toolCalls: string[] = [];
      let exitReason: string | undefined;
      let roundsCompleted: number | undefined;
      let maxRounds: number | undefined;
      let outputPreview: string | undefined;

      if (row.output) {
        try {
          const parsed = JSON.parse(row.output);
          toolCalls = parsed.toolCalls ?? [];
          exitReason = parsed.exitReason;
          roundsCompleted = parsed.roundsCompleted;
          maxRounds = parsed.maxRounds;
          if (parsed.text) {
            outputPreview =
              parsed.text.length > 500
                ? parsed.text.slice(0, 500) + "..."
                : parsed.text;
          }
        } catch {
          // old format — output is raw text
          outputPreview = row.output.slice(0, 500);
        }
      }

      return {
        taskId: row.task_id,
        title: row.title,
        status: row.status,
        runStatus: row.run_status,
        agentType: row.agent_type,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        error: row.error,
        toolsCalled: toolCalls,
        exitReason,
        roundsCompleted,
        maxRounds,
        outputPreview,
      };
    });

    return JSON.stringify({ results, total: rows.length });
  },
};
