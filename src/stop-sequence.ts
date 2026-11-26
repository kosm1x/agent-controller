/**
 * The service's stop sequence: the ordered steps that run when the process
 * gets SIGTERM or SIGINT. main() in the entry point builds it once, after the
 * HTTP server, the reaction manager and the tool sources exist, and registers
 * the built function for both signals. A second call while one is running
 * logs a warning and returns; the last step exits the process.
 */
import type { ServerType } from "@hono/node-server";
import type { createLogger } from "./lib/logger.js";
import { readShutdownGraceMs } from "./lib/shutdown-grace.js";
import { withTimeout } from "./lib/with-timeout.js";
import { getDatabase, closeDatabase } from "./db/index.js";
import { cancelPendingRegeneration } from "./db/jarvis-index.js";
import { stopTriggers } from "./triggers/index.js";
import { stopRitualScheduler } from "./rituals/scheduler.js";
import { stopIntelCollectors } from "./intel/scheduler.js";
import { stopDynamicScheduler } from "./rituals/dynamic.js";
import { shutdownMessaging } from "./messaging/index.js";
import { stopProactiveScheduler } from "./intelligence/proactive.js";
import type { ReactionManager } from "./reactions/manager.js";
import type { ToolSourceManager } from "./tools/source.js";

/** What main() passes to the stop sequence. */
export interface StopSequenceDeps {
  readonly log: ReturnType<typeof createLogger>;
  readonly httpServer: ServerType;
  readonly reactionManager: ReactionManager;
  readonly sourceManager: ToolSourceManager;
}

/** Builds the stop function that main() registers for SIGTERM and SIGINT. */
export function buildStopSequence({
  log,
  httpServer,
  reactionManager,
  sourceManager,
}: StopSequenceDeps): () => Promise<void> {
  /** Run one stop step. A throw is logged with the step's name and swallowed so
   *  the later steps (drain, task marking, checkpoint, exit) still run.
   *  For synchronous stop functions only: a returned promise's rejection is not caught here. */
  function safeStop(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warn({ err, step: name }, "stop step failed (non-fatal)");
    }
  }

  let shuttingDown = false;
  return async () => {
    // Re-entry guard: a second SIGTERM/SIGINT during the grace drain would run
    // the whole teardown concurrently (double stopAll, closeDatabase under the
    // first run's feet → SQLITE_MISUSE).
    if (shuttingDown) {
      log.warn("shutdown already in progress — ignoring repeated signal");
      return;
    }
    shuttingDown = true;
    log.info("shutting down...");

    // 1. Stop accepting new requests
    httpServer.close();

    // 2. Stop schedulers + collectors
    safeStop("reactionManager", () => reactionManager.stop());
    safeStop("intelCollectors", () => stopIntelCollectors());
    safeStop("dynamicScheduler", () => stopDynamicScheduler());
    safeStop("proactiveScheduler", () => stopProactiveScheduler());
    safeStop("ritualScheduler", () => stopRitualScheduler());
    safeStop("triggers", () => stopTriggers());

    // v7.7 Spine 2: stop S3 cron jobs so an in-flight tick doesn't hit a
    // closed DB during shutdown. Dynamic import keeps boot independent.
    try {
      const { stopS3CronJobs } = await import("./lib/s3/scheduler.js");
      stopS3CronJobs();
    } catch (err) {
      log.warn({ err }, "stopS3CronJobs failed (non-fatal)");
    }

    // 3. Grace period — wait up to MC_SHUTDOWN_GRACE_MS (default 30s) for
    // in-flight tasks to complete. Tripled from the original 10s after the
    // 2026-05-25 morning briefing surfaced the recurring `Service shutdown`
    // blocker (6 chat tasks killed across 8 days); fast-runner chats often
    // need 15-25s, so 10s cut too aggressively.
    // Ordering matters: drain BEFORE tearing down messaging + tool sources —
    // a task that survives the grace window still needs its MCP tools to
    // finish and its messaging channel to deliver the result. The previous
    // teardown-first order made the grace period defeat its own purpose.
    try {
      const db = getDatabase();
      const running = db
        .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'`)
        .get() as { cnt: number } | undefined;
      const inFlight = running?.cnt ?? 0;
      if (inFlight > 0) {
        const graceMs = readShutdownGraceMs();
        log.info(
          { inFlight, graceMs },
          "waiting for in-flight task(s) to complete before shutdown",
        );
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          const still = db
            .prepare(
              `SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'`,
            )
            .get() as { cnt: number } | undefined;
          if ((still?.cnt ?? 0) === 0) break;
          // W3 audit fold: shutdown handler is already async, use a proper
          // promise sleep instead of the Atomics.wait+SharedArrayBuffer idiom.
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const final = db
          .prepare(`SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'`)
          .get() as { cnt: number } | undefined;
        const completed = inFlight - (final?.cnt ?? 0);
        log.info(
          { drained: completed, stillRunning: final?.cnt ?? 0, graceMs },
          "shutdown grace period elapsed",
        );
      }
    } catch {
      // Non-fatal
    }

    // 4. Flush messaging channels. Bounded: systemd SIGKILLs at
    // TimeoutStopSec (90 s) and the drain above may already have used 30 s;
    // a hung channel must not starve steps 6-7 (task marking + WAL checkpoint).
    try {
      await withTimeout(shutdownMessaging(), 15_000, "shutdownMessaging");
    } catch (err) {
      log.warn({ err }, "messaging shutdown did not finish in time");
    }

    // 5. Teardown MCP + tool sources (bounded, same reason)
    try {
      await withTimeout(sourceManager.teardownAll(), 15_000, "teardownAll");
    } catch (err) {
      log.warn({ err }, "tool-source teardown did not finish in time");
    }

    // 6. Mark remaining running tasks as failed
    try {
      const db = getDatabase();
      const orphaned = db
        .prepare(
          `UPDATE tasks SET status='failed', error='Service shutdown', completed_at=datetime('now') WHERE status IN ('running','pending','queued')`,
        )
        .run();
      if (orphaned.changes > 0) {
        log.info(`marked ${orphaned.changes} orphaned task(s) as failed`);
      }
      // Cascade to their run rows so they don't linger at 'running' until the
      // next boot sweep. At shutdown every live run is dying with the process,
      // so a blanket sweep is correct (mirrors the task update above).
      db.prepare(
        `UPDATE runs SET status='failed', error='Service shutdown', completed_at=datetime('now') WHERE status='running'`,
      ).run();
    } catch {
      // The database closes only in step 7, so this is a failed UPDATE (e.g. busy):
      // swallowed; reconcileOrphanedTasks fails those tasks at the next boot.
    }

    // 7. Cancel pending INDEX.md regeneration + WAL checkpoint + close database
    safeStop("indexRegeneration", () => cancelPendingRegeneration());
    closeDatabase();

    process.exit(0);
  };
}
