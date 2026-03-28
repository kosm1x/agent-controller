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
import { eventMetrics } from "../../observability/event-metrics.js";
import { analyzeJournalDeep } from "../../commit-ai/journal-analysis.js";
import {
  onTaskCompleted,
  onRecurringTaskCompleted,
  onTaskCreated,
  onGoalCompleted,
  onObjectiveCompleted,
} from "../../commit-ai/event-reactions.js";

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
  const eventStart = Date.now();
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no such table")) {
      console.error("[commit-events] Failed to store event:", msg);
    }
  }

  // Emit to internal event bus for reactive processing
  try {
    const bus = getEventBus();
    const eventName = `commit.${table}.${event.toLowerCase()}`;
    bus.emit(eventName, {
      source: "commit-webhook",
      table,
      row_id,
      event: event.toLowerCase(),
      changes,
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
      // Check if all tasks under objective are done → suggest completion
      onTaskCompleted(row_id, changes ?? {}).catch((err) =>
        console.error(
          `[commit-events] Task completion reaction failed for ${row_id}:`,
          err,
        ),
      );
      // Celebrate streak milestones for recurring tasks
      onRecurringTaskCompleted(changes ?? {}).catch((err) =>
        console.error(
          `[commit-events] Recurring task reaction failed for ${row_id}:`,
          err,
        ),
      );
    }
  }

  if (table === "tasks" && event === "INSERT") {
    reactions.push("task_created");
    // Verify alignment: flag orphan tasks that aren't linked to any objective
    onTaskCreated(row_id, changes ?? {}).catch((err) =>
      console.error(
        `[commit-events] Task alignment check failed for ${row_id}:`,
        err,
      ),
    );
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
      // Celebrate via Telegram + suggest archiving linked project
      onGoalCompleted(row_id, changes ?? {}).catch((err) =>
        console.error(
          `[commit-events] Goal completion reaction failed for ${row_id}:`,
          err,
        ),
      );
    }
  }

  if (table === "objectives" && event === "UPDATE") {
    const newStatus = changes?.status as string | undefined;
    if (newStatus === "completed") {
      reactions.push("objective_completed");
      // Suggest next objective or goal promotion
      onObjectiveCompleted(row_id, changes ?? {}).catch((err) =>
        console.error(
          `[commit-events] Objective completion reaction failed for ${row_id}:`,
          err,
        ),
      );
    }
  }

  // Record event processing metrics
  eventMetrics.record(table, Date.now() - eventStart);

  return c.json({
    status: "received",
    event,
    table,
    row_id,
    reactions,
  });
});
