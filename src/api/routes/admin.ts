/**
 * Admin routes — SG2 safeguard.
 *
 * Kill switch for autonomous improvement + status check.
 * Mounted at /api/admin/* (inherits X-Api-Key auth).
 */

import { Hono } from "hono";
import { getDatabase } from "../../db/index.js";
import { cancelTask } from "../../dispatch/dispatcher.js";
import { checkDrift, summarizeDrift } from "../../observability/drift.js";
import { compareBackends } from "../../memory/recall-compare.js";
import type { MemoryBank } from "../../memory/types.js";

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

/**
 * POST /api/admin/drive-backfill
 *
 * One-time backfill: uploads all jarvis_files to Google Drive.
 * Requires DRIVE_KB_FOLDER_ID env var.
 */
admin.post("/drive-backfill", async (c) => {
  const { backfillToDrive } = await import("../../db/drive-sync.js");
  const result = await backfillToDrive();
  return c.json(result);
});

/**
 * POST /api/admin/drive-reformat
 *
 * Updates all existing Drive files with Obsidian-native formatting
 * (YAML frontmatter + wikilinks). Use after format changes.
 */
admin.post("/drive-reformat", async (c) => {
  const { reformatDriveFiles } = await import("../../db/drive-sync.js");
  const result = await reformatDriveFiles();
  return c.json(result);
});

/**
 * GET /api/admin/drift
 *
 * V8 substrate S3 — out-of-band drift detector. Returns the running
 * process env's deviation from declared invariants. Used by `mc-ctl drift`.
 */
admin.get("/drift", (c) => {
  const drifts = checkDrift();
  const summary = summarizeDrift(drifts);
  return c.json({
    summary,
    drifts,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/admin/recall-compare
 *
 * Ship C (2026-04-30). Side-by-side replay of a query against Hindsight
 * and SQLite for manual quality eval. Used by `mc-ctl recall-compare`
 * to inform the 2026-05-13 strategic decision.
 *
 * Body: { query: string, bank: 'mc-jarvis' | 'mc-operational',
 *         topN?: number, timeoutMs?: number }
 *
 * Backends fail independently — a Hindsight timeout returns
 * {error: 'timeout...'} on that side without affecting SQLite.
 */
admin.post("/recall-compare", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const params = body as {
    query?: unknown;
    bank?: unknown;
    topN?: unknown;
    timeoutMs?: unknown;
  };
  if (typeof params.query !== "string" || params.query.length === 0) {
    return c.json({ error: "query is required" }, 400);
  }
  if (params.bank !== "mc-jarvis" && params.bank !== "mc-operational") {
    return c.json(
      { error: "bank must be 'mc-jarvis' or 'mc-operational'" },
      400,
    );
  }
  const topN =
    typeof params.topN === "number" && params.topN > 0 && params.topN <= 10
      ? params.topN
      : 3;
  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    params.timeoutMs >= 1000 &&
    params.timeoutMs <= 30_000
      ? params.timeoutMs
      : 8_000;
  const result = await compareBackends(
    params.query,
    params.bank as MemoryBank,
    {
      topN,
      timeoutMs,
    },
  );
  return c.json(result);
});
