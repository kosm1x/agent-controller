/**
 * Jarvis MCP tool registrations (v7.7).
 *
 * 8 read-only tools that let Claude Code sessions query live Jarvis state:
 *   1. jarvis_status               — service health + metrics snapshot
 *   2. jarvis_task_list             — list recent tasks with filters
 *   3. jarvis_task_detail           — full task record for a task_id
 *   4. jarvis_memory_query          — semantic search over memory banks
 *   5. jarvis_schedule_list         — active scheduled tasks
 *   6. jarvis_recent_events         — events from last N hours
 *   7. jarvis_reflector_gap_stats   — autoreason gap telemetry distribution
 *   8. jarvis_feedback_search       — grep over memory/feedback_*.md files
 *
 * Each handler returns `{ok: true, data: ...}` or `{ok: false, error: ...}`
 * serialized to JSON in a single text content block. No writes. No mutations.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../../lib/logger.js";
import { searchFeedback } from "./feedback-grep.js";
import { redactDeep } from "./redact.js";
import type { McpDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function ok(data: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ ok: true, data }, null, 2) },
    ],
  };
}

/**
 * Tool error with correlation id. The raw exception stays in server-side
 * logs; the client only sees a generic code + correlation id for support.
 * This closes the "exception-message information disclosure" gap (v7.7.1
 * audit finding M2) without making debugging impossible.
 */
function toolErr(toolName: string, e: unknown): ToolResult {
  const correlationId = randomUUID();
  logger.error(
    {
      tool: toolName,
      correlation_id: correlationId,
      err: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    },
    "mcp_tool_failed",
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: `${toolName} failed`,
            correlation_id: correlationId,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Shape a user-facing "not found" / "bad input" error. These are NOT
 * logged at error level because they're expected outcomes, but they
 * still carry a correlation id for consistency with toolErr.
 */
function clientErr(toolName: string, reason: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { ok: false, error: `${toolName}: ${reason}` },
          null,
          2,
        ),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerJarvisTools(server: McpServer, deps: McpDeps): void {
  // -------------------------------------------------------------------------
  // 1. jarvis_status
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_status",
    {
      description:
        "Live Jarvis service health + metrics snapshot. Returns pid, uptime, memory use, task counts by status, DB size, and inference/memory health. Equivalent of `./mc-ctl status` but structured.",
      inputSchema: {},
    },
    async () => {
      try {
        const now = Date.now();
        const uptimeSec = Math.floor((now - deps.startedAt) / 1000);
        const memMB = Math.round(process.memoryUsage().rss / (1024 * 1024));

        const taskCounts = deps.db
          .prepare("SELECT status, COUNT(*) as n FROM tasks GROUP BY status")
          .all() as Array<{ status: string; n: number }>;

        const countsByStatus: Record<string, number> = {};
        let totalTasks = 0;
        for (const row of taskCounts) {
          countsByStatus[row.status] = row.n;
          totalTasks += row.n;
        }

        const last24hTasks = (
          deps.db
            .prepare(
              "SELECT COUNT(*) as n FROM tasks WHERE created_at >= datetime('now','-24 hours')",
            )
            .get() as { n: number }
        ).n;

        const memoryHealthy = await deps.memory.isHealthy().catch(() => false);

        return ok({
          pid: process.pid,
          uptimeSec,
          memMB,
          totalTasks,
          tasksByStatus: countsByStatus,
          tasksLast24h: last24hTasks,
          memoryBackend: deps.memory.backend,
          memoryHealthy,
          nodeVersion: process.version,
        });
      } catch (e) {
        return toolErr("jarvis_status", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 2. jarvis_task_list
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_task_list",
    {
      description:
        "List recent Jarvis tasks with optional filters. Useful for 'what did Jarvis work on recently', 'show recent failures', etc. Returns task_id, title, status, agent_type, created_at. Max 100 rows.",
      inputSchema: {
        status: z
          .enum([
            "pending",
            "classifying",
            "queued",
            "running",
            "completed",
            "completed_with_concerns",
            "needs_context",
            "blocked",
            "failed",
            "cancelled",
          ])
          .optional()
          .describe("Filter by task status"),
        since: z
          .string()
          .optional()
          .describe(
            "ISO datetime or SQLite datetime string; only tasks created after this point",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows to return (default 20, max 100)"),
      },
    },
    async (args) => {
      try {
        const limit = args.limit ?? 20;
        const clauses: string[] = [];
        const params: unknown[] = [];

        if (args.status) {
          clauses.push("status = ?");
          params.push(args.status);
        }
        if (args.since) {
          clauses.push("created_at >= ?");
          params.push(args.since);
        }

        const where =
          clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const sql = `
          SELECT task_id, title, status, agent_type, priority, created_at, completed_at
          FROM tasks
          ${where}
          ORDER BY created_at DESC
          LIMIT ?
        `;

        const rows = deps.db.prepare(sql).all(...params, limit) as Array<{
          task_id: string;
          title: string;
          status: string;
          agent_type: string | null;
          priority: string;
          created_at: string;
          completed_at: string | null;
        }>;

        return ok({ count: rows.length, tasks: rows });
      } catch (e) {
        return toolErr("jarvis_task_list", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3. jarvis_task_detail
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_task_detail",
    {
      description:
        "Full record for a single task including description, output, error, metadata, and timestamps. Use jarvis_task_list first to find the task_id.",
      inputSchema: {
        task_id: z.string().describe("UUID of the task"),
      },
    },
    async (args) => {
      try {
        const row = deps.db
          .prepare(
            `SELECT task_id, parent_task_id, spawn_type, title, description, priority, status, agent_type, classification, assigned_to, input, output, error, progress, metadata, created_at, updated_at, started_at, completed_at
             FROM tasks
             WHERE task_id = ?`,
          )
          .get(args.task_id);

        if (!row) {
          return clientErr(
            "jarvis_task_detail",
            `task not found: ${args.task_id}`,
          );
        }

        // Best-effort subtask lookup — not every task has children.
        const children = deps.db
          .prepare(
            "SELECT task_id, title, status, created_at FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
          )
          .all(args.task_id);

        // v7.7.1 M3 fix: redact secrets before returning. `input`, `output`,
        // `metadata`, `error` columns can contain API keys, OAuth tokens,
        // bearer credentials pasted by the user or captured from tool output.
        // The read_only scope label is not a confidentiality guarantee — a
        // stolen bearer token should not hand back the full credential corpus.
        return ok({
          task: redactDeep(row),
          subtasks: redactDeep(children),
        });
      } catch (e) {
        return toolErr("jarvis_task_detail", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 4. jarvis_memory_query
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_memory_query",
    {
      description:
        "Semantic + keyword search over Jarvis memory banks. Banks: mc-operational (feedback, corrections, procedures), mc-jarvis (personality + self-knowledge), mc-system (infra state). Returns ranked MemoryItem results with relevance + trust tier.",
      inputSchema: {
        query: z.string().describe("Natural-language or keyword query"),
        bank: z
          .enum(["mc-operational", "mc-jarvis", "mc-system"])
          .optional()
          .describe("Which memory bank (default: mc-operational)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter by tags (AND semantics)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max results (default 10, max 50)"),
      },
    },
    async (args) => {
      try {
        const items = await deps.memory.recall(args.query, {
          bank: args.bank ?? "mc-operational",
          tags: args.tags,
          maxResults: args.limit ?? 10,
        });
        return ok({
          count: items.length,
          bank: args.bank ?? "mc-operational",
          items,
        });
      } catch (e) {
        return toolErr("jarvis_memory_query", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 5. jarvis_schedule_list
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_schedule_list",
    {
      description:
        "List Jarvis scheduled tasks (rituals, reminders, recurring jobs) with cron expressions, delivery channels, and last run timestamps. Defaults to active-only.",
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe(
            "If true (default), only active schedules; if false, all (including inactive).",
          ),
      },
    },
    async (args) => {
      try {
        const activeOnly = args.active ?? true;
        const rows = deps.db
          .prepare(
            `SELECT schedule_id, name, description, cron_expr, delivery, email_to, active, last_run_at, created_at
             FROM scheduled_tasks
             ${activeOnly ? "WHERE active = 1" : ""}
             ORDER BY created_at DESC`,
          )
          .all();
        return ok({ count: (rows as unknown[]).length, schedules: rows });
      } catch (e) {
        return toolErr("jarvis_schedule_list", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 6. jarvis_recent_events
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_recent_events",
    {
      description:
        "Recent events from the Jarvis event bus — task.*, reaction.*, notification.*, mcp_call, etc. Filterable by hours/category/type. Use to surface errors, reactions, state changes.",
      inputSchema: {
        hours: z
          .number()
          .int()
          .min(1)
          .max(168)
          .optional()
          .describe("Lookback window in hours (default 24, max 168 = 1 week)"),
        category: z
          .string()
          .optional()
          .describe(
            "Event category (task, reaction, notification, mcp_call, ...)",
          ),
        type: z
          .string()
          .optional()
          .describe("Event type (task.failed, reaction.triggered, ...)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max rows (default 50, max 500)"),
      },
    },
    async (args) => {
      try {
        const hours = args.hours ?? 24;
        const limit = args.limit ?? 50;
        // v7.7.1 C2 fix: bind the hours window as a SQL parameter instead
        // of interpolating into the query string. Zod already constrains
        // `hours` to a positive int, but the previous `-${hours} hours`
        // pattern was a latent SQLi trap — one schema relaxation and the
        // authenticated endpoint becomes an injection vector.
        const clauses: string[] = ["timestamp >= datetime('now', ?)"];
        const params: unknown[] = [`-${hours} hours`];
        if (args.category) {
          clauses.push("category = ?");
          params.push(args.category);
        }
        if (args.type) {
          clauses.push("type = ?");
          params.push(args.type);
        }
        const sql = `
          SELECT type, category, timestamp, data
          FROM events
          WHERE ${clauses.join(" AND ")}
          ORDER BY timestamp DESC
          LIMIT ?
        `;
        const rows = deps.db.prepare(sql).all(...params, limit);
        return ok({
          count: (rows as unknown[]).length,
          windowHours: hours,
          events: rows,
        });
      } catch (e) {
        return toolErr("jarvis_recent_events", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 7. jarvis_reflector_gap_stats
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_reflector_gap_stats",
    {
      description:
        "Autoreason Phase 1 generation-evaluation gap telemetry — aggregate stats over a window. Returns n, avg_gap, max_gap, wide_gap_count (|diff|>0.25), llm_fallback_count. Backing table: reflector_gap_log. Used to drive the 2026-04-20 Phase 2 tournament decision.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("Lookback window in days (default 7, max 30)"),
      },
    },
    async (args) => {
      try {
        const days = args.days ?? 7;
        // v7.7.1 C2 fix: parameterize the window — same reasoning as
        // jarvis_recent_events. Zod constrains `days` but the interpolated
        // pattern is a latent trap.
        const row = deps.db
          .prepare(
            `SELECT
               COUNT(*)                                              AS n,
               ROUND(AVG(abs_diff), 4)                               AS avg_gap,
               ROUND(MAX(abs_diff), 4)                               AS max_gap,
               SUM(CASE WHEN abs_diff > 0.25 THEN 1 ELSE 0 END)      AS wide_gap_count,
               SUM(CASE WHEN llm_available = 0 THEN 1 ELSE 0 END)    AS llm_fallback_count
             FROM reflector_gap_log
             WHERE created_at >= datetime('now', ?)`,
          )
          .get(`-${days} days`) as {
          n: number;
          avg_gap: number | null;
          max_gap: number | null;
          wide_gap_count: number;
          llm_fallback_count: number;
        };

        // Decision-rule framing for the Phase 2 evaluation.
        const widePct =
          row.n > 0
            ? Math.round((row.wide_gap_count / row.n) * 10000) / 100
            : 0;

        return ok({
          windowDays: days,
          n: row.n,
          avgGap: row.avg_gap,
          maxGap: row.max_gap,
          wideGapCount: row.wide_gap_count,
          wideGapPct: widePct,
          llmFallbackCount: row.llm_fallback_count,
          decisionHint:
            row.n === 0
              ? "no data yet"
              : (row.avg_gap ?? 0) < 0.1 && widePct < 5
                ? "close thread — no tournament"
                : widePct > 25
                  ? "consider global tournament"
                  : widePct > 10
                    ? "targeted tournament pilot on specific task classes"
                    : "skip tournament",
        });
      } catch (e) {
        return toolErr("jarvis_reflector_gap_stats", e);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 8. jarvis_feedback_search
  // -------------------------------------------------------------------------
  server.registerTool(
    "jarvis_feedback_search",
    {
      description:
        "Grep over the memory directory `feedback_*.md` files (corrections, learnings, session dossiers). Case-insensitive substring match. Returns file name + match count + excerpt. Use to recall prior decisions, session history, architectural patterns.",
      inputSchema: {
        query: z
          .string()
          .describe("Substring to search for (case-insensitive)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max matches to return (default 10, max 50)"),
      },
    },
    async (args) => {
      try {
        const results = searchFeedback({
          query: args.query,
          limit: args.limit ?? 10,
        });
        return ok({ count: results.length, matches: results });
      } catch (e) {
        return toolErr("jarvis_feedback_search", e);
      }
    },
  );
}
