/**
 * COMMIT CRUD — Direct SQLite operations for the COMMIT productivity framework.
 *
 * All read functions return pre-formatted human-readable text.
 * The LLM relays this directly — no JSON interpretation needed.
 */

import { randomUUID } from "crypto";
import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HierarchyStatus = "not_started" | "in_progress" | "completed" | "on_hold";
type Priority = "high" | "medium" | "low";

interface VisionRow {
  id: string;
  title: string;
  description: string;
  status: HierarchyStatus;
  target_date: string | null;
  order: number;
  modified_by: string;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

interface GoalRow {
  id: string;
  vision_id: string | null;
  title: string;
  description: string;
  status: HierarchyStatus;
  target_date: string | null;
  order: number;
  modified_by: string;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

interface ObjectiveRow {
  id: string;
  goal_id: string | null;
  title: string;
  description: string;
  status: HierarchyStatus;
  priority: Priority;
  target_date: string | null;
  order: number;
  modified_by: string;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

interface TaskRow {
  id: string;
  objective_id: string | null;
  title: string;
  description: string;
  status: HierarchyStatus;
  priority: Priority;
  due_date: string | null;
  completed_at: string | null;
  is_recurring: number;
  notes: string;
  document_links: string;
  order: number;
  modified_by: string;
  created_at: string;
  updated_at: string;
  last_edited_at: string;
}

interface JournalRow {
  id: string;
  content: string;
  entry_date: string;
  primary_emotion: string | null;
  modified_by: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUTH_FOOTER =
  "\n---\nABOVE IS THE COMPLETE DATA FROM THE DATABASE. If an item is not listed, it DOES NOT EXIST in COMMIT. Do not fabricate, infer, or supplement with data from other sources.";

const VALID_TABLES = new Set([
  "commit_visions",
  "commit_goals",
  "commit_objectives",
  "commit_tasks",
]);

const USER_TZ = "America/Mexico_City";

function todayMx(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: USER_TZ });
}

function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// READ — Pre-formatted text output
// ---------------------------------------------------------------------------

export function getSnapshot(date?: string): string {
  const db = getDatabase();
  const today = date ?? todayMx();

  const vision = db
    .prepare(
      `SELECT * FROM commit_visions WHERE status != 'completed' ORDER BY "order" LIMIT 1`,
    )
    .get() as VisionRow | undefined;

  const goalCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM commit_goals WHERE status = 'in_progress'`,
      )
      .get() as { c: number }
  ).c;

  const objCount = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM commit_objectives WHERE status = 'in_progress'`,
      )
      .get() as { c: number }
  ).c;

  const pendingTasks = db
    .prepare(
      `SELECT * FROM commit_tasks WHERE status != 'completed' ORDER BY due_date ASC NULLS LAST`,
    )
    .all() as TaskRow[];

  const completedToday = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM commit_completions WHERE completion_date = ?`,
      )
      .get(today) as { c: number }
  ).c;

  // Streak calculation
  const streakDates = db
    .prepare(
      `SELECT DISTINCT completion_date FROM commit_completions ORDER BY completion_date DESC LIMIT 30`,
    )
    .all() as Array<{ completion_date: string }>;

  let streak = 0;
  const cursor = new Date(today + "T12:00:00");
  for (const { completion_date } of streakDates) {
    const expected = cursor.toLocaleDateString("en-CA", { timeZone: USER_TZ });
    if (completion_date === expected) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else if (completion_date < expected) {
      break;
    }
  }

  // Categorize tasks
  const overdue: TaskRow[] = [];
  const dueToday: TaskRow[] = [];
  const inProgress: TaskRow[] = [];
  const recurringPending: TaskRow[] = [];

  const completedIds = new Set(
    (
      db
        .prepare(
          `SELECT task_id FROM commit_completions WHERE completion_date = ?`,
        )
        .all(today) as Array<{ task_id: string }>
    ).map((r) => r.task_id),
  );

  for (const t of pendingTasks) {
    if (t.is_recurring) {
      if (!completedIds.has(t.id)) recurringPending.push(t);
      continue;
    }
    if (t.due_date && t.due_date < today) overdue.push(t);
    else if (t.due_date === today) dueToday.push(t);
    else if (t.status === "in_progress") inProgress.push(t);
  }

  const lines: string[] = [];
  lines.push(`DAILY SNAPSHOT — ${today}`);
  lines.push("=".repeat(50));
  if (vision) {
    lines.push(`Active Vision: ${vision.title} (${vision.status})`);
  }
  lines.push(
    `Goals: ${goalCount} active | Objectives: ${objCount} active | Tasks: ${pendingTasks.length} pending | Done today: ${completedToday} | Streak: ${streak} days`,
  );

  if (overdue.length > 0) {
    lines.push("");
    lines.push("OVERDUE:");
    for (const t of overdue)
      lines.push(
        `  - ${t.title} (due: ${t.due_date}, priority: ${t.priority})`,
      );
  }
  if (dueToday.length > 0) {
    lines.push("");
    lines.push("DUE TODAY:");
    for (const t of dueToday)
      lines.push(`  - ${t.title} (priority: ${t.priority})`);
  }
  if (inProgress.length > 0) {
    lines.push("");
    lines.push("IN PROGRESS:");
    for (const t of inProgress)
      lines.push(
        `  - ${t.title} (priority: ${t.priority}, due: ${t.due_date ?? "none"})`,
      );
  }
  if (recurringPending.length > 0) {
    lines.push("");
    lines.push("RECURRING (pending today):");
    for (const t of recurringPending) lines.push(`  - ${t.title}`);
  }

  return lines.join("\n") + TRUTH_FOOTER;
}

export function getHierarchy(includeCompleted?: boolean): string {
  const db = getDatabase();
  const filter = includeCompleted ? "" : `WHERE status != 'completed'`;

  const visions = db
    .prepare(`SELECT * FROM commit_visions ${filter} ORDER BY "order"`)
    .all() as VisionRow[];
  const goals = db
    .prepare(`SELECT * FROM commit_goals ${filter} ORDER BY "order"`)
    .all() as GoalRow[];
  const objectives = db
    .prepare(`SELECT * FROM commit_objectives ${filter} ORDER BY "order"`)
    .all() as ObjectiveRow[];
  const tasks = db
    .prepare(`SELECT * FROM commit_tasks ${filter} ORDER BY "order"`)
    .all() as TaskRow[];

  // Build maps
  const tasksByObj = new Map<string | null, TaskRow[]>();
  for (const t of tasks) {
    const key = t.objective_id;
    if (!tasksByObj.has(key)) tasksByObj.set(key, []);
    tasksByObj.get(key)!.push(t);
  }
  const objsByGoal = new Map<string | null, ObjectiveRow[]>();
  for (const o of objectives) {
    const key = o.goal_id;
    if (!objsByGoal.has(key)) objsByGoal.set(key, []);
    objsByGoal.get(key)!.push(o);
  }
  const goalsByVision = new Map<string | null, GoalRow[]>();
  for (const g of goals) {
    const key = g.vision_id;
    if (!goalsByVision.has(key)) goalsByVision.set(key, []);
    goalsByVision.get(key)!.push(g);
  }

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

    if (vGoals.length === 0) lines.push("  (no goals)");
    for (const g of vGoals) {
      const gObjs = objsByGoal.get(g.id) ?? [];
      lines.push(`  GOAL: ${g.title}`);
      lines.push(
        `    Status: ${g.status} | Target: ${g.target_date ?? "none"} | Description: ${g.description || "(none)"}`,
      );

      if (gObjs.length === 0) lines.push("    (no objectives)");
      for (const o of gObjs) {
        const oTasks = tasksByObj.get(o.id) ?? [];
        lines.push(`    OBJECTIVE: ${o.title}`);
        lines.push(
          `      Status: ${o.status} | Priority: ${o.priority} | Target: ${o.target_date ?? "none"}`,
        );

        for (const t of oTasks) {
          const rec = t.is_recurring ? " [recurring]" : "";
          lines.push(`      TASK: ${t.title}${rec}`);
          lines.push(
            `        Status: ${t.status} | Priority: ${t.priority} | Due: ${t.due_date ?? "none"}`,
          );
        }
      }
    }
  }

  // Orphans
  const orphanGoals = goalsByVision.get(null) ?? [];
  const orphanObjs = objsByGoal.get(null) ?? [];
  const orphanTasks = tasksByObj.get(null) ?? [];

  if (
    orphanGoals.length > 0 ||
    orphanObjs.length > 0 ||
    orphanTasks.length > 0
  ) {
    lines.push("");
    lines.push("UNLINKED ITEMS (not part of any vision)");
    lines.push("-".repeat(40));
    for (const g of orphanGoals)
      lines.push(`  GOAL (no vision): ${g.title} | Status: ${g.status}`);
    for (const o of orphanObjs)
      lines.push(
        `  OBJECTIVE (no goal): ${o.title} | Status: ${o.status} | Priority: ${o.priority}`,
      );
    for (const t of orphanTasks)
      lines.push(
        `  TASK (no objective): ${t.title} | Status: ${t.status} | Due: ${t.due_date ?? "none"}`,
      );
  }

  return lines.join("\n") + TRUTH_FOOTER;
}

export function listGoals(status?: HierarchyStatus, limit?: number): string {
  const db = getDatabase();
  const conditions = ["1=1"];
  const params: unknown[] = [];
  if (status) {
    conditions.push("g.status = ?");
    params.push(status);
  }
  params.push(limit ?? 50);

  const goals = db
    .prepare(
      `SELECT g.*, v.title as vision_title FROM commit_goals g
       LEFT JOIN commit_visions v ON g.vision_id = v.id
       WHERE ${conditions.join(" AND ")} ORDER BY g."order" LIMIT ?`,
    )
    .all(...params) as Array<GoalRow & { vision_title: string | null }>;

  const lines: string[] = [];
  lines.push(`GOALS (${goals.length} results)`);
  lines.push("-".repeat(50));
  for (const g of goals) {
    lines.push(`GOAL: ${g.title}`);
    lines.push(`  ID: ${g.id}`);
    lines.push(
      `  Status: ${g.status} | Vision: ${g.vision_title ?? "(no vision)"} | Target: ${g.target_date ?? "none"}`,
    );
    if (g.description) lines.push(`  Description: ${g.description}`);
  }
  return lines.join("\n") + TRUTH_FOOTER;
}

export function listObjectives(
  goalId?: string,
  status?: HierarchyStatus,
  priority?: Priority,
  limit?: number,
): string {
  const db = getDatabase();
  const conditions = ["1=1"];
  const params: unknown[] = [];
  if (goalId) {
    conditions.push("o.goal_id = ?");
    params.push(goalId);
  }
  if (status) {
    conditions.push("o.status = ?");
    params.push(status);
  }
  if (priority) {
    conditions.push("o.priority = ?");
    params.push(priority);
  }
  params.push(limit ?? 50);

  const objectives = db
    .prepare(
      `SELECT o.*, g.title as goal_title FROM commit_objectives o
       LEFT JOIN commit_goals g ON o.goal_id = g.id
       WHERE ${conditions.join(" AND ")} ORDER BY o."order" LIMIT ?`,
    )
    .all(...params) as Array<ObjectiveRow & { goal_title: string | null }>;

  const lines: string[] = [];
  lines.push(`OBJECTIVES (${objectives.length} results)`);
  lines.push("-".repeat(50));
  for (const o of objectives) {
    lines.push(`OBJECTIVE: ${o.title}`);
    lines.push(`  ID: ${o.id}`);
    lines.push(
      `  Status: ${o.status} | Priority: ${o.priority} | Goal: ${o.goal_title ?? "(no goal)"} | Target: ${o.target_date ?? "none"}`,
    );
    if (o.description) lines.push(`  Description: ${o.description}`);
  }
  return lines.join("\n") + TRUTH_FOOTER;
}

export function listTasks(opts?: {
  objectiveId?: string;
  status?: HierarchyStatus;
  priority?: Priority;
  isRecurring?: boolean;
  dueBefore?: string;
  dueAfter?: string;
  limit?: number;
}): string {
  const db = getDatabase();
  const conditions = ["1=1"];
  const params: unknown[] = [];
  if (opts?.objectiveId) {
    conditions.push("t.objective_id = ?");
    params.push(opts.objectiveId);
  }
  if (opts?.status) {
    conditions.push("t.status = ?");
    params.push(opts.status);
  }
  if (opts?.priority) {
    conditions.push("t.priority = ?");
    params.push(opts.priority);
  }
  if (opts?.isRecurring !== undefined) {
    conditions.push("t.is_recurring = ?");
    params.push(opts.isRecurring ? 1 : 0);
  }
  if (opts?.dueBefore) {
    conditions.push("t.due_date <= ?");
    params.push(opts.dueBefore);
  }
  if (opts?.dueAfter) {
    conditions.push("t.due_date >= ?");
    params.push(opts.dueAfter);
  }
  params.push(opts?.limit ?? 50);

  const tasks = db
    .prepare(
      `SELECT t.*, o.title as objective_title FROM commit_tasks t
       LEFT JOIN commit_objectives o ON t.objective_id = o.id
       WHERE ${conditions.join(" AND ")} ORDER BY t.due_date ASC NULLS LAST LIMIT ?`,
    )
    .all(...params) as Array<TaskRow & { objective_title: string | null }>;

  const lines: string[] = [];
  lines.push(`TASKS (${tasks.length} results)`);
  lines.push("-".repeat(50));
  for (const t of tasks) {
    const rec = t.is_recurring ? " [recurring]" : "";
    lines.push(`TASK: ${t.title}${rec}`);
    lines.push(`  ID: ${t.id}`);
    lines.push(
      `  Status: ${t.status} | Priority: ${t.priority} | Objective: ${t.objective_title ?? "(no objective)"} | Due: ${t.due_date ?? "none"}`,
    );
    if (t.description) lines.push(`  Description: ${t.description}`);
    if (t.notes) lines.push(`  Notes: ${t.notes}`);
  }
  return lines.join("\n") + TRUTH_FOOTER;
}

export function searchJournal(
  query?: string,
  dateFrom?: string,
  dateTo?: string,
  limit?: number,
): string {
  const db = getDatabase();
  const conditions = ["1=1"];
  const params: unknown[] = [];
  if (query) {
    conditions.push("content LIKE ?");
    params.push(`%${query}%`);
  }
  if (dateFrom) {
    conditions.push("entry_date >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("entry_date <= ?");
    params.push(dateTo);
  }
  params.push(limit ?? 20);

  const entries = db
    .prepare(
      `SELECT * FROM commit_journal WHERE ${conditions.join(" AND ")} ORDER BY entry_date DESC LIMIT ?`,
    )
    .all(...params) as JournalRow[];

  const lines: string[] = [];
  lines.push(`JOURNAL ENTRIES (${entries.length} results)`);
  lines.push("-".repeat(50));
  for (const e of entries) {
    lines.push(
      `ENTRY: ${e.entry_date} ${e.primary_emotion ? `(${e.primary_emotion})` : ""}`,
    );
    lines.push(`  ID: ${e.id}`);
    lines.push(
      `  ${e.content.slice(0, 300)}${e.content.length > 300 ? "..." : ""}`,
    );
  }
  return lines.join("\n") + TRUTH_FOOTER;
}

export function listIdeas(
  _status?: string,
  _category?: string,
  _limit?: number,
): string {
  // Ideas table not yet migrated (P1) — return empty
  return `IDEAS (0 results)\n(Ideas table not yet migrated to local database)${TRUTH_FOOTER}`;
}

// ---------------------------------------------------------------------------
// WRITE operations
// ---------------------------------------------------------------------------

export function updateStatus(
  table: string,
  id: string,
  status: HierarchyStatus,
): { ok: boolean; message: string } {
  const dbTable = `commit_${table}`;
  if (!VALID_TABLES.has(dbTable))
    return { ok: false, message: `Invalid table: ${table}` };

  const db = getDatabase();
  const extra =
    dbTable === "commit_tasks" && status === "completed"
      ? `, completed_at = datetime('now')`
      : dbTable === "commit_tasks" && status !== "completed"
        ? `, completed_at = NULL`
        : "";

  const result = db
    .prepare(
      `UPDATE ${dbTable} SET status = ?, modified_by = 'jarvis', updated_at = datetime('now'), last_edited_at = datetime('now')${extra} WHERE id = ?`,
    )
    .run(status, id);

  return result.changes > 0
    ? { ok: true, message: `Updated ${table} ${id} to ${status}` }
    : { ok: false, message: `Not found: ${table} ${id}` };
}

export function completeRecurring(
  taskId: string,
  date?: string,
): { ok: boolean; message: string } {
  const db = getDatabase();
  const completionDate = date ?? todayMx();
  try {
    db.prepare(
      `INSERT INTO commit_completions (id, task_id, completion_date) VALUES (?, ?, ?)`,
    ).run(newId(), taskId, completionDate);
    return {
      ok: true,
      message: `Recurring task ${taskId} completed for ${completionDate}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE")) {
      return { ok: false, message: `Already completed for ${completionDate}` };
    }
    return { ok: false, message: msg };
  }
}

export function createVision(fields: {
  title: string;
  description?: string;
  target_date?: string;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_visions (id, title, description, target_date, modified_by)
     VALUES (?, ?, ?, ?, 'jarvis')`,
  ).run(id, fields.title, fields.description ?? "", fields.target_date ?? null);
  return { ok: true, id, message: `Created vision: ${fields.title}` };
}

export function createGoal(fields: {
  title: string;
  description?: string;
  vision_id?: string;
  target_date?: string;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_goals (id, vision_id, title, description, target_date, modified_by)
     VALUES (?, ?, ?, ?, ?, 'jarvis')`,
  ).run(
    id,
    fields.vision_id ?? null,
    fields.title,
    fields.description ?? "",
    fields.target_date ?? null,
  );
  return { ok: true, id, message: `Created goal: ${fields.title}` };
}

export function createObjective(fields: {
  title: string;
  description?: string;
  goal_id?: string;
  priority?: Priority;
  target_date?: string;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_objectives (id, goal_id, title, description, priority, target_date, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, 'jarvis')`,
  ).run(
    id,
    fields.goal_id ?? null,
    fields.title,
    fields.description ?? "",
    fields.priority ?? "medium",
    fields.target_date ?? null,
  );
  return { ok: true, id, message: `Created objective: ${fields.title}` };
}

export function createTask(fields: {
  title: string;
  description?: string;
  objective_id?: string;
  priority?: Priority;
  due_date?: string;
  is_recurring?: boolean;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_tasks (id, objective_id, title, description, priority, due_date, is_recurring, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'jarvis')`,
  ).run(
    id,
    fields.objective_id ?? null,
    fields.title,
    fields.description ?? "",
    fields.priority ?? "medium",
    fields.due_date ?? null,
    fields.is_recurring ? 1 : 0,
  );
  return { ok: true, id, message: `Created task: ${fields.title}` };
}

function buildPartialUpdate(
  table: string,
  id: string,
  fields: Record<string, unknown>,
): { ok: boolean; message: string } {
  const dbTable = `commit_${table}`;
  if (!VALID_TABLES.has(dbTable))
    return { ok: false, message: `Invalid table: ${table}` };

  const db = getDatabase();
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    // Normalize empty string to null for optional FKs
    const normalized =
      (key === "vision_id" || key === "goal_id" || key === "objective_id") &&
      value === ""
        ? null
        : value;
    setClauses.push(`"${key}" = ?`);
    params.push(normalized);
  }

  if (setClauses.length === 0)
    return { ok: false, message: "No fields to update" };

  setClauses.push(`modified_by = 'jarvis'`);
  setClauses.push(`updated_at = datetime('now')`);
  setClauses.push(`last_edited_at = datetime('now')`);

  params.push(id);
  const result = db
    .prepare(`UPDATE ${dbTable} SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...params);

  return result.changes > 0
    ? { ok: true, message: `Updated ${table} ${id}` }
    : { ok: false, message: `Not found: ${table} ${id}` };
}

export function updateVision(
  id: string,
  fields: Partial<
    Pick<VisionRow, "title" | "description" | "target_date" | "status">
  >,
): { ok: boolean; message: string } {
  return buildPartialUpdate("visions", id, fields);
}

export function updateGoal(
  id: string,
  fields: Partial<
    Pick<
      GoalRow,
      "title" | "description" | "target_date" | "vision_id" | "status"
    >
  >,
): { ok: boolean; message: string } {
  return buildPartialUpdate("goals", id, fields);
}

export function updateObjective(
  id: string,
  fields: Partial<
    Pick<
      ObjectiveRow,
      | "title"
      | "description"
      | "priority"
      | "target_date"
      | "goal_id"
      | "status"
    >
  >,
): { ok: boolean; message: string } {
  return buildPartialUpdate("objectives", id, fields);
}

export function updateTask(
  id: string,
  fields: Partial<
    Pick<
      TaskRow,
      | "title"
      | "description"
      | "priority"
      | "due_date"
      | "objective_id"
      | "status"
      | "notes"
    >
  > & { is_recurring?: boolean },
): { ok: boolean; message: string } {
  const mapped: Record<string, unknown> = { ...fields };
  if (fields.is_recurring !== undefined)
    mapped.is_recurring = fields.is_recurring ? 1 : 0;
  return buildPartialUpdate("tasks", id, mapped);
}

export function deleteItem(
  table: string,
  id: string,
  confirmTitle: string,
): { ok: boolean; message: string } {
  const dbTable = `commit_${table}`;
  if (!VALID_TABLES.has(dbTable))
    return { ok: false, message: `Invalid table: ${table}` };

  const db = getDatabase();
  const row = db
    .prepare(`SELECT title FROM ${dbTable} WHERE id = ?`)
    .get(id) as { title: string } | undefined;

  if (!row) return { ok: false, message: `Not found: ${table} ${id}` };
  if (row.title !== confirmTitle)
    return {
      ok: false,
      message: `Title mismatch: expected "${row.title}", got "${confirmTitle}"`,
    };

  db.prepare(`DELETE FROM ${dbTable} WHERE id = ?`).run(id);
  return { ok: true, message: `Deleted ${table}: ${confirmTitle}` };
}

export function bulkReprioritize(
  updates: Array<{ id: string; priority: Priority }>,
): { ok: boolean; message: string } {
  const db = getDatabase();
  const stmt = db.prepare(
    `UPDATE commit_tasks SET priority = ?, modified_by = 'jarvis', updated_at = datetime('now') WHERE id = ?`,
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const u of updates) {
      const r = stmt.run(u.priority, u.id);
      count += r.changes;
    }
  });
  tx();
  return { ok: true, message: `Updated priority on ${count} tasks` };
}

export function createJournalEntry(fields: {
  content: string;
  date?: string;
  primary_emotion?: string;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_journal (id, content, entry_date, primary_emotion, modified_by)
     VALUES (?, ?, ?, ?, 'jarvis')`,
  ).run(
    id,
    fields.content,
    fields.date ?? todayMx(),
    fields.primary_emotion ?? null,
  );
  return {
    ok: true,
    id,
    message: `Journal entry created for ${fields.date ?? todayMx()}`,
  };
}

export function createSuggestion(fields: {
  type: string;
  target_table?: string;
  target_id?: string;
  title: string;
  suggestion: Record<string, unknown>;
  reasoning?: string;
  source?: string;
}): { ok: boolean; id: string; message: string } {
  const db = getDatabase();
  const id = newId();
  db.prepare(
    `INSERT INTO commit_suggestions (id, type, target_table, target_id, title, suggestion, reasoning, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.type,
    fields.target_table ?? null,
    fields.target_id ?? null,
    fields.title,
    JSON.stringify(fields.suggestion),
    fields.reasoning ?? null,
    fields.source ?? null,
  );
  return { ok: true, id, message: `Suggestion created: ${fields.title}` };
}

export function upsertAiAnalysis(fields: {
  entry_id: string;
  emotions?: unknown[];
  patterns?: string[];
  coping_strategies?: string[];
  primary_emotion?: string;
}): { ok: boolean; message: string } {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO commit_ai_analysis (id, entry_id, emotions, patterns, coping_strategies, primary_emotion)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       emotions = excluded.emotions,
       patterns = excluded.patterns,
       coping_strategies = excluded.coping_strategies,
       primary_emotion = excluded.primary_emotion,
       analyzed_at = datetime('now')`,
  ).run(
    newId(),
    fields.entry_id,
    JSON.stringify(fields.emotions ?? []),
    JSON.stringify(fields.patterns ?? []),
    JSON.stringify(fields.coping_strategies ?? []),
    fields.primary_emotion ?? null,
  );
  return {
    ok: true,
    message: `Analysis upserted for journal ${fields.entry_id}`,
  };
}
