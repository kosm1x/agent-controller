/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, MCP servers, and starts the Hono HTTP server.
 */

import { createServer } from "net";
import { serve } from "@hono/node-server";
import { createLogger } from "./lib/logger.js";
import { readShutdownGraceMs } from "./lib/shutdown-grace.js";
import { isTriageMonitorEnabled } from "./lib/self-healing/flags.js";
import { isXProbeEnabled } from "./lib/x-poster/config.js";
import { getConfig } from "./config.js";
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  reconcileOrphanedTasks,
} from "./db/index.js";
import { initEventBus } from "./lib/event-bus.js";
import { seedReflectionCursors } from "./reflection/cursors.js";
import { startTriggers } from "./triggers/index.js";
import { createApp } from "./api/index.js";
import {
  startRitualScheduler,
  stopRitualScheduler,
} from "./rituals/scheduler.js";
import {
  startIntelCollectors,
  stopIntelCollectors,
  setIntelBroadcast,
} from "./intel/scheduler.js";
import {
  startDynamicScheduler,
  stopDynamicScheduler,
} from "./rituals/dynamic.js";
import { initMessaging, shutdownMessaging } from "./messaging/index.js";
import { initMemoryService } from "./memory/index.js";
import { migrateLearningsToHindsight } from "./memory/migrate-learnings.js";
import { seedMentalModels } from "./intelligence/mental-models.js";
import {
  startProactiveScheduler,
  stopProactiveScheduler,
} from "./intelligence/proactive.js";

// Reaction engine
import { ReactionManager } from "./reactions/manager.js";

// Tool source plugin system
import { toolRegistry } from "./tools/registry.js";
import { seedV83Capabilities } from "./lib/v8-3/seed.js";
import { assertV82Dependencies } from "./lib/v8-3/schema.js";
import { ToolSourceManager } from "./tools/source.js";
import { BuiltinToolSource } from "./tools/sources/builtin.js";
import { McpToolSource } from "./tools/sources/mcp.js";
import { GoogleToolSource } from "./tools/sources/google.js";
import { MemoryToolSource } from "./tools/sources/memory.js";
import { SkillsToolSource } from "./tools/sources/skills.js";
// Runner registration (side-effect imports)
import "./runners/fast-runner.js";
import "./runners/heavy-runner.js";
import "./runners/nanoclaw-runner.js";
import "./runners/swarm-runner.js";
import "./runners/a2a-runner.js";

/** Fail fast if the port is already in use (prevents silent 409 conflicts). */
async function checkPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE")
        reject(
          new Error(`Port ${port} already in use — kill the old process first`),
        );
      else reject(err);
    });
    s.once("listening", () => {
      s.close();
      resolve();
    });
    s.listen(port);
  });
}

const log = createLogger("mc");

async function main(): Promise<void> {
  const config = getConfig();

  // Initialize database
  const db = initDatabase(config.dbPath);
  log.info({ path: config.dbPath }, "database initialized");

  // V8.3 Phase-0 gate: V8.3 is hard-gated on V8.2's consent substrate (§12).
  // Fail loud at boot if the dependency tables are missing — never silently.
  assertV82Dependencies(db);

  // V8.1 Phase 4: ensure the named reflection cursors exist from boot so the
  // table is observable before the first reflection pass. Idempotent.
  seedReflectionCursors();

  // Dim-4 R3 fix: reconcile orphaned tasks from prior non-graceful shutdown.
  // Graceful SIGTERM/SIGINT already marks running/pending/queued → failed
  // (shutdown handler below). SIGKILL / OOM / hard-reboot skips the handler,
  // leaving tasks stuck forever. reactions/manager catches 'running' tasks
  // after 15 minutes via stuck-task polling, but 'pending'/'queued' rows
  // never had started_at set and slip past that check entirely.
  //
  // Round-2 C-RES-6 fix: reconcile returns the list of orphaned task IDs
  // so we can emit `task.failed` events AFTER initEventBus below, giving
  // the normal reaction-engine + user-notification pipelines a chance to
  // run. Prior round-1 fix silently flipped rows with no downstream signal.
  let orphanedTaskIds: string[] = [];
  try {
    orphanedTaskIds = reconcileOrphanedTasks(db);
    if (orphanedTaskIds.length > 0) {
      log.warn(
        { count: orphanedTaskIds.length },
        "reconciled orphaned tasks from prior non-graceful shutdown",
      );
    }
  } catch (err) {
    log.warn({ err }, "startup task reconcile failed (non-fatal)");
  }

  // v7.7 Spine 3 Phase 1: skills boot-loader. Walks jarvis_files for
  // skills/<name>/SKILL.md, parses frontmatter, registers skill_versions
  // rows. Empty namespace = no-op. JARVIS_SKILLS_BOOT_LOAD_DISABLED=true
  // disables (used by tests that already init the DB without a loader run).
  if (process.env.JARVIS_SKILLS_BOOT_LOAD_DISABLED !== "true") {
    try {
      const { loadSkillsFromJarvisFiles } = await import("./skills/loader.js");
      loadSkillsFromJarvisFiles({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
        error: (msg, fields) => log.error(fields ?? {}, msg),
      });
    } catch (err) {
      log.warn({ err }, "skills boot-loader failed (non-fatal)");
    }
  }

  // Initialize event bus
  initEventBus(db);
  log.info("event bus initialized");

  // Round-2 C-RES-6 fix: fire `task.failed` events for the rows reconcile
  // just flipped. Must happen after initEventBus above but before reaction
  // manager starts (line ~172) — the reaction manager subscribes on start()
  // and immediately drains any unread events, so ordering matters.
  if (orphanedTaskIds.length > 0) {
    const { getEventBus } = await import("./lib/event-bus.js");
    const bus = getEventBus();
    for (const taskId of orphanedTaskIds) {
      try {
        bus.emitEvent("task.failed", {
          task_id: taskId,
          agent_id: "startup-reconcile",
          error: "Orphaned across non-graceful restart",
          recoverable: true,
          attempts: 1,
        });
      } catch (err) {
        log.warn(
          { err, taskId },
          "failed to emit orphaned-task event (non-fatal)",
        );
      }
    }
  }

  // Migrate user_facts (category=projects) into projects table if needed
  try {
    const { migrateUserFactsToProjects } = await import("./db/projects.js");
    migrateUserFactsToProjects();
  } catch {
    // Non-fatal — migration is best-effort
  }

  // Initialize memory service (Hindsight if configured, else SQLite)
  const memory = await initMemoryService();

  // Migrate existing learnings and seed mental models if Hindsight is active
  if (memory.backend === "hindsight") {
    await migrateLearningsToHindsight(db);
    await seedMentalModels(
      process.env.HINDSIGHT_URL ?? "http://localhost:8888",
      process.env.HINDSIGHT_API_KEY,
    );
  }

  // Build code index for code_search tool (S7 semantic code search)
  try {
    const { rebuildIndex } = await import("./tools/builtin/code-index.js");
    rebuildIndex();
  } catch (err) {
    console.warn("[code-index] Build failed (non-fatal)");
  }

  // F1 — seed rate limiter from api_call_budget so post-restart calls don't
  // exceed provider ceilings for up to 60s before the window rebuilds.
  try {
    const { seedRateLimitersFromHistory } = await import("./finance/budget.js");
    seedRateLimitersFromHistory();
  } catch {
    // Non-fatal — table may not exist on fresh installs
  }

  // Initialize tool sources (plugin system)
  const sourceManager = new ToolSourceManager();
  sourceManager.addSource(new BuiltinToolSource());
  // Instance kept for alert wiring after messaging is up — this source owns
  // the LIVE McpManager (the src/mcp/index.ts barrel's was never initialized).
  const mcpSource = new McpToolSource();
  sourceManager.addSource(mcpSource);
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
    sourceManager.addSource(new GoogleToolSource());
  }
  if (memory.backend === "hindsight") {
    sourceManager.addSource(new MemoryToolSource());
  }
  sourceManager.addSource(new SkillsToolSource());

  const initResult = await sourceManager.initAll(toolRegistry);
  log.info(
    {
      initialized: initResult.initialized,
      failed: initResult.failed,
      totalTools: initResult.totalTools,
    },
    "tool sources loaded",
  );
  log.debug({ tools: toolRegistry.list() }, "tools registered");

  // V8.3 Phase 0+1 — seed the (inert) capability-autonomy ledger now that the
  // tool registry is populated (tool-backed capabilities resolve + hint-check
  // against the live registry). Idempotent; failures log loudly, never crash boot.
  const v83Seed = seedV83Capabilities(db, toolRegistry);
  if (v83Seed.errors.length > 0) {
    log.error(
      { errors: v83Seed.errors },
      "V8.3 capability seed reported errors",
    );
  } else {
    log.info(
      { seeded: v83Seed.seeded, skipped: v83Seed.skipped },
      "V8.3 capability-autonomy seed complete",
    );
  }

  // Start reaction engine
  const reactionManager = new ReactionManager(db);
  reactionManager.start();

  // Check port availability before binding
  await checkPort(config.port);

  // Create and start HTTP server
  const app = createApp();

  const httpServer = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: process.env.MC_BIND_HOST ?? "0.0.0.0",
    },
    (info) => {
      log.info({ port: info.port }, "Mission Control listening");
      log.info(
        {
          timeoutMs: config.inferenceTimeoutMs,
          maxRetries: config.inferenceMaxRetries,
        },
        "inference config",
      );
    },
  );

  // Start ritual scheduler if enabled
  if (process.env.RITUALS_ENABLED === "true") {
    startRitualScheduler();
    // V8.1 Phase 7 — proactive-context triggers (N-turn / cron / idle).
    // Fire the reflection + briefing pipeline; produces only non-operator-
    // facing artifacts. Kill switch: V81_TRIGGERS_ENABLED=false.
    startTriggers();
  }

  // Start dynamic (user-defined) scheduled tasks
  startDynamicScheduler();

  // v6.2 M1: Register weekly KB confidence decay sweep
  import("./memory/lesson-decay.js")
    .then(({ registerDecayCron }) => registerDecayCron())
    .catch((err) => {
      console.warn(
        "[lesson-decay] Registration failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });

  // v7.7 Spine 2 (S3 substrate): register drift-detector cron jobs.
  // Seeds 13 signals on first boot (idempotent on subsequent boots).
  // Registration failure is non-fatal — service runs without drift watching.
  import("./lib/s3/scheduler.js")
    .then(({ registerS3CronJobs }) => registerS3CronJobs())
    .catch((err) => {
      console.warn(
        "[s3] Cron registration failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    });

  // v7.7 Spine 3 Phase 2 Bundle 2: register skill test sweep cron.
  // Every 6h re-runs tests against is_certified=1 active skills;
  // decertifies on any failure. Non-fatal if registration fails.
  if (process.env.JARVIS_SKILLS_TEST_SWEEP_DISABLED !== "true") {
    import("./skills/test-sweep.js")
      .then(({ registerSkillsTestSweepCron }) =>
        registerSkillsTestSweepCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[skills] Test sweep cron registration failed (non-fatal)",
        );
      });
  }

  // v7.7 Spine 5 Bundle 2: register the Conway Pattern 2 cohort roll-up
  // cron. Daily at 05:00 MX re-derives the self-defining cohort (projects +
  // objectives) ahead of the morning brief. Non-fatal if registration fails.
  if (process.env.JARVIS_COHORT_ROLLUP_DISABLED !== "true") {
    import("./cohort/rollup-cron.js")
      .then(({ registerCohortRollupCron }) =>
        registerCohortRollupCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[cohort] Roll-up cron registration failed (non-fatal)",
        );
      });
  }

  // Hourly prune for both checkpoint stores. Closes the lazy-only-TTL gap
  // (Hermes v0.13 "Checkpoints v2 real pruning"). Non-fatal if registration
  // fails — the lazy paths still enforce TTL on every load.
  import("./runners/checkpoint-prune-cron.js")
    .then(({ registerCheckpointPruneCron }) =>
      registerCheckpointPruneCron({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "[checkpoint] prune cron registration failed (non-fatal)",
      );
    });

  // Daily tasks/runs retention (04:30 local, 90d window — operator-approved
  // 2026-07-05). Archives to data/archive/*.jsonl.gz then deletes in batched
  // transactions; in-flight tasks and parents with surviving children are
  // never touched (see db/retention.ts). Non-fatal if registration fails.
  import("./db/retention-cron.js")
    .then(({ registerRetentionCron }) =>
      registerRetentionCron({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
      }),
    )
    .catch((err) => {
      log.warn({ err }, "[retention] cron registration failed (non-fatal)");
    });

  // V8.2 §14 nightly sycophancy probe (02:30 MX). Registered only when the
  // judgment-assembly producer is armed (V82_JUDGMENT_PRODUCER_ENABLED=true);
  // dormant even then until judgments exist (zero LLM calls on an empty window).
  // Non-fatal if registration fails.
  if (process.env.V82_JUDGMENT_PRODUCER_ENABLED === "true") {
    import("./lib/v8-2/probe-cron.js")
      .then(({ registerSycophancyProbeCron }) =>
        registerSycophancyProbeCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[v8.2] sycophancy probe cron registration failed (non-fatal)",
        );
      });
  }

  // Proactive X (Twitter) auth probe (daily MX). Read-only: probes the posting
  // backends' auth, records mc_x_backend_healthy, and notifies the operator on a
  // healthy→unhealthy transition (cookies expiring) BEFORE a post 401s. Registered
  // only when X_PROBE_ENABLED=true, so it ships dormant. Non-fatal if it fails.
  if (isXProbeEnabled()) {
    import("./lib/x-poster/probe-cron.js")
      .then(({ registerXProbeCron }) =>
        registerXProbeCron({
          info: (msg) => log.info(msg),
          warn: (msg) => log.warn(msg),
        }),
      )
      .catch((err) => {
        log.warn({ err }, "[x-probe] cron registration failed (non-fatal)");
      });
  }

  // Self-healing triage monitor (every 6h MX). Read-only: detects health
  // anomalies, has a sub-agent root-cause them, persists a triage report —
  // NEVER remediates. Registered only when SELF_HEALING_TRIAGE_ENABLED=true, so
  // it ships dormant. Non-fatal if registration fails.
  if (isTriageMonitorEnabled()) {
    import("./lib/self-healing/triage-cron.js")
      .then(({ registerTriageCron }) =>
        registerTriageCron({
          info: (msg, fields) => log.info(fields ?? {}, msg),
          warn: (msg, fields) => log.warn(fields ?? {}, msg),
        }),
      )
      .catch((err) => {
        log.warn(
          { err },
          "[self-healing] triage cron registration failed (non-fatal)",
        );
      });
  }

  // Start Intelligence Depot collectors (S6)
  startIntelCollectors();

  // Start messaging channels (WhatsApp/Telegram) if enabled
  const router = await initMessaging();

  // Wire MCP alerts + intel alerts to Telegram (after messaging is ready)
  if (router) {
    mcpSource.setAlertFn((msg: string) => router.broadcastToAll(msg));
    setIntelBroadcast((msg: string) => router.broadcastToAll(msg));
    startProactiveScheduler(router);
  }

  // Graceful shutdown — ordered teardown to prevent requests hitting torn-down state
  let shuttingDown = false;
  const shutdown = async () => {
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
    reactionManager.stop();
    stopIntelCollectors();
    stopDynamicScheduler();
    stopProactiveScheduler();
    stopRitualScheduler();

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

    // 4. Flush messaging channels
    await shutdownMessaging();

    // 5. Teardown MCP + tool sources
    await sourceManager.teardownAll();

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
      // Non-fatal — DB may already be closed
    }

    // 7. Cancel pending INDEX.md regeneration + WAL checkpoint + close database
    import("./db/jarvis-index.js")
      .then((m) => m.cancelPendingRegeneration())
      .catch(() => {});
    closeDatabase();

    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Global error handlers — prevent silent crashes
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception — shutting down");
    closeDatabase();
    process.exit(1);
  });
}

main().catch((err) => {
  log.fatal({ err }, "fatal error");
  process.exit(1);
});
