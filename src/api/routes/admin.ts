/**
 * Admin routes — SG2 safeguard.
 *
 * Kill switch for autonomous improvement + status check.
 * Mounted at /api/admin/* (inherits X-Api-Key auth).
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { cancelTask } from "../../dispatch/dispatcher.js";

export const admin = new Hono();

/**
 * POST /api/admin/kill-autonomous
 *
 * Disables autonomous improvement at runtime and cancels any running
 * improvement tasks. Optional secondary passphrase via X-Kill-Passphrase.
 */
admin.post("/kill-autonomous", (c) => {
  // Optional secondary passphrase
  const expectedPassphrase = process.env.KILL_PASSPHRASE;
  if (expectedPassphrase) {
    const passphrase = c.req.header("X-Kill-Passphrase");
    if (passphrase !== expectedPassphrase) {
      return c.json({ error: "Invalid kill passphrase" }, 403);
    }
  }

  // 1. Disable at runtime
  process.env.AUTONOMOUS_IMPROVEMENT_ENABLED = "false";

  // 2. Cancel running improvement tasks
  const cancelled: string[] = [];
  try {
    const db = getDatabase();
    const running = db
      .prepare(
        `SELECT task_id FROM tasks
         WHERE title LIKE '%Auto-improvement%'
           AND status IN ('running', 'pending', 'queued')`,
      )
      .all() as { task_id: string }[];

    for (const row of running) {
      if (cancelTask(row.task_id)) cancelled.push(row.task_id);
    }
  } catch (err) {
    console.error("[admin] kill-autonomous DB error:", err);
  }

  console.log(
    `[admin] kill-autonomous: disabled + cancelled ${cancelled.length} tasks`,
  );

  return c.json({
    status: "disabled",
    autonomous_improvement_enabled: false,
    cancelled_tasks: cancelled,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/admin/autonomous-status
 *
 * Returns current state of autonomous improvement.
 */
admin.get("/autonomous-status", (c) => {
  return c.json({
    autonomous_improvement_enabled:
      process.env.AUTONOMOUS_IMPROVEMENT_ENABLED === "true",
    timestamp: new Date().toISOString(),
  });
});
