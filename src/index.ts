/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, MCP servers, and starts the Hono HTTP server.
 */

import { createServer } from "net";
import { serve } from "@hono/node-server";
import { createLogger } from "./lib/logger.js";
import { getConfig } from "./config.js";
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  reconcileOrphanedTasks,
} from "./db/index.js";
import { initEventBus } from "./lib/event-bus.js";
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
import { setMcpAlertFn } from "./mcp/index.js";
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
  sourceManager.addSource(new McpToolSource());
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

  // Start Intelligence Depot collectors (S6)
  startIntelCollectors();

  // Start messaging channels (WhatsApp/Telegram) if enabled
  const router = await initMessaging();

  // Wire MCP alerts + intel alerts to Telegram (after messaging is ready)
  if (router) {
    setMcpAlertFn((msg: string) => router.broadcastToAll(msg));
    setIntelBroadcast((msg: string) => router.broadcastToAll(msg));
    startProactiveScheduler(router);
  }

  // Graceful shutdown — ordered teardown to prevent requests hitting torn-down state
  const shutdown = async () => {
    log.info("shutting down...");

    // 1. Stop accepting new requests
    httpServer.close();

    // 2. Stop schedulers + collectors
    reactionManager.stop();
    stopIntelCollectors();
    stopDynamicScheduler();
    stopProactiveScheduler();
    stopRitualScheduler();

    // 3. Flush messaging channels
    await shutdownMessaging();

    // 4. Teardown MCP + tool sources
    await sourceManager.teardownAll();

    // 5. Grace period — wait up to 10s for in-flight tasks to complete
    try {
      const db = getDatabase();
      const running = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('running')`,
        )
        .get() as { cnt: number } | undefined;
      const inFlight = running?.cnt ?? 0;
      if (inFlight > 0) {
        log.info(
          `waiting up to 10s for ${inFlight} in-flight task(s) to complete...`,
        );
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const still = db
            .prepare(
              `SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'`,
            )
            .get() as { cnt: number } | undefined;
          if ((still?.cnt ?? 0) === 0) break;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
      }
    } catch {
      // Non-fatal
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
