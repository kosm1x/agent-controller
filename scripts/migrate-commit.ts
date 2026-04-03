/**
 * One-time migration: COMMIT data from Supabase (db.mycommit.net) → local SQLite.
 *
 * Usage: npx tsx scripts/migrate-commit.ts
 *
 * Reads from Supabase REST API, inserts into mc.db COMMIT tables.
 * Preserves UUIDs, converts timestamps to ISO, skips existing rows.
 */

import { randomUUID } from "crypto";

// --- Config (from mcp-servers.json env) ---
const SUPABASE_URL = "https://db.mycommit.net";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NzUxNTgwMjEsImV4cCI6MTkzMjgzODAyMX0.yzz5TAijY5eBfAAzPWfoMocS7abltXJZ0AL-0wZeBhA";
const USER_ID = "646bf492-4813-4cfc-b49d-af0dbfa8cecc";

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function fetchTable(table: string, select = "*"): Promise<unknown[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}&user_id=eq.${USER_ID}`;
  const res = await fetch(url, { headers });
  if (!res.ok)
    throw new Error(
      `Failed to fetch ${table}: ${res.status} ${await res.text()}`,
    );
  return (await res.json()) as unknown[];
}

function ts(val: string | null): string | null {
  if (!val) return null;
  // Supabase returns ISO with timezone, SQLite wants plain ISO
  return val
    .replace(/\+00:00$/, "")
    .replace(/T/, " ")
    .replace(/\.\d+$/, "");
}

function d(val: string | null): string | null {
  if (!val) return null;
  return val.slice(0, 10); // YYYY-MM-DD
}

async function main() {
  // Dynamically import to use the project's DB setup
  const { initDatabase, getDatabase } = await import("../src/db/index.js");
  initDatabase("./data/mc.db");
  const db = getDatabase();

  console.log("Fetching data from Supabase...");

  const [
    visions,
    goals,
    objectives,
    tasks,
    completions,
    journal,
    analysis,
    suggestions,
  ] = await Promise.all([
    fetchTable("visions"),
    fetchTable("goals"),
    fetchTable("objectives"),
    fetchTable("tasks"),
    fetchTable("task_completions"),
    fetchTable("journal_entries"),
    fetchTable("ai_analysis"),
    fetchTable("agent_suggestions"),
  ]);

  console.log(
    `Fetched: ${visions.length} visions, ${goals.length} goals, ${objectives.length} objectives, ` +
      `${tasks.length} tasks, ${completions.length} completions, ${journal.length} journal, ` +
      `${analysis.length} analysis, ${suggestions.length} suggestions`,
  );

  // --- Insert with transactions ---
  const insertVision = db.prepare(
    `INSERT OR IGNORE INTO commit_visions (id, title, description, status, target_date, "order", modified_by, created_at, updated_at, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGoal = db.prepare(
    `INSERT OR IGNORE INTO commit_goals (id, vision_id, title, description, status, target_date, "order", modified_by, created_at, updated_at, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertObjective = db.prepare(
    `INSERT OR IGNORE INTO commit_objectives (id, goal_id, title, description, status, priority, target_date, "order", modified_by, created_at, updated_at, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTask = db.prepare(
    `INSERT OR IGNORE INTO commit_tasks (id, objective_id, title, description, status, priority, due_date, completed_at, is_recurring, notes, document_links, "order", modified_by, created_at, updated_at, last_edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCompletion = db.prepare(
    `INSERT OR IGNORE INTO commit_completions (id, task_id, completion_date, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const insertJournal = db.prepare(
    `INSERT OR IGNORE INTO commit_journal (id, content, entry_date, primary_emotion, modified_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAnalysis = db.prepare(
    `INSERT OR IGNORE INTO commit_ai_analysis (id, entry_id, emotions, patterns, coping_strategies, primary_emotion, created_at, analyzed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSuggestion = db.prepare(
    `INSERT OR IGNORE INTO commit_suggestions (id, type, target_table, target_id, title, suggestion, reasoning, source, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const r of visions as Record<string, unknown>[]) {
      insertVision.run(
        r.id,
        r.title,
        r.description ?? "",
        r.status,
        d(r.target_date as string),
        r.order ?? 0,
        r.modified_by ?? "user",
        ts(r.created_at as string),
        ts(r.updated_at as string),
        ts(r.last_edited_at as string),
      );
    }
    for (const r of goals as Record<string, unknown>[]) {
      insertGoal.run(
        r.id,
        r.vision_id,
        r.title,
        r.description ?? "",
        r.status,
        d(r.target_date as string),
        r.order ?? 0,
        r.modified_by ?? "user",
        ts(r.created_at as string),
        ts(r.updated_at as string),
        ts(r.last_edited_at as string),
      );
    }
    for (const r of objectives as Record<string, unknown>[]) {
      insertObjective.run(
        r.id,
        r.goal_id,
        r.title,
        r.description ?? "",
        r.status,
        r.priority ?? "medium",
        d(r.target_date as string),
        r.order ?? 0,
        r.modified_by ?? "user",
        ts(r.created_at as string),
        ts(r.updated_at as string),
        ts(r.last_edited_at as string),
      );
    }
    for (const r of tasks as Record<string, unknown>[]) {
      insertTask.run(
        r.id,
        r.objective_id,
        r.title,
        r.description ?? "",
        r.status,
        r.priority ?? "medium",
        d(r.due_date as string),
        ts(r.completed_at as string),
        r.is_recurring ? 1 : 0,
        r.notes ?? "",
        JSON.stringify(r.document_links ?? []),
        r.order ?? 0,
        r.modified_by ?? "user",
        ts(r.created_at as string),
        ts(r.updated_at as string),
        ts(r.last_edited_at as string),
      );
    }
    for (const r of completions as Record<string, unknown>[]) {
      insertCompletion.run(
        r.id ?? randomUUID(),
        r.task_id,
        d(r.completion_date as string),
        ts(r.created_at as string),
      );
    }
    for (const r of journal as Record<string, unknown>[]) {
      insertJournal.run(
        r.id,
        r.content,
        d(r.entry_date as string),
        r.primary_emotion,
        r.modified_by ?? "user",
        ts(r.created_at as string),
        ts(r.updated_at as string),
      );
    }
    for (const r of analysis as Record<string, unknown>[]) {
      insertAnalysis.run(
        r.id,
        r.entry_id,
        JSON.stringify(r.emotions ?? []),
        JSON.stringify(r.patterns ?? []),
        JSON.stringify(r.coping_strategies ?? []),
        r.primary_emotion,
        ts(r.created_at as string),
        ts(r.analyzed_at as string),
      );
    }
    for (const r of suggestions as Record<string, unknown>[]) {
      insertSuggestion.run(
        r.id,
        r.type,
        r.target_table,
        r.target_id,
        r.title,
        JSON.stringify(r.suggestion ?? {}),
        r.reasoning,
        r.source,
        r.status ?? "pending",
        ts(r.created_at as string),
        ts(r.resolved_at as string),
      );
    }
  });

  tx();

  // Verify
  const counts = {
    visions: (
      db.prepare("SELECT COUNT(*) as c FROM commit_visions").get() as {
        c: number;
      }
    ).c,
    goals: (
      db.prepare("SELECT COUNT(*) as c FROM commit_goals").get() as {
        c: number;
      }
    ).c,
    objectives: (
      db.prepare("SELECT COUNT(*) as c FROM commit_objectives").get() as {
        c: number;
      }
    ).c,
    tasks: (
      db.prepare("SELECT COUNT(*) as c FROM commit_tasks").get() as {
        c: number;
      }
    ).c,
    completions: (
      db.prepare("SELECT COUNT(*) as c FROM commit_completions").get() as {
        c: number;
      }
    ).c,
    journal: (
      db.prepare("SELECT COUNT(*) as c FROM commit_journal").get() as {
        c: number;
      }
    ).c,
    analysis: (
      db.prepare("SELECT COUNT(*) as c FROM commit_ai_analysis").get() as {
        c: number;
      }
    ).c,
    suggestions: (
      db.prepare("SELECT COUNT(*) as c FROM commit_suggestions").get() as {
        c: number;
      }
    ).c,
  };

  console.log("Migration complete. Row counts:", counts);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
