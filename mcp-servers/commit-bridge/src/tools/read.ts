import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSupabase, getUserId, unwrap } from "../supabase.js";
import type {
  DailySnapshot,
  GoalNode,
  GoalRow,
  ObjectiveNode,
  ObjectiveRow,
  TaskRow,
  VisionRow,
} from "../types.js";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

const USER_TIMEZONE = "America/Mexico_City";

/** Get today's date in Mexico City timezone (YYYY-MM-DD). */
function todayMx(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
}

function sortByPriority<T extends { priority: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3),
  );
}

function toISODate(date?: string): string {
  return date ?? todayMx();
}

function calculateStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const unique = [...new Set(dates)].sort().reverse();
  const today = todayMx();
  let streak = 0;
  const cursor = new Date(today + "T12:00:00"); // noon to avoid DST edge cases

  for (const d of unique) {
    const expected = cursor.toLocaleDateString("en-CA", {
      timeZone: USER_TIMEZONE,
    });
    if (d === expected) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (d < expected) {
      break;
    }
  }
  return streak;
}

export function registerReadTools(server: McpServer): void {
  // 1. get_daily_snapshot
  server.registerTool(
    "get_daily_snapshot",
    {
      description:
        "Get daily snapshot: pending tasks, recurring status, deadlines, streaks. COMMIT hierarchy: Vision (life direction) > Goal (measurable outcome) > Objective (milestone) > Task (action item). Returns the active vision for context, counts of goals/objectives, and detailed pending tasks. When the user asks about 'goals', report data from the goals count — do NOT present the vision as a goal. CRITICAL: Report EXACTLY what the database returns — exact titles, statuses, dates. Never summarize or paraphrase DB data.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe("ISO date (YYYY-MM-DD), defaults to today"),
      },
    },
    async ({ date }) => {
      const supabase = getSupabase();
      const uid = getUserId();
      const today = toISODate(date);

      const [
        visionsRes,
        goalsRes,
        objectivesRes,
        tasksRes,
        completionsRes,
        streakRes,
        journalRes,
      ] = await Promise.all([
        // Active vision (first non-completed)
        supabase
          .from("visions")
          .select("*")
          .eq("user_id", uid)
          .neq("status", "completed")
          .order("order", { ascending: true })
          .limit(1),
        // Active goals count
        supabase
          .from("goals")
          .select("id", { count: "exact", head: true })
          .eq("user_id", uid)
          .eq("status", "in_progress"),
        // Active objectives count
        supabase
          .from("objectives")
          .select("id", { count: "exact", head: true })
          .eq("user_id", uid)
          .eq("status", "in_progress"),
        // Pending tasks (not completed)
        supabase
          .from("tasks")
          .select("*")
          .eq("user_id", uid)
          .neq("status", "completed")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(50),
        // Today's completions
        supabase
          .from("task_completions")
          .select("*, tasks(title, is_recurring)")
          .eq("user_id", uid)
          .eq("completion_date", today),
        // Streak data (last 30 completion dates)
        supabase
          .from("task_completions")
          .select("completion_date")
          .eq("user_id", uid)
          .order("completion_date", { ascending: false })
          .limit(30),
        // Most recent journal entry
        supabase
          .from("journal_entries")
          .select("*")
          .eq("user_id", uid)
          .order("entry_date", { ascending: false })
          .limit(1),
      ]);

      const vision = (visionsRes.data?.[0] as VisionRow | undefined) ?? null;
      const pendingTasks = (tasksRes.data ?? []) as TaskRow[];
      const completions = completionsRes.data ?? [];
      const completedTaskIds = new Set(
        completions.map((c: { task_id: string }) => c.task_id),
      );

      // Split pending tasks into categories
      const overdue: TaskRow[] = [];
      const dueToday: TaskRow[] = [];
      const inProgress: TaskRow[] = [];
      const upcoming: TaskRow[] = [];
      const recurringPending: TaskRow[] = [];
      const recurringCompleted: TaskRow[] = [];

      const sevenDaysLater = new Date(today);
      sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
      const upcomingCutoff = sevenDaysLater.toISOString().split("T")[0];

      for (const task of pendingTasks) {
        // Handle recurring tasks separately
        if (task.is_recurring) {
          if (completedTaskIds.has(task.id)) {
            recurringCompleted.push(task);
          } else {
            recurringPending.push(task);
          }
          continue;
        }

        if (task.due_date && task.due_date < today) {
          overdue.push(task);
        } else if (task.due_date === today) {
          dueToday.push(task);
        } else if (task.status === "in_progress") {
          inProgress.push(task);
        }

        if (
          task.due_date &&
          task.due_date > today &&
          task.due_date <= upcomingCutoff
        ) {
          upcoming.push(task);
        }
      }

      const streakDates = (streakRes.data ?? []).map(
        (r: { completion_date: string }) => r.completion_date,
      );

      const snapshot: DailySnapshot = {
        date: today,
        vision,
        summary: {
          active_goals: goalsRes.count ?? 0,
          active_objectives: objectivesRes.count ?? 0,
          pending_tasks: pendingTasks.length,
          completed_today: completions.length,
          streak_days: calculateStreak(streakDates),
        },
        overdue_tasks: sortByPriority(overdue),
        due_today: sortByPriority(dueToday),
        in_progress: sortByPriority(inProgress),
        recurring: {
          pending: recurringPending,
          completed: recurringCompleted,
        },
        upcoming_deadlines: upcoming,
        recent_journal:
          (journalRes.data?.[0] as typeof snapshot.recent_journal) ?? null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
      };
    },
  );

  // 2. get_hierarchy
  server.registerTool(
    "get_hierarchy",
    {
      description: `Get the full COMMIT hierarchy tree as pre-formatted text. Returns human-readable output — relay it directly to the user without rephrasing. The output IS the answer.

USE WHEN: user asks about visions, full overview, weekly review, or "what do I have in COMMIT."
For goal-specific queries, prefer list_goals (lighter).`,
      inputSchema: {
        include_completed: z
          .boolean()
          .optional()
          .describe("Include completed items (default: false)"),
      },
    },
    async ({ include_completed }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let visionsQ = supabase.from("visions").select("*").eq("user_id", uid);
      let goalsQ = supabase.from("goals").select("*").eq("user_id", uid);
      let objectivesQ = supabase
        .from("objectives")
        .select("*")
        .eq("user_id", uid);
      let tasksQ = supabase.from("tasks").select("*").eq("user_id", uid);

      if (!include_completed) {
        visionsQ = visionsQ.neq("status", "completed");
        goalsQ = goalsQ.neq("status", "completed");
        objectivesQ = objectivesQ.neq("status", "completed");
        tasksQ = tasksQ.neq("status", "completed");
      }

      const [visionsRes, goalsRes, objectivesRes, tasksRes] = await Promise.all(
        [
          visionsQ.order("order", { ascending: true }),
          goalsQ.order("order", { ascending: true }),
          objectivesQ.order("order", { ascending: true }),
          tasksQ.order("order", { ascending: true }),
        ],
      );

      const visions = (visionsRes.data ?? []) as VisionRow[];
      const goals = (goalsRes.data ?? []) as GoalRow[];
      const objectives = (objectivesRes.data ?? []) as ObjectiveRow[];
      const tasks = (tasksRes.data ?? []) as TaskRow[];

      // Build tree: tasks → objectives → goals → visions
      const tasksByObjective = new Map<string | null, TaskRow[]>();
      for (const t of tasks) {
        const key = t.objective_id;
        if (!tasksByObjective.has(key)) tasksByObjective.set(key, []);
        tasksByObjective.get(key)!.push(t);
      }

      const objectiveNodes: ObjectiveNode[] = objectives.map((o) => ({
        ...o,
        children: tasksByObjective.get(o.id) ?? [],
      }));

      const objByGoal = new Map<string | null, ObjectiveNode[]>();
      for (const o of objectiveNodes) {
        const key = o.goal_id;
        if (!objByGoal.has(key)) objByGoal.set(key, []);
        objByGoal.get(key)!.push(o);
      }

      const goalNodes: GoalNode[] = goals.map((g) => ({
        ...g,
        children: objByGoal.get(g.id) ?? [],
      }));

      const goalsByVision = new Map<string | null, GoalNode[]>();
      for (const g of goalNodes) {
        const key = g.vision_id;
        if (!goalsByVision.has(key)) goalsByVision.set(key, []);
        goalsByVision.get(key)!.push(g);
      }

      // --- Pre-format as human-readable text ---
      // The LLM must relay this directly, not interpret JSON.
      const lines: string[] = [];
      lines.push(
        `COMMIT HIERARCHY (${visions.length} visions, ${goals.length} goals, ${objectives.length} objectives, ${tasks.length} tasks)`,
      );
      lines.push("=".repeat(70));

      for (const v of visions) {
        const vGoals = goalsByVision.get(v.id) ?? [];
        lines.push("");
        lines.push(`VISION: ${v.title}`);
        lines.push(
          `  Status: ${v.status} | Target: ${v.target_date ?? "none"} | Description: ${v.description}`,
        );

        if (vGoals.length === 0) {
          lines.push("  (no goals)");
        }
        for (const g of vGoals) {
          const gObjs = objByGoal.get(g.id) ?? [];
          lines.push(`  GOAL: ${g.title}`);
          lines.push(
            `    Status: ${g.status} | Target: ${g.target_date ?? "none"} | Description: ${g.description || "(none)"}`,
          );

          if (gObjs.length === 0) {
            lines.push("    (no objectives)");
          }
          for (const o of gObjs) {
            const oTasks = tasksByObjective.get(o.id) ?? [];
            lines.push(`    OBJECTIVE: ${o.title}`);
            lines.push(
              `      Status: ${o.status} | Priority: ${o.priority} | Target: ${o.target_date ?? "none"}`,
            );

            for (const t of oTasks) {
              const recurring = t.is_recurring ? " [recurring]" : "";
              lines.push(`      TASK: ${t.title}${recurring}`);
              lines.push(
                `        Status: ${t.status} | Priority: ${t.priority} | Due: ${t.due_date ?? "none"}`,
              );
            }
          }
        }
      }

      // Orphaned items
      const orphanGoals = goalsByVision.get(null) ?? [];
      const orphanObjs = objByGoal.get(null) ?? [];
      const orphanTasks = tasksByObjective.get(null) ?? [];

      if (
        orphanGoals.length > 0 ||
        orphanObjs.length > 0 ||
        orphanTasks.length > 0
      ) {
        lines.push("");
        lines.push("UNLINKED ITEMS (not part of any vision)");
        lines.push("-".repeat(40));
        for (const g of orphanGoals) {
          lines.push(`  GOAL (no vision): ${g.title} | Status: ${g.status}`);
        }
        for (const o of orphanObjs) {
          lines.push(
            `  OBJECTIVE (no goal): ${o.title} | Status: ${o.status} | Priority: ${o.priority}`,
          );
        }
        for (const t of orphanTasks) {
          lines.push(
            `  TASK (no objective): ${t.title} | Status: ${t.status} | Due: ${t.due_date ?? "none"}`,
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // 3. list_tasks
  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks as pre-formatted text. Relay the output directly — it IS the answer. Use objective_id to filter by parent objective.",
      inputSchema: {
        objective_id: z
          .string()
          .optional()
          .describe(
            "Filter by parent objective UUID — use list_objectives first to find the UUID",
          ),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional()
          .describe("Filter by status"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Filter by priority"),
        is_recurring: z
          .boolean()
          .optional()
          .describe("Filter recurring (true) or non-recurring (false) tasks"),
        due_before: z
          .string()
          .optional()
          .describe("Due date upper bound (YYYY-MM-DD, inclusive)"),
        due_after: z
          .string()
          .optional()
          .describe("Due date lower bound (YYYY-MM-DD, inclusive)"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
    },
    async ({
      objective_id,
      status,
      priority,
      is_recurring,
      due_before,
      due_after,
      limit,
    }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let q = supabase
        .from("tasks")
        .select("*, objectives(title)")
        .eq("user_id", uid);
      if (objective_id) q = q.eq("objective_id", objective_id);
      if (status) q = q.eq("status", status);
      if (priority) q = q.eq("priority", priority);
      if (is_recurring !== undefined) q = q.eq("is_recurring", is_recurring);
      if (due_before) q = q.lte("due_date", due_before);
      if (due_after) q = q.gte("due_date", due_after);
      q = q
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(limit ?? 50);

      const result = await q;
      const tasks = unwrap(result, "list_tasks") as Array<
        TaskRow & { objectives?: { title: string } | null }
      >;
      const lines: string[] = [];
      lines.push(`TASKS (${tasks.length} results)`);
      lines.push("-".repeat(50));
      for (const t of tasks) {
        const obj = t.objectives?.title ?? "(no objective)";
        const recurring = t.is_recurring ? " [recurring]" : "";
        lines.push(`TASK: ${t.title}${recurring}`);
        lines.push(`  ID: ${t.id}`);
        lines.push(
          `  Status: ${t.status} | Priority: ${t.priority} | Objective: ${obj} | Due: ${t.due_date ?? "none"}`,
        );
        if (t.description) lines.push(`  Description: ${t.description}`);
        if (t.notes) lines.push(`  Notes: ${t.notes}`);
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // 4. list_goals
  server.registerTool(
    "list_goals",
    {
      description: `List GOALS as pre-formatted text. Relay the output directly — it IS the answer.
ALSO USE FOR LOOKUPS: call this first to find a goal's UUID, then pass it to create_objective.`,
      inputSchema: {
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional()
          .describe("Filter by status"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
    },
    async ({ status, limit }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let q = supabase
        .from("goals")
        .select("*, visions(title)")
        .eq("user_id", uid);
      if (status) q = q.eq("status", status);
      q = q.order("order", { ascending: true }).limit(limit ?? 50);

      const result = await q;
      const goals = unwrap(result, "list_goals") as Array<
        GoalRow & { visions?: { title: string } | null }
      >;
      const lines: string[] = [];
      lines.push(`GOALS (${goals.length} results)`);
      lines.push("-".repeat(50));
      for (const g of goals) {
        const vision = g.visions?.title ?? "(no vision)";
        lines.push(`GOAL: ${g.title}`);
        lines.push(`  ID: ${g.id}`);
        lines.push(
          `  Status: ${g.status} | Vision: ${vision} | Target: ${g.target_date ?? "none"}`,
        );
        if (g.description) lines.push(`  Description: ${g.description}`);
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // 5. list_objectives
  server.registerTool(
    "list_objectives",
    {
      description: `List objectives as pre-formatted text. Relay the output directly — it IS the answer.
ALSO USE FOR LOOKUPS: call this first to find an objective's UUID, then pass it to create_task.`,
      inputSchema: {
        goal_id: z.string().optional().describe("Filter by parent goal UUID"),
        status: z
          .enum(["not_started", "in_progress", "completed", "on_hold"])
          .optional()
          .describe("Filter by status"),
        priority: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Filter by priority"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
    },
    async ({ goal_id, status, priority, limit }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let q = supabase
        .from("objectives")
        .select("*, goals(title)")
        .eq("user_id", uid);
      if (goal_id) q = q.eq("goal_id", goal_id);
      if (status) q = q.eq("status", status);
      if (priority) q = q.eq("priority", priority);
      q = q.order("order", { ascending: true }).limit(limit ?? 50);

      const result = await q;
      const objectives = unwrap(result, "list_objectives") as Array<
        ObjectiveRow & { goals?: { title: string } | null }
      >;
      const lines: string[] = [];
      lines.push(`OBJECTIVES (${objectives.length} results)`);
      lines.push("-".repeat(50));
      for (const o of objectives) {
        const goal = o.goals?.title ?? "(no goal)";
        lines.push(`OBJECTIVE: ${o.title}`);
        lines.push(`  ID: ${o.id}`);
        lines.push(
          `  Status: ${o.status} | Priority: ${o.priority} | Goal: ${goal} | Target: ${o.target_date ?? "none"}`,
        );
        if (o.description) lines.push(`  Description: ${o.description}`);
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // 6. search_journal
  server.registerTool(
    "search_journal",
    {
      description: "Search journal entries by date range or keyword",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search in content"),
        date_from: z
          .string()
          .optional()
          .describe("Start date (YYYY-MM-DD, inclusive)"),
        date_to: z
          .string()
          .optional()
          .describe("End date (YYYY-MM-DD, inclusive)"),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, date_from, date_to, limit }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let q = supabase.from("journal_entries").select("*").eq("user_id", uid);
      if (query) q = q.ilike("content", `%${query}%`);
      if (date_from) q = q.gte("entry_date", date_from);
      if (date_to) q = q.lte("entry_date", date_to);
      q = q.order("entry_date", { ascending: false }).limit(limit ?? 20);

      const result = await q;
      const entries = unwrap(result, "search_journal");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(entries) }],
      };
    },
  );

  // 6. list_ideas
  server.registerTool(
    "list_ideas",
    {
      description: `List ideas from the COMMIT ideas library, filtered by status or category.

USE WHEN:
- User asks about their ideas ("qué ideas tengo", "mis ideas")
- Conversation surfaces an idea — check if it already exists before suggesting to add it
- Idea capture from conversations: verify no duplicate before creating a suggestion
- Weekly review: check for stale draft ideas that need action`,
      inputSchema: {
        status: z
          .enum(["draft", "active", "completed", "archived"])
          .optional()
          .describe("Filter by status"),
        category: z.string().optional().describe("Filter by category"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
    },
    async ({ status, category, limit }) => {
      const supabase = getSupabase();
      const uid = getUserId();

      let q = supabase.from("ideas").select("*").eq("user_id", uid);
      if (status) q = q.eq("status", status);
      if (category) q = q.eq("category", category);
      q = q.order("created_at", { ascending: false }).limit(limit ?? 50);

      const result = await q;
      const ideas = unwrap(result, "list_ideas");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ideas) }],
      };
    },
  );
}
