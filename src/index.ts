/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, MCP servers, and starts the Hono HTTP server.
 */

import { createServer } from "net";
import { serve } from "@hono/node-server";
import { createLogger } from "./lib/logger.js";
import { getConfig } from "./config.js";
import { initDatabase } from "./db/index.js";
import { initEventBus } from "./lib/event-bus.js";
import { createApp } from "./api/index.js";
import {
  startRitualScheduler,
  stopRitualScheduler,
} from "./rituals/scheduler.js";
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
import { CommitToolSource } from "./tools/sources/commit.js";

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

  // Initialize event bus
  initEventBus(db);
  log.info("event bus initialized");

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

  // Initialize tool sources (plugin system)
  const sourceManager = new ToolSourceManager();
  sourceManager.addSource(new BuiltinToolSource());
  sourceManager.addSource(new CommitToolSource());
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

  serve(
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

  // Start messaging channels (WhatsApp/Telegram) if enabled
  const router = await initMessaging();

  // Wire MCP alerts to Telegram (after messaging is ready)
  if (router) {
    setMcpAlertFn((msg: string) => router.broadcastToAll(msg));
    startProactiveScheduler(router);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info("shutting down...");
    reactionManager.stop();
    stopDynamicScheduler();
    stopProactiveScheduler();
    stopRitualScheduler();
    await shutdownMessaging();
    await sourceManager.teardownAll();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.fatal({ err }, "fatal error");
  process.exit(1);
});
