/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, and starts the Hono HTTP server.
 */

import { serve } from "@hono/node-server";
import { getConfig } from "./config.js";
import { initDatabase } from "./db/index.js";
import { initEventBus } from "./lib/event-bus.js";
import { createApp } from "./api/index.js";

// Tool and runner registration (side-effect imports)
import { toolRegistry } from "./tools/registry.js";
import { shellTool } from "./tools/builtin/shell.js";
import { httpTool } from "./tools/builtin/http.js";
import { fileReadTool, fileWriteTool } from "./tools/builtin/file.js";
import "./runners/fast-runner.js";
import "./runners/heavy-runner.js";

function main(): void {
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
}

main();
