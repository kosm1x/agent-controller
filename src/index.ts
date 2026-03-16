/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, MCP servers, and starts the Hono HTTP server.
 */

import { serve } from "@hono/node-server";
import { getConfig } from "./config.js";
import { initDatabase } from "./db/index.js";
import { initEventBus } from "./lib/event-bus.js";
import { createApp } from "./api/index.js";
import { initMcp, shutdownMcp } from "./mcp/index.js";
import {
  startRitualScheduler,
  stopRitualScheduler,
} from "./rituals/scheduler.js";
import { initMessaging, shutdownMessaging } from "./messaging/index.js";
import { initMemoryService } from "./memory/index.js";
import { migrateLearningsToHindsight } from "./memory/migrate-learnings.js";
import { seedMentalModels } from "./intelligence/mental-models.js";
import {
  startProactiveScheduler,
  stopProactiveScheduler,
} from "./intelligence/proactive.js";

// Tool and runner registration (side-effect imports)
import { toolRegistry } from "./tools/registry.js";
import { shellTool } from "./tools/builtin/shell.js";
import { httpTool } from "./tools/builtin/http.js";
import { fileReadTool, fileWriteTool } from "./tools/builtin/file.js";
import "./runners/fast-runner.js";
import "./runners/heavy-runner.js";
import "./runners/nanoclaw-runner.js";
import "./runners/swarm-runner.js";
import "./runners/a2a-runner.js";

async function main(): Promise<void> {
  const config = getConfig();

  // Initialize database
  const db = initDatabase(config.dbPath);
  console.log(`[mc] Database initialized at ${config.dbPath}`);

  // Initialize event bus
  initEventBus(db);
  console.log("[mc] Event bus initialized");

  // Register built-in tools
  toolRegistry.register(shellTool);
  toolRegistry.register(httpTool);
  toolRegistry.register(fileReadTool);
  toolRegistry.register(fileWriteTool);

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

  // Initialize MCP tool servers (adds tools to registry)
  await initMcp();

  // Register memory tools if Hindsight is enabled
  if (memory.backend === "hindsight") {
    const { memorySearchTool, memoryStoreTool, memoryReflectTool } =
      await import("./tools/builtin/memory.js");
    toolRegistry.register(memorySearchTool);
    toolRegistry.register(memoryStoreTool);
    toolRegistry.register(memoryReflectTool);
  }

  console.log(`[mc] Tools registered: ${toolRegistry.list().join(", ")}`);

  // Create and start HTTP server
  const app = createApp();

  serve(
    {
      fetch: app.fetch,
      port: config.port,
    },
    (info) => {
      console.log(
        `[mc] Mission Control listening on http://localhost:${info.port}`,
      );
      console.log(`[mc] Health check: http://localhost:${info.port}/health`);
    },
  );

  // Start ritual scheduler if enabled
  if (process.env.RITUALS_ENABLED === "true") {
    startRitualScheduler();
  }

  // Start messaging channels (WhatsApp/Telegram) if enabled
  const router = await initMessaging();

  // Start proactive intelligence scheduler (after messaging is ready)
  if (router) {
    startProactiveScheduler(router);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[mc] Shutting down...");
    stopProactiveScheduler();
    stopRitualScheduler();
    await shutdownMessaging();
    await shutdownMcp();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[mc] Fatal:", err);
  process.exit(1);
});
