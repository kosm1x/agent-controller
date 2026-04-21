/**
 * Self-monitoring canary (v6.4 H3).
 *
 * Lightweight health check that runs every 4 hours.
 * Queries Jarvis's own performance metrics and alerts via Telegram
 * when any metric crosses a threshold — BEFORE the user notices.
 *
 * Checks:
 * 1. Task success rate (last 24h) — threshold: <70%
 * 2. Delivery miss count (last 24h) — threshold: >2
 */

import cron, { type ScheduledTask } from "node-cron";
import { getDatabase } from "../db/index.js";
import { getRouter } from "../messaging/index.js";

const TIMEZONE = process.env.RITUALS_TIMEZONE ?? "America/Mexico_City";

/**
 * Ritual titles whose task submission includes gmail_send. A task with one of
 * these prefixes is expected to email the user. Keep in sync with the `title`
 * field in the corresponding ritual file — a silent rename there will cause
 * the canary to stop observing that ritual without any test failure.
 */
export const RITUAL_EMAIL_TITLE_PREFIXES = [
  "Morning briefing",
  "Nightly close",
  "Signal intelligence",
  "Weekly review",
  "Market morning scan",
] as const;

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

  // 2. Scheduled/ritual email deliveries that DIDN'T call gmail_send.
  //
  // Earlier version filtered on `metadata LIKE '%gmail_send%'` — which matched
  // every chat task, because the default chat tool allowlist always includes
  // gmail_send. Users asking "Lista mi NorthStar" would complete_with_concerns
  // and get counted as "missed email deliveries" even though no email was ever
  // requested. At alert threshold of 2, the canary fired daily on user chatter.
  //
  // The real signal is: was this a task that was *designed* to email? Two
  // shapes: (1) dynamic scheduled tasks (metadata tags contain "scheduled"),
  // (2) rituals whose titles follow known prefixes. Filtering on those cleanly
  // excludes chat traffic.
  //
  // Status: `completed_with_concerns` OR `failed`. The `failed` case is the
  // one the canary MOST wants to catch — rituals that require gmail_send in
  // `requiredTools` get downgraded to `failed` when the dispatcher's retry
  // also misses the tool. Plain `completed` is excluded deliberately: rituals
  // where gmail_send is optional (e.g. market-morning-scan's "also send email
  // copy") may land `completed` without emailing by design, and counting them
  // would reintroduce noise.
  let deliveryMisses = 0;
  try {
    // Build `(title LIKE ? OR title LIKE ?)` groups for each prefix — two
    // patterns per prefix to match both `Prefix — 2026-04-21` (the dateful
    // form all rituals use) and a bare `Prefix` fallback. Parameter-bound to
    // keep the SQL injection-proof even if the constant grows to include
    // user-contributed prefixes someday.
    const titleClauses = RITUAL_EMAIL_TITLE_PREFIXES.map(
      () => "(title LIKE ? OR title LIKE ?)",
    ).join(" OR ");
    const titleParams: string[] = [];
    for (const prefix of RITUAL_EMAIL_TITLE_PREFIXES) {
      titleParams.push(`${prefix} —%`, prefix);
    }
    const emailTasks = db
      .prepare(
        `SELECT output FROM tasks
         WHERE created_at > ?
         AND status IN ('completed_with_concerns', 'failed')
         AND (
           (metadata LIKE '%"scheduled"%' AND metadata LIKE '%gmail_send%')
           OR ${titleClauses}
         )`,
      )
      .all(cutoff, ...titleParams) as Array<{ output: string | null }>;

    for (const t of emailTasks) {
      if (!t.output) continue;
      try {
        const parsed = JSON.parse(t.output) as { toolCalls?: unknown };
        // swarm-runner writes `toolCalls: <count>` as a number; only fast /
        // heavy / nanoclaw write it as an array. Rituals route to fast so
        // this is latent today, but don't throw if the shape changes.
        const toolCalls = Array.isArray(parsed.toolCalls)
          ? (parsed.toolCalls as string[])
          : [];
        if (!toolCalls.includes("gmail_send")) {
          deliveryMisses++;
        }
      } catch {
        /* ignore parse errors */
      }
    }

    if (deliveryMisses > 2) {
      alerts.push(
        `${deliveryMisses} scheduled/ritual email deliveries did not call gmail_send in last 24h — above threshold of 2`,
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
