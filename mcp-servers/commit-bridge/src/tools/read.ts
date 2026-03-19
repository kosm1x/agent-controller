import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSupabase, getUserId, unwrap } from "../supabase.js";
import type {
  DailySnapshot,
  GoalNode,
  GoalRow,
  HierarchyNode,
  ObjectiveNode,
  ObjectiveRow,
  TaskRow,
  VisionRow,
} from "../types.js";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortByPriority<T extends { priority: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3),
  );
}

function toISODate(date?: string): string {
  return date ?? new Date().toISOString().split("T")[0];
}

function calculateStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const unique = [...new Set(dates)].sort().reverse();
  const today = new Date().toISOString().split("T")[0];
  let streak = 0;
  const cursor = new Date(today);

  for (const d of unique) {
    const expected = cursor.toISOString().split("T")[0];
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
        "Get daily snapshot: pending tasks, recurring status, deadlines, streaks. COMMIT hierarchy: Vision (life direction) > Goal (measurable outcome) > Objective (milestone) > Task (action item). Returns the active vision for context, counts of goals/objectives, and detailed pending tasks. When the user asks about 'goals', report data from the goals count — do NOT present the vision as a goal.",
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
      description:
        "Get the full COMMIT hierarchy tree. Visions (long-term life directions) are the root. Goals (measurable outcomes) belong to a vision. Objectives (milestones) belong to a goal. Tasks (action items) belong to an objective. Returns nested JSON: vision → goals[] → objectives[] → tasks[]. When user asks for 'goals', extract only the goal-level items — do NOT present visions as goals.",
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

      const tree: HierarchyNode[] = visions.map((v) => ({
        ...v,
        children: goalsByVision.get(v.id) ?? [],
      }));

      // Add orphaned goals (no vision) as a virtual root
      const orphanGoals = goalsByVision.get(null);
      if (orphanGoals && orphanGoals.length > 0) {
        tree.push({
          id: "_unlinked",
          user_id: uid,
          title: "Unlinked Goals",
          description: "Goals not linked to any vision",
          status: "in_progress",
          target_date: null,
          order: 999,
          created_at: "",
          updated_at: "",
          last_edited_at: "",
          children: orphanGoals,
        });
      }

      // Add orphaned objectives (no goal)
      const orphanObjectives = objByGoal.get(null);
      if (orphanObjectives && orphanObjectives.length > 0) {
        tree.push({
          id: "_unlinked_objectives",
          user_id: uid,
          title: "Unlinked Objectives",
          description: "Objectives not linked to any goal",
          status: "in_progress",
          target_date: null,
          order: 1000,
          created_at: "",
          updated_at: "",
          last_edited_at: "",
          children: [
            {
              id: "_virtual_goal",
              user_id: uid,
              title: "",
              description: "",
              status: "in_progress",
              target_date: null,
              vision_id: null,
              order: 0,
              created_at: "",
              updated_at: "",
              last_edited_at: "",
              children: orphanObjectives,
            },
          ],
        });
      }

      // Add orphaned tasks (no objective)
      const orphanTasks = tasksByObjective.get(null);
      if (orphanTasks && orphanTasks.length > 0) {
        tree.push({
          id: "_unlinked_tasks",
          user_id: uid,
          title: "Unlinked Tasks",
          description: "Tasks not linked to any objective",
          status: "in_progress",
          target_date: null,
          order: 1001,
          created_at: "",
          updated_at: "",
          last_edited_at: "",
          children: [
            {
              id: "_virtual_goal_tasks",
              user_id: uid,
              title: "",
              description: "",
              status: "in_progress",
              target_date: null,
              vision_id: null,
              order: 0,
              created_at: "",
              updated_at: "",
              last_edited_at: "",
              children: [
                {
                  id: "_virtual_objective_tasks",
                  user_id: uid,
                  goal_id: null,
                  title: "",
                  description: "",
                  status: "in_progress",
                  priority: "medium",
                  target_date: null,
                  order: 0,
                  created_at: "",
                  updated_at: "",
                  last_edited_at: "",
                  children: orphanTasks,
                },
              ],
            },
          ],
        });
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(tree) }],
      };
    },
  );

  // 3. list_tasks
  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks with optional filters. Use objective_id to get all tasks (including recurring) under a specific objective. Use is_recurring to filter recurring/non-recurring tasks specifically.",
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
      const tasks = unwrap(result, "list_tasks");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tasks) }],
      };
    },
  );

  // 4. list_goals
  server.registerTool(
    "list_goals",
    {
      description: `List GOALS only (not visions, not objectives, not tasks). A goal is a measurable outcome that belongs to a vision. Use this tool when the user asks for 'metas' or 'goals'. Do NOT use get_hierarchy or get_daily_snapshot to answer goal-related questions — this tool returns goals directly with their parent vision title for context.

ALSO USE FOR LOOKUPS: When you need to create an objective under a goal, call this first to find the goal's UUID by matching its title, then pass that UUID to create_objective's goal_id parameter.`,
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
      const goals = unwrap(result, "list_goals");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(goals) }],
      };
    },
  );

  // 5. list_objectives
  server.registerTool(
    "list_objectives",
    {
      description: `List objectives with optional filters. Returns each objective's UUID (id field), title, status, priority, and parent goal title.

ALSO USE FOR LOOKUPS: When you need to create a task under an objective, call this first to find the objective's UUID by matching its title, then pass that UUID to create_task's objective_id parameter.`,
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
      const objectives = unwrap(result, "list_objectives");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(objectives) }],
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
      description: "List ideas filtered by status or category",
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
