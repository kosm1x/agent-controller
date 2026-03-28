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

      const updates: Record<string, unknown> = {
        status,
        modified_by: "jarvis",
      };

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
            modified_by: "jarvis",
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
          modified_by: "jarvis",
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
      description: `Create a new task linked to an objective in the COMMIT hierarchy.

WORKFLOW when user mentions an objective by name:
1. Call list_objectives to find the objective — match by title
2. Extract the objective's "id" field (UUID)
3. Pass that UUID as objective_id here

ALWAYS link tasks to their parent objective when the user specifies one.
If the user doesn't mention an objective, ask which objective this task belongs to.
Only create unlinked tasks if the user explicitly says it's standalone.`,
      inputSchema: {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        objective_id: z
          .string()
          .optional()
          .describe(
            "Parent objective UUID — get this by calling list_objectives first and matching by title",
          ),
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
          modified_by: "jarvis",
        })
        .select()
        .single();

      const task = unwrap(result, "create_task");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
      };
    },
  );

  // 11. create_goal
  server.registerTool(
    "create_goal",
    {
      description: `Create a new goal linked to a vision in the COMMIT hierarchy.

WORKFLOW when user mentions a vision by name:
1. Call get_hierarchy to see all visions
2. Find the matching vision by title, extract its "id" (UUID)
3. Pass that UUID as vision_id here

ALWAYS link goals to their parent vision when the user specifies one.`,
      inputSchema: {
        title: z.string().describe("Goal title"),
        description: z.string().optional().describe("Goal description"),
        vision_id: z
          .string()
          .optional()
          .describe(
            "Parent vision UUID — get this from get_hierarchy and match by title",
          ),
        target_date: z.string().optional().describe("Target date (YYYY-MM-DD)"),
      },
    },
    async ({ title, description, vision_id, target_date }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("goals")
        .insert({
          user_id: uid,
          title,
          description: description ?? "",
          vision_id: vision_id ?? null,
          target_date: target_date ?? null,
          status: "not_started",
          modified_by: "jarvis",
        })
        .select()
        .single();

      const goal = unwrap(result, "create_goal");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(goal) }],
      };
    },
  );

  // 12. create_objective
  server.registerTool(
    "create_objective",
    {
      description: `Create a new objective linked to a goal in the COMMIT hierarchy.

WORKFLOW when user mentions a goal by name:
1. Call list_goals to find the goal — match by title
2. Extract the goal's "id" field (UUID)
3. Pass that UUID as goal_id here

ALWAYS link objectives to their parent goal when the user specifies one.`,
      inputSchema: {
        title: z.string().describe("Objective title"),
        description: z.string().optional().describe("Objective description"),
        goal_id: z
          .string()
          .optional()
          .describe(
            "Parent goal UUID — get this by calling list_goals first and matching by title",
          ),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Priority (default: medium)"),
        target_date: z.string().optional().describe("Target date (YYYY-MM-DD)"),
      },
    },
    async ({ title, description, goal_id, priority, target_date }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("objectives")
        .insert({
          user_id: uid,
          title,
          description: description ?? "",
          goal_id: goal_id ?? null,
          priority: priority ?? "medium",
          target_date: target_date ?? null,
          status: "not_started",
          modified_by: "jarvis",
        })
        .select()
        .single();

      const objective = unwrap(result, "create_objective");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(objective) }],
      };
    },
  );

  // 13. update_task
  server.registerTool(
    "update_task",
    {
      description: "Update any field on a task (partial update)",
      inputSchema: {
        id: z.string().describe("Task UUID"),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(["high", "medium", "low"]).optional(),
        due_date: z
          .string()
          .optional()
          .describe("Due date (YYYY-MM-DD), use empty string to clear"),
        is_recurring: z.boolean().optional(),
        objective_id: z
          .string()
          .optional()
          .describe("Parent objective UUID, use empty string to unlink"),
        notes: z.string().optional(),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional(),
      },
    },
    async (args) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const updates: Record<string, unknown> = { modified_by: "jarvis" };

      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.is_recurring !== undefined)
        updates.is_recurring = args.is_recurring;
      if (args.notes !== undefined) updates.notes = args.notes;

      // Empty string → null for nullable foreign keys / dates
      if (args.due_date !== undefined)
        updates.due_date = args.due_date === "" ? null : args.due_date;
      if (args.objective_id !== undefined)
        updates.objective_id =
          args.objective_id === "" ? null : args.objective_id;

      // Handle completed_at based on status changes
      if (args.status !== undefined) {
        updates.status = args.status;
        if (args.status === "completed") {
          updates.completed_at = new Date().toISOString();
        } else {
          updates.completed_at = null;
        }
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No fields to update" }),
            },
          ],
          isError: true,
        };
      }

      const result = await supabase
        .from("tasks")
        .update(updates)
        .eq("id", args.id)
        .eq("user_id", uid)
        .select()
        .single();

      const task = unwrap(result, "update_task");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task) }],
      };
    },
  );

  // 14. update_objective
  server.registerTool(
    "update_objective",
    {
      description:
        "Update any field on an objective (partial update). An objective is a milestone under a goal.",
      inputSchema: {
        id: z.string().describe("Objective UUID"),
        title: z.string().optional(),
        description: z.string().optional(),
        priority: z.enum(["high", "medium", "low"]).optional(),
        target_date: z
          .string()
          .optional()
          .describe("Target date (YYYY-MM-DD), use empty string to clear"),
        goal_id: z
          .string()
          .optional()
          .describe("Parent goal UUID, use empty string to unlink"),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional(),
      },
    },
    async (args) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const updates: Record<string, unknown> = { modified_by: "jarvis" };

      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.priority !== undefined) updates.priority = args.priority;
      if (args.status !== undefined) updates.status = args.status;
      if (args.target_date !== undefined)
        updates.target_date = args.target_date === "" ? null : args.target_date;
      if (args.goal_id !== undefined)
        updates.goal_id = args.goal_id === "" ? null : args.goal_id;

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No fields to update" }),
            },
          ],
          isError: true,
        };
      }

      const result = await supabase
        .from("objectives")
        .update(updates)
        .eq("id", args.id)
        .eq("user_id", uid)
        .select()
        .single();

      const objective = unwrap(result, "update_objective");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(objective) }],
      };
    },
  );

  // 15. update_goal
  server.registerTool(
    "update_goal",
    {
      description:
        "Update any field on a goal (partial update). A goal is a measurable outcome under a vision.",
      inputSchema: {
        id: z.string().describe("Goal UUID"),
        title: z.string().optional(),
        description: z.string().optional(),
        target_date: z
          .string()
          .optional()
          .describe("Target date (YYYY-MM-DD), use empty string to clear"),
        vision_id: z
          .string()
          .optional()
          .describe("Parent vision UUID, use empty string to unlink"),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional(),
      },
    },
    async (args) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const updates: Record<string, unknown> = { modified_by: "jarvis" };

      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.target_date !== undefined)
        updates.target_date = args.target_date === "" ? null : args.target_date;
      if (args.vision_id !== undefined)
        updates.vision_id = args.vision_id === "" ? null : args.vision_id;

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No fields to update" }),
            },
          ],
          isError: true,
        };
      }

      const result = await supabase
        .from("goals")
        .update(updates)
        .eq("id", args.id)
        .eq("user_id", uid)
        .select()
        .single();

      const goal = unwrap(result, "update_goal");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(goal) }],
      };
    },
  );

  // 16. update_vision
  server.registerTool(
    "update_vision",
    {
      description:
        "Update any field on a vision (partial update). A vision is a long-term life direction — the top of the COMMIT hierarchy.",
      inputSchema: {
        id: z.string().describe("Vision UUID"),
        title: z.string().optional(),
        description: z.string().optional(),
        target_date: z
          .string()
          .optional()
          .describe("Target date (YYYY-MM-DD), use empty string to clear"),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional(),
      },
    },
    async (args) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const updates: Record<string, unknown> = { modified_by: "jarvis" };

      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined)
        updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.target_date !== undefined)
        updates.target_date = args.target_date === "" ? null : args.target_date;

      if (Object.keys(updates).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "No fields to update" }),
            },
          ],
          isError: true,
        };
      }

      const result = await supabase
        .from("visions")
        .update(updates)
        .eq("id", args.id)
        .eq("user_id", uid)
        .select()
        .single();

      const vision = unwrap(result, "update_vision");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(vision) }],
      };
    },
  );

  // 17. create_vision
  server.registerTool(
    "create_vision",
    {
      description:
        "Create a new vision — a long-term life direction at the top of the COMMIT hierarchy",
      inputSchema: {
        title: z.string().describe("Vision title"),
        description: z.string().optional().describe("Vision description"),
        target_date: z.string().optional().describe("Target date (YYYY-MM-DD)"),
      },
    },
    async ({ title, description, target_date }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("visions")
        .insert({
          user_id: uid,
          title,
          description: description ?? "",
          target_date: target_date ?? null,
          status: "not_started",
          modified_by: "jarvis",
        })
        .select()
        .single();

      const vision = unwrap(result, "create_vision");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(vision) }],
      };
    },
  );

  // 18. bulk_reprioritize
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
          .update({ priority, modified_by: "jarvis" })
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

  // 19. delete_item
  server.registerTool(
    "delete_item",
    {
      description: `Permanently delete a vision, goal, objective, or task.

DOUBLE-VERIFICATION REQUIRED: You must pass confirm_title matching the item's exact title. This prevents accidental deletions.

Workflow:
1. Look up the item first (list_tasks, list_goals, list_objectives, or get_hierarchy) to get its id and exact title.
2. Ask the user to confirm they want to delete it — state the title and level clearly.
3. Only after user confirms, call this tool with both id and confirm_title.

NEVER call this tool without explicit user confirmation. Cascade behavior: deleting a goal does NOT delete its child objectives/tasks — they become unlinked.`,
      inputSchema: {
        table: z
          .enum(HIERARCHY_TABLES)
          .describe("Which level: visions, goals, objectives, or tasks"),
        id: z.string().describe("Item UUID to delete"),
        confirm_title: z
          .string()
          .describe(
            "Must match the item's exact title — prevents accidental deletion",
          ),
      },
    },
    async ({ table, id, confirm_title }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      // Phase 1: Fetch the item and verify title matches
      const lookupResult = await supabase
        .from(table)
        .select("id, title, status")
        .eq("id", id)
        .eq("user_id", uid)
        .single();

      const item = unwrap(lookupResult, `delete_item(${table}): lookup`) as {
        id: string;
        title: string;
        status: string;
      };

      if (item.title !== confirm_title) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "Title mismatch — confirm_title must match the item's exact title",
                expected: item.title,
                received: confirm_title,
              }),
            },
          ],
          isError: true,
        };
      }

      // Phase 2: Delete
      const deleteResult = await supabase
        .from(table)
        .delete()
        .eq("id", id)
        .eq("user_id", uid);

      if (deleteResult.error) {
        throw new Error(
          `delete_item(${table}): ${JSON.stringify(deleteResult.error)}`,
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              deleted: true,
              table,
              id,
              title: item.title,
            }),
          },
        ],
      };
    },
  );

  // 20. create_suggestion
  server.registerTool(
    "create_suggestion",
    {
      description: `Propose a change to COMMIT that the user can accept or reject.

USE WHEN:
- You want to suggest creating a task, goal, or objective but want user approval first
- Proactive scans detect an improvement (stale goal, missing task, alignment gap)
- Journal analysis reveals an actionable insight
- A conversation implies a task the user might want to track

DO NOT USE WHEN:
- The user explicitly asks you to create/update something (use the direct tools instead)
- Urgent changes that shouldn't wait for approval

The suggestion appears in the COMMIT UI as an actionable card. The user can accept (executes the change) or reject (Jarvis learns from the rejection).`,
      inputSchema: {
        type: z
          .enum([
            "create_task",
            "create_goal",
            "create_objective",
            "create_idea",
            "update_status",
            "complete_objective",
            "complete_goal",
            "focus_next_objective",
            "link_task",
            "reorder",
            "archive",
            "archive_project",
          ])
          .describe("Type of change being suggested"),
        target_table: z
          .enum(["visions", "goals", "objectives", "tasks"])
          .optional()
          .describe("Target table (for updates, not needed for creates)"),
        target_id: z
          .string()
          .optional()
          .describe("Target item UUID (for updates)"),
        title: z
          .string()
          .describe(
            'Human-readable summary of the suggestion (e.g. "Crear tarea: Revisar métricas GA4")',
          ),
        suggestion: z
          .record(z.unknown())
          .describe(
            "Full payload — the data that would be passed to the create/update tool if accepted",
          ),
        reasoning: z
          .string()
          .describe("Why Jarvis is suggesting this — helps the user decide"),
        source: z
          .enum([
            "proactive_scan",
            "journal_analysis",
            "conversation",
            "weekly_review",
            "event_reactor",
          ])
          .describe("What triggered this suggestion"),
      },
    },
    async ({
      type,
      target_table,
      target_id,
      title,
      suggestion,
      reasoning,
      source,
    }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("agent_suggestions")
        .insert({
          user_id: uid,
          type,
          target_table: target_table ?? null,
          target_id: target_id ?? null,
          title,
          suggestion,
          reasoning,
          source,
          status: "pending",
        })
        .select()
        .single();

      const row = unwrap(result, "create_suggestion");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(row) }],
      };
    },
  );

  // 21. upsert_ai_analysis
  server.registerTool(
    "upsert_ai_analysis",
    {
      description:
        "Write or update AI analysis for a journal entry. Used by the deep journal analysis pipeline.",
      inputSchema: {
        journal_entry_id: z.string().describe("Journal entry UUID"),
        emotions: z
          .array(
            z.object({
              name: z.string(),
              intensity: z.number(),
              color: z.string().optional(),
            }),
          )
          .describe("Detected emotions with intensity (0-100)"),
        patterns: z.array(z.string()).describe("Behavioral patterns observed"),
        coping_strategies: z
          .array(z.string())
          .describe("Suggested coping strategies"),
        primary_emotion: z.string().describe("The dominant emotion"),
      },
    },
    async ({
      journal_entry_id,
      emotions,
      patterns,
      coping_strategies,
      primary_emotion,
    }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      const result = await supabase
        .from("ai_analysis")
        .upsert(
          {
            entry_id: journal_entry_id,
            user_id: uid,
            emotions,
            patterns,
            coping_strategies,
            primary_emotion,
          },
          { onConflict: "entry_id" },
        )
        .select()
        .single();

      if (result.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: result.error.message }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );
}
