/**
 * COMMIT tool source — native SQLite implementation.
 *
 * Replaces the MCP commit-bridge (Supabase). Same 22 tool names,
 * same Zod-equivalent schemas, direct SQLite via src/db/commit.ts.
 * Read tools return pre-formatted text — the LLM relays directly.
 */

import type { ToolRegistry } from "../registry.js";
import type {
  ToolSource,
  ToolSourceManifest,
  ToolSourceHealth,
} from "../source.js";
import type { Tool } from "../types.js";
import * as db from "../../db/commit.js";

// ---------------------------------------------------------------------------
// Read tools (7)
// ---------------------------------------------------------------------------

const getDailySnapshot: Tool = {
  name: "commit__get_daily_snapshot",
  definition: {
    type: "function",
    function: {
      name: "commit__get_daily_snapshot",
      description:
        "Get daily snapshot as pre-formatted text. Relay the output directly — it IS the answer. COMMIT hierarchy: Vision > Goal > Objective > Task.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "ISO date (YYYY-MM-DD), defaults to today",
          },
        },
      },
    },
  },
  async execute(args) {
    return db.getSnapshot(args.date as string | undefined);
  },
};

const getHierarchy: Tool = {
  name: "commit__get_hierarchy",
  definition: {
    type: "function",
    function: {
      name: "commit__get_hierarchy",
      description:
        "Get the full COMMIT hierarchy tree as pre-formatted text. Relay it directly — it IS the answer.",
      parameters: {
        type: "object",
        properties: {
          include_completed: {
            type: "boolean",
            description: "Include completed items (default: false)",
          },
        },
      },
    },
  },
  async execute(args) {
    return db.getHierarchy(args.include_completed as boolean | undefined);
  },
};

const listTasksTool: Tool = {
  name: "commit__list_tasks",
  definition: {
    type: "function",
    function: {
      name: "commit__list_tasks",
      description:
        "List tasks as pre-formatted text. Relay the output directly — it IS the answer.",
      parameters: {
        type: "object",
        properties: {
          objective_id: {
            type: "string",
            description: "Filter by parent objective UUID",
          },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
            description: "Filter by status",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Filter by priority",
          },
          is_recurring: {
            type: "boolean",
            description: "Filter recurring tasks",
          },
          due_before: {
            type: "string",
            description: "Due date upper bound (YYYY-MM-DD)",
          },
          due_after: {
            type: "string",
            description: "Due date lower bound (YYYY-MM-DD)",
          },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  },
  async execute(args) {
    return db.listTasks({
      objectiveId: args.objective_id as string | undefined,
      status: args.status as
        | "not_started"
        | "in_progress"
        | "completed"
        | "on_hold"
        | undefined,
      priority: args.priority as "high" | "medium" | "low" | undefined,
      isRecurring: args.is_recurring as boolean | undefined,
      dueBefore: args.due_before as string | undefined,
      dueAfter: args.due_after as string | undefined,
      limit: args.limit as number | undefined,
    });
  },
};

const listGoalsTool: Tool = {
  name: "commit__list_goals",
  definition: {
    type: "function",
    function: {
      name: "commit__list_goals",
      description:
        "List goals as pre-formatted text. Relay the output directly — it IS the answer. Also use for UUID lookups before creating objectives.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
            description: "Filter by status",
          },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  },
  async execute(args) {
    return db.listGoals(
      args.status as
        | "not_started"
        | "in_progress"
        | "completed"
        | "on_hold"
        | undefined,
      args.limit as number | undefined,
    );
  },
};

const listObjectivesTool: Tool = {
  name: "commit__list_objectives",
  definition: {
    type: "function",
    function: {
      name: "commit__list_objectives",
      description:
        "List objectives as pre-formatted text. Relay the output directly — it IS the answer. Also use for UUID lookups before creating tasks.",
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "Filter by parent goal UUID",
          },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
            description: "Filter by status",
          },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "Filter by priority",
          },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  },
  async execute(args) {
    return db.listObjectives(
      args.goal_id as string | undefined,
      args.status as
        | "not_started"
        | "in_progress"
        | "completed"
        | "on_hold"
        | undefined,
      args.priority as "high" | "medium" | "low" | undefined,
      args.limit as number | undefined,
    );
  },
};

const searchJournalTool: Tool = {
  name: "commit__search_journal",
  definition: {
    type: "function",
    function: {
      name: "commit__search_journal",
      description:
        "Search journal entries by date range or keyword. Returns pre-formatted text.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword to search in content",
          },
          date_from: { type: "string", description: "Start date (YYYY-MM-DD)" },
          date_to: { type: "string", description: "End date (YYYY-MM-DD)" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
  },
  async execute(args) {
    return db.searchJournal(
      args.query as string | undefined,
      args.date_from as string | undefined,
      args.date_to as string | undefined,
      args.limit as number | undefined,
    );
  },
};

const listIdeasTool: Tool = {
  name: "commit__list_ideas",
  definition: {
    type: "function",
    function: {
      name: "commit__list_ideas",
      description:
        "List ideas from the COMMIT ideas library. Returns pre-formatted text.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["draft", "active", "completed", "archived"],
            description: "Filter by status",
          },
          category: { type: "string", description: "Filter by category" },
          limit: { type: "number", description: "Max results (default 50)" },
        },
      },
    },
  },
  async execute(args) {
    return db.listIdeas(
      args.status as string | undefined,
      args.category as string | undefined,
      args.limit as number | undefined,
    );
  },
};

// ---------------------------------------------------------------------------
// Write tools (15)
// ---------------------------------------------------------------------------

const updateStatusTool: Tool = {
  name: "commit__update_status",
  definition: {
    type: "function",
    function: {
      name: "commit__update_status",
      description:
        "Change the status of any COMMIT hierarchy item (vision, goal, objective, task).",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            enum: ["visions", "goals", "objectives", "tasks"],
            description: "Which table",
          },
          id: { type: "string", description: "Item UUID" },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
            description: "New status",
          },
        },
        required: ["table", "id", "status"],
      },
    },
  },
  async execute(args) {
    const r = db.updateStatus(
      args.table as string,
      args.id as string,
      args.status as "not_started" | "in_progress" | "completed" | "on_hold",
    );
    return JSON.stringify(r);
  },
};

const completeRecurringTool: Tool = {
  name: "commit__complete_recurring",
  definition: {
    type: "function",
    function: {
      name: "commit__complete_recurring",
      description: "Mark a recurring task as completed for a specific date.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task UUID" },
          date: {
            type: "string",
            description: "Completion date (YYYY-MM-DD), defaults to today",
          },
        },
        required: ["task_id"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.completeRecurring(
        args.task_id as string,
        args.date as string | undefined,
      ),
    );
  },
};

const createJournalTool: Tool = {
  name: "commit__create_journal_entry",
  definition: {
    type: "function",
    function: {
      name: "commit__create_journal_entry",
      description:
        "Create a journal entry. ONLY when the user explicitly asks to write in their journal.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Journal content" },
          date: {
            type: "string",
            description: "Entry date (YYYY-MM-DD), defaults to today",
          },
          primary_emotion: {
            type: "string",
            description: "Primary emotion tag",
          },
        },
        required: ["content"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createJournalEntry({
        content: args.content as string,
        date: args.date as string | undefined,
        primary_emotion: args.primary_emotion as string | undefined,
      }),
    );
  },
};

const createTaskTool: Tool = {
  name: "commit__create_task",
  definition: {
    type: "function",
    function: {
      name: "commit__create_task",
      description:
        "Create a new task. Use list_objectives first to find the objective UUID.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          objective_id: {
            type: "string",
            description: "Parent objective UUID",
          },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          due_date: { type: "string", description: "Due date (YYYY-MM-DD)" },
          is_recurring: {
            type: "boolean",
            description: "Whether this task repeats daily",
          },
        },
        required: ["title"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createTask({
        title: args.title as string,
        description: args.description as string | undefined,
        objective_id: args.objective_id as string | undefined,
        priority: args.priority as "high" | "medium" | "low" | undefined,
        due_date: args.due_date as string | undefined,
        is_recurring: args.is_recurring as boolean | undefined,
      }),
    );
  },
};

const createGoalTool: Tool = {
  name: "commit__create_goal",
  definition: {
    type: "function",
    function: {
      name: "commit__create_goal",
      description:
        "Create a new goal under a vision. Use get_hierarchy first to check existing goals.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Goal title" },
          description: { type: "string", description: "Goal description" },
          vision_id: { type: "string", description: "Parent vision UUID" },
          target_date: {
            type: "string",
            description: "Target date (YYYY-MM-DD)",
          },
        },
        required: ["title"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createGoal({
        title: args.title as string,
        description: args.description as string | undefined,
        vision_id: args.vision_id as string | undefined,
        target_date: args.target_date as string | undefined,
      }),
    );
  },
};

const createObjectiveTool: Tool = {
  name: "commit__create_objective",
  definition: {
    type: "function",
    function: {
      name: "commit__create_objective",
      description:
        "Create a new objective under a goal. Use list_goals first to find the goal UUID.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Objective title" },
          description: { type: "string", description: "Objective description" },
          goal_id: { type: "string", description: "Parent goal UUID" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          target_date: {
            type: "string",
            description: "Target date (YYYY-MM-DD)",
          },
        },
        required: ["title"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createObjective({
        title: args.title as string,
        description: args.description as string | undefined,
        goal_id: args.goal_id as string | undefined,
        priority: args.priority as "high" | "medium" | "low" | undefined,
        target_date: args.target_date as string | undefined,
      }),
    );
  },
};

const createVisionTool: Tool = {
  name: "commit__create_vision",
  definition: {
    type: "function",
    function: {
      name: "commit__create_vision",
      description:
        "Create a new life vision. Use get_hierarchy first to check existing visions.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Vision title" },
          description: { type: "string", description: "Vision description" },
          target_date: {
            type: "string",
            description: "Target date (YYYY-MM-DD)",
          },
        },
        required: ["title"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createVision({
        title: args.title as string,
        description: args.description as string | undefined,
        target_date: args.target_date as string | undefined,
      }),
    );
  },
};

const updateTaskTool: Tool = {
  name: "commit__update_task",
  definition: {
    type: "function",
    function: {
      name: "commit__update_task",
      description:
        "Update task fields (title, description, priority, due_date, objective_id, status, notes, is_recurring).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task UUID" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          due_date: { type: "string" },
          objective_id: {
            type: "string",
            description: "New parent objective UUID (empty string to unlink)",
          },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
          },
          notes: { type: "string" },
          is_recurring: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  async execute(args) {
    const { id, ...fields } = args as Record<string, unknown>;
    return JSON.stringify(db.updateTask(id as string, fields));
  },
};

const updateObjectiveTool: Tool = {
  name: "commit__update_objective",
  definition: {
    type: "function",
    function: {
      name: "commit__update_objective",
      description:
        "Update objective fields (title, description, priority, target_date, goal_id, status).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Objective UUID" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          target_date: { type: "string" },
          goal_id: {
            type: "string",
            description: "New parent goal UUID (empty string to unlink)",
          },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
          },
        },
        required: ["id"],
      },
    },
  },
  async execute(args) {
    const { id, ...fields } = args as Record<string, unknown>;
    return JSON.stringify(db.updateObjective(id as string, fields));
  },
};

const updateGoalTool: Tool = {
  name: "commit__update_goal",
  definition: {
    type: "function",
    function: {
      name: "commit__update_goal",
      description:
        "Update goal fields (title, description, target_date, vision_id, status).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Goal UUID" },
          title: { type: "string" },
          description: { type: "string" },
          target_date: { type: "string" },
          vision_id: {
            type: "string",
            description: "New parent vision UUID (empty string to unlink)",
          },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
          },
        },
        required: ["id"],
      },
    },
  },
  async execute(args) {
    const { id, ...fields } = args as Record<string, unknown>;
    return JSON.stringify(db.updateGoal(id as string, fields));
  },
};

const updateVisionTool: Tool = {
  name: "commit__update_vision",
  definition: {
    type: "function",
    function: {
      name: "commit__update_vision",
      description:
        "Update vision fields (title, description, target_date, status).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Vision UUID" },
          title: { type: "string" },
          description: { type: "string" },
          target_date: { type: "string" },
          status: {
            type: "string",
            enum: ["not_started", "in_progress", "completed", "on_hold"],
          },
        },
        required: ["id"],
      },
    },
  },
  async execute(args) {
    const { id, ...fields } = args as Record<string, unknown>;
    return JSON.stringify(db.updateVision(id as string, fields));
  },
};

const bulkReprioritizeTool: Tool = {
  name: "commit__bulk_reprioritize",
  definition: {
    type: "function",
    function: {
      name: "commit__bulk_reprioritize",
      description: "Batch update priorities on multiple tasks.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["id", "priority"],
            },
            description: "Array of {id, priority} updates",
          },
        },
        required: ["updates"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.bulkReprioritize(
        args.updates as Array<{
          id: string;
          priority: "high" | "medium" | "low";
        }>,
      ),
    );
  },
};

const deleteItemTool: Tool = {
  name: "commit__delete_item",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "commit__delete_item",
      description:
        "Delete a COMMIT hierarchy item. Requires confirm_title to match exactly.",
      parameters: {
        type: "object",
        properties: {
          table: {
            type: "string",
            enum: ["visions", "goals", "objectives", "tasks"],
            description: "Which table",
          },
          id: { type: "string", description: "Item UUID" },
          confirm_title: {
            type: "string",
            description: "Exact title of item to delete (safety check)",
          },
        },
        required: ["table", "id", "confirm_title"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.deleteItem(
        args.table as string,
        args.id as string,
        args.confirm_title as string,
      ),
    );
  },
};

const createSuggestionTool: Tool = {
  name: "commit__create_suggestion",
  definition: {
    type: "function",
    function: {
      name: "commit__create_suggestion",
      description: "Create an AI suggestion for the user to accept or reject.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Suggestion type (create_task, update_status, create_goal, etc.)",
          },
          target_table: {
            type: "string",
            description: "Target table (tasks, goals, objectives, visions)",
          },
          target_id: {
            type: "string",
            description: "Existing item UUID (for updates)",
          },
          title: { type: "string", description: "Human-readable summary" },
          suggestion: {
            type: "object",
            description: "Full payload (what to create/update)",
          },
          reasoning: {
            type: "string",
            description: "Why Jarvis suggests this",
          },
          source: {
            type: "string",
            description:
              "Origin (conversation, journal_analysis, proactive_scan)",
          },
        },
        required: ["type", "title", "suggestion"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.createSuggestion({
        type: args.type as string,
        target_table: args.target_table as string | undefined,
        target_id: args.target_id as string | undefined,
        title: args.title as string,
        suggestion: args.suggestion as Record<string, unknown>,
        reasoning: args.reasoning as string | undefined,
        source: args.source as string | undefined,
      }),
    );
  },
};

const upsertAiAnalysisTool: Tool = {
  name: "commit__upsert_ai_analysis",
  definition: {
    type: "function",
    function: {
      name: "commit__upsert_ai_analysis",
      description:
        "Store AI analysis results for a journal entry (emotions, patterns, coping strategies).",
      parameters: {
        type: "object",
        properties: {
          journal_entry_id: {
            type: "string",
            description: "Journal entry UUID",
          },
          emotions: {
            type: "array",
            description: "Array of {name, intensity, color}",
          },
          patterns: {
            type: "array",
            items: { type: "string" },
            description: "Detected patterns",
          },
          coping_strategies: {
            type: "array",
            items: { type: "string" },
            description: "Suggested strategies",
          },
          primary_emotion: { type: "string", description: "Dominant emotion" },
        },
        required: ["journal_entry_id"],
      },
    },
  },
  async execute(args) {
    return JSON.stringify(
      db.upsertAiAnalysis({
        entry_id: args.journal_entry_id as string,
        emotions: args.emotions as unknown[] | undefined,
        patterns: args.patterns as string[] | undefined,
        coping_strategies: args.coping_strategies as string[] | undefined,
        primary_emotion: args.primary_emotion as string | undefined,
      }),
    );
  },
};

// ---------------------------------------------------------------------------
// Tool Source
// ---------------------------------------------------------------------------

const ALL_TOOLS: Tool[] = [
  getDailySnapshot,
  getHierarchy,
  listTasksTool,
  listGoalsTool,
  listObjectivesTool,
  searchJournalTool,
  listIdeasTool,
  updateStatusTool,
  completeRecurringTool,
  createJournalTool,
  createTaskTool,
  createGoalTool,
  createObjectiveTool,
  createVisionTool,
  updateTaskTool,
  updateObjectiveTool,
  updateGoalTool,
  updateVisionTool,
  bulkReprioritizeTool,
  deleteItemTool,
  createSuggestionTool,
  upsertAiAnalysisTool,
];

export class CommitToolSource implements ToolSource {
  readonly manifest: ToolSourceManifest = {
    name: "commit",
    version: "2.0.0",
    description: "COMMIT productivity framework (native SQLite)",
  };

  async initialize(): Promise<void> {
    // Tables created by ensureCommitTables() in initDatabase()
  }

  async registerTools(registry: ToolRegistry): Promise<string[]> {
    for (const tool of ALL_TOOLS) {
      registry.register(tool);
    }
    return ALL_TOOLS.map((t) => t.name);
  }

  async healthCheck(): Promise<ToolSourceHealth> {
    try {
      const { getDatabase } = await import("../../db/index.js");
      const db = getDatabase();
      const row = db
        .prepare("SELECT COUNT(*) as c FROM commit_visions")
        .get() as { c: number };
      return {
        healthy: true,
        message: `${row.c} visions in local DB`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        healthy: false,
        message: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async teardown(): Promise<void> {
    // SQLite managed by singleton — no teardown needed
  }
}
