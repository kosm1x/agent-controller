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
import { suppressAlert } from "../../lib/s3/suppression.js";

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

/**
 * POST /api/admin/alerts/:id/suppress
 *
 * v7.7 Spine 2 Bundle 3 — suppress an active drift alert.
 *
 * Body: { reason: string, until?: ISO datetime, acknowledged_by?: string }
 *
 * Behavior per spec §8:
 *   - reason starts with "false positive: " → resolution_kind='false_positive'
 *   - otherwise → resolution_kind='operator_acknowledged'
 *   - sets delivery_status='suppressed' + resolution_at=NOW
 *   - resolution_notes preserves the full reason + until-timestamp for audit
 *
 * Auto-unsuppress when `until` passes is DEFERRED (v8.0).
 */
admin.post("/alerts/:id/suppress", async (c) => {
  const idStr = c.req.param("id");
  const alertId = Number(idStr);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return c.json({ error: "alert id must be a positive integer" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const params = body as {
    reason?: unknown;
    until?: unknown;
    acknowledged_by?: unknown;
  };

  if (typeof params.reason !== "string" || params.reason.trim().length === 0) {
    return c.json({ error: "reason is required (non-empty string)" }, 400);
  }
  // S3-B3-I1 — hardening-in-depth caps. Primary defense is the X-Api-Key gate
  // upstream; this prevents an authenticated-but-misbehaving client from
  // landing a 10 MB body in resolution_notes. Bound aligns with what a sane
  // operator note actually requires.
  const MAX_REASON_LEN = 1024;
  const MAX_ACK_BY_LEN = 256;
  if (params.reason.length > MAX_REASON_LEN) {
    return c.json(
      { error: `reason exceeds max length (${MAX_REASON_LEN} chars)` },
      400,
    );
  }
  if (
    typeof params.acknowledged_by === "string" &&
    params.acknowledged_by.length > MAX_ACK_BY_LEN
  ) {
    return c.json(
      {
        error: `acknowledged_by exceeds max length (${MAX_ACK_BY_LEN} chars)`,
      },
      400,
    );
  }
  const until =
    typeof params.until === "string" && params.until.length > 0
      ? params.until
      : undefined;
  const acknowledgedBy =
    typeof params.acknowledged_by === "string" &&
    params.acknowledged_by.length > 0
      ? params.acknowledged_by
      : "operator";

  const result = suppressAlert(alertId, params.reason, until, acknowledgedBy);
  if (!result.ok) {
    if (result.kind === "not_found") {
      return c.json({ error: `alert ${alertId} not found` }, 404);
    }
    if (result.kind === "already_resolved") {
      return c.json(
        {
          error: `alert ${alertId} already resolved at ${result.resolvedAt}`,
        },
        409,
      );
    }
    // invalid_reason
    return c.json({ error: result.detail }, 400);
  }
  return c.json({
    ok: true,
    alert_id: result.alertId,
    resolution_kind: result.resolutionKind,
    resolved_at: result.resolvedAt,
  });
});
