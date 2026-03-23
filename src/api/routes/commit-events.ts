/**
 * COMMIT event webhook endpoint.
 *
 * Receives real-time events from COMMIT (via Supabase Database Webhooks or
 * Edge Function) when data changes. Routes events to the appropriate handler.
 *
 * POST /api/commit-events
 * Body: { event, table, row_id, user_id, modified_by, changes }
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { getEventBus } from "../../lib/event-bus.js";
import { analyzeJournalDeep } from "../../commit-ai/journal-analysis.js";

interface CommitEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  row_id: string;
  user_id: string;
  modified_by: string;
  changes: Record<string, unknown>;
}

export const commitEvents = new Hono();

commitEvents.post("/", async (c) => {
  let body: CommitEvent;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { event, table, row_id, user_id, modified_by, changes } = body;

  if (!event || !table || !row_id) {
    return c.json(
      { error: "Missing required fields: event, table, row_id" },
      400,
    );
  }

  // Skip events from Jarvis itself to prevent echo loops
  if (modified_by === "jarvis") {
    return c.json({ status: "skipped", reason: "self-originated" });
  }

  // Log the event
  console.log(
    `[commit-events] ${event} ${table}/${row_id} by ${modified_by ?? "user"}`,
  );

  // Store in local DB for processing
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO commit_events (event_type, table_name, row_id, user_id, modified_by, changes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      event,
      table,
      row_id,
      user_id ?? null,
      modified_by ?? "user",
      JSON.stringify(changes ?? {}),
    );
  } catch {
    // Table may not exist yet — non-fatal
  }

  // Emit to internal event bus for reactive processing
  try {
    const bus = getEventBus();
    const eventName = `commit.${table}.${event.toLowerCase()}`;
    bus.emitEvent(eventName as "task.completed", {
      task_id: row_id, // reuse the standard payload shape
      agent_id: "commit-webhook",
      result: changes,
      duration_ms: 0,
    });
  } catch {
    // Event bus emission should not block
  }

  // Route to specific handlers based on event type
  const reactions: string[] = [];

  if (table === "tasks" && event === "UPDATE") {
    const newStatus = changes?.status as string | undefined;
    if (newStatus === "completed") {
      reactions.push("task_completed");
      // Future: check if all tasks under objective are done → suggest completion
    }
  }

  if (table === "journal_entries" && event === "INSERT") {
    reactions.push("journal_created");
    // Deep journal analysis — async, fire-and-forget
    analyzeJournalDeep(row_id, user_id, changes ?? {}).catch((err) =>
      console.error(
        `[commit-events] Journal analysis failed for ${row_id}:`,
        err,
      ),
    );
  }

  if (table === "goals" && event === "UPDATE") {
    const newStatus = changes?.status as string | undefined;
    if (newStatus === "completed") {
      reactions.push("goal_completed");
      // Future: celebrate via Telegram, suggest archiving linked project
    }
  }

  if (table === "objectives" && event === "UPDATE") {
    const newStatus = changes?.status as string | undefined;
    if (newStatus === "completed") {
      reactions.push("objective_completed");
      // Future: suggest next objective, update project progress
    }
  }

  return c.json({
    status: "received",
    event,
    table,
    row_id,
    reactions,
  });
});
