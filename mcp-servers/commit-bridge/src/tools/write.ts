import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSupabase, getUserId, unwrap } from "../supabase.js";

const HIERARCHY_TABLES = ["visions", "goals", "objectives", "tasks"] as const;

export function registerWriteTools(server: McpServer): void {
  // 7. update_status
  server.registerTool(
    "update_status",
    {
      description:
        "Update status of any hierarchy item (vision, goal, objective, or task)",
      inputSchema: {
        table: z.enum(HIERARCHY_TABLES).describe("Table name"),
        id: z.string().describe("Row UUID"),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .describe("New status"),
      },
    },
    async ({ table, id, status }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const updates: Record<string, unknown> = { status };

      // Set completed_at when marking a task as completed
      if (table === "tasks" && status === "completed") {
        updates.completed_at = new Date().toISOString();
      }
      // Clear completed_at if un-completing a task
      if (table === "tasks" && status !== "completed") {
        updates.completed_at = null;
      }

      const result = await supabase
        .from(table)
        .update(updates)
        .eq("id", id)
        .eq("user_id", uid)
        .select()
        .single();

      const row = unwrap(result, `update_status(${table})`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(row) }],
      };
    },
  );

  // 8. complete_recurring
  server.registerTool(
    "complete_recurring",
    {
      description:
        "Mark a recurring task as done for a specific date (inserts task_completion record)",
      inputSchema: {
        task_id: z.string().describe("Task UUID"),
        date: z
          .string()
          .optional()
          .describe("Completion date (YYYY-MM-DD), defaults to today"),
      },
    },
    async ({ task_id, date }) => {
      const supabase = getSupabase();
      const uid = getUserId();
      const completionDate = date ?? new Date().toISOString().split("T")[0];

      // Verify the task exists and belongs to user
      const taskResult = await supabase
        .from("tasks")
        .select("id, is_recurring, title")
        .eq("id", task_id)
        .eq("user_id", uid)
        .single();

      const task = unwrap(taskResult, "complete_recurring: task lookup") as {
        id: string;
        is_recurring: boolean;
        title: string;
      };

      // Insert completion record
      const insertResult = await supabase
        .from("task_completions")
        .insert({
          task_id,
          user_id: uid,
          completion_date: completionDate,
        })
        .select()
        .single();

      if (insertResult.error) {
        // Handle UNIQUE constraint violation (already completed today)
        const errMsg = JSON.stringify(insertResult.error);
        if (
          errMsg.includes("unique") ||
          errMsg.includes("duplicate") ||
          errMsg.includes("23505")
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Task "${task.title}" already completed for ${completionDate}`,
                }),
              },
            ],
            isError: true,
          };
        }
        throw new Error(`complete_recurring: ${errMsg}`);
      }

      // If task is NOT recurring, also mark it as completed
      if (!task.is_recurring) {
        await supabase
          .from("tasks")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", task_id)
          .eq("user_id", uid);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              completion: insertResult.data,
              task_title: task.title,
              is_recurring: task.is_recurring,
            }),
          },
        ],
      };
    },
  );

  // 9. create_journal_entry
  server.registerTool(
    "create_journal_entry",
    {
      description:
        "Create a journal entry (for daily reflections or nightly close)",
      inputSchema: {
        content: z
          .string()
          .describe("Journal entry content (markdown supported)"),
        date: z
          .string()
          .optional()
          .describe("Entry date (YYYY-MM-DD), defaults to today"),
        primary_emotion: z
          .string()
          .optional()
          .describe("Primary emotion for the entry"),
      },
    },
    async ({ content, date, primary_emotion }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("journal_entries")
        .insert({
          user_id: uid,
          content,
          entry_date: date ?? new Date().toISOString().split("T")[0],
          primary_emotion: primary_emotion ?? null,
        })
        .select()
        .single();

      const entry = unwrap(result, "create_journal_entry");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entry) }],
      };
    },
  );

  // 10. create_task
  server.registerTool(
    "create_task",
    {
      description: "Create a new task, optionally linked to an objective",
      inputSchema: {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        objective_id: z.string().optional().describe("Parent objective UUID"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Priority (default: medium)"),
        due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
        is_recurring: z
          .boolean()
          .optional()
          .describe("Whether the task repeats daily (default: false)"),
      },
    },
    async ({
      title,
      description,
      objective_id,
      priority,
      due_date,
      is_recurring,
    }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("tasks")
        .insert({
          user_id: uid,
          title,
          description: description ?? "",
          objective_id: objective_id ?? null,
          priority: priority ?? "medium",
          due_date: due_date ?? null,
          is_recurring: is_recurring ?? false,
          status: "not_started",
        })
        .select()
        .single();

      const task = unwrap(result, "create_task");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
      };
    },
  );

  // 11. bulk_reprioritize
  server.registerTool(
    "bulk_reprioritize",
    {
      description:
        "Update priorities for multiple tasks at once (used to rebalance after daily review)",
      inputSchema: {
        updates: z
          .array(
            z.object({
              id: z.string().describe("Task UUID"),
              priority: z
                .enum(["high", "medium", "low"])
                .describe("New priority"),
            }),
          )
          .describe("Array of {id, priority} pairs"),
      },
    },
    async ({ updates }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let succeeded = 0;
      const errors: string[] = [];

      for (const { id, priority } of updates) {
        const result = await supabase
          .from("tasks")
          .update({ priority })
          .eq("id", id)
          .eq("user_id", uid);

        if (result.error) {
          errors.push(`${id}: ${JSON.stringify(result.error)}`);
        } else {
          succeeded++;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              updated: succeeded,
              total: updates.length,
              errors: errors.length > 0 ? errors : undefined,
            }),
          },
        ],
      };
    },
  );
}
