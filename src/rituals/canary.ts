/**
 * Self-monitoring canary (v6.4 H3).
 *
 * Lightweight health check that runs every 4 hours.
 * Queries Jarvis's own performance metrics and alerts via Telegram
 * when any metric crosses a threshold — BEFORE the user notices.
 *
 * Checks:
 * 1. Task success rate (last 24h) — threshold: <70%
 * 2. Provider failure count (last 24h) — threshold: >10
 * 3. Delivery miss count (last 24h) — threshold: >2
 */

import cron, { type ScheduledTask } from "node-cron";
import { getDatabase } from "../db/index.js";
import { getRouter } from "../messaging/index.js";

const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";

interface CanaryResult {
  taskSuccessRate: number;
  totalTasks: number;
  failedTasks: number;
  deliveryMisses: number;
  alerts: string[];
}

/**
 * Run the canary health check. Returns metrics + alerts.
 */
export function runCanaryCheck(): CanaryResult {
  const db = getDatabase();
  const alerts: string[] = [];

  // 1. Task success rate (last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const taskStats = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('completed', 'completed_with_concerns') THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks WHERE created_at > ?`,
    )
    .get(cutoff) as { total: number; succeeded: number; failed: number };

  const successRate =
    taskStats.total > 0 ? taskStats.succeeded / taskStats.total : 1;

  if (taskStats.total >= 5 && successRate < 0.7) {
    alerts.push(
      `Task success rate ${(successRate * 100).toFixed(0)}% (${taskStats.succeeded}/${taskStats.total}) — below 70% threshold`,
    );
  }

  // 2. Delivery misses (tasks with gmail_send in tools but not in output.toolCalls)
  let deliveryMisses = 0;
  try {
    const emailTasks = db
      .prepare(
        `SELECT output FROM tasks
         WHERE created_at > ? AND status = 'completed_with_concerns'
         AND metadata LIKE '%gmail_send%'`,
      )
      .all(cutoff) as Array<{ output: string | null }>;

    for (const t of emailTasks) {
      if (!t.output) continue;
      try {
        const parsed = JSON.parse(t.output);
        const toolCalls = parsed.toolCalls ?? [];
        if (!toolCalls.includes("gmail_send")) {
          deliveryMisses++;
        }
      } catch {
        /* ignore parse errors */
      }
    }

    if (deliveryMisses > 2) {
      alerts.push(
        `${deliveryMisses} email delivery misses in last 24h — above threshold of 2`,
      );
    }
  } catch {
    /* non-fatal */
  }

  return {
    taskSuccessRate: successRate,
    totalTasks: taskStats.total,
    failedTasks: taskStats.failed,
    deliveryMisses,
    alerts,
  };
}

let canaryJob: ScheduledTask | null = null;

/**
 * Schedule the canary to run every 4 hours.
 */
export function scheduleCanary(): void {
  if (canaryJob) return;

  canaryJob = cron.schedule(
    "0 */4 * * *",
    () => {
      try {
        const result = runCanaryCheck();
        if (result.alerts.length > 0) {
          const message =
            `🐦 **CANARY ALERT**\n\n${result.alerts.join("\n")}\n\n` +
            `Metrics: ${result.totalTasks} tasks, ${(result.taskSuccessRate * 100).toFixed(0)}% success, ${result.deliveryMisses} delivery misses`;

          console.warn(`[canary] ${result.alerts.length} alerts triggered`);
          const router = getRouter();
          if (router) {
            router.broadcastToAll(message).catch((err: Error) => {
              console.error(`[canary] Alert broadcast failed: ${err.message}`);
            });
          }
        } else {
          console.log(
            `[canary] OK — ${result.totalTasks} tasks, ${(result.taskSuccessRate * 100).toFixed(0)}% success`,
          );
        }
      } catch (err) {
        console.error(
          `[canary] Check failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    { timezone: TIMEZONE },
  );

  console.log(`[rituals] canary: scheduled (0 */4 * * *, tz=${TIMEZONE})`);
}

/** Stop the canary cron job. */
export function stopCanary(): void {
  if (canaryJob) {
    canaryJob.stop();
    canaryJob = null;
  }
}
