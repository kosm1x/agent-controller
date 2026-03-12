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

function main(): void {
  const config = getConfig();

  // Initialize database
  const db = initDatabase(config.dbPath);
  console.log(`[mc] Database initialized at ${config.dbPath}`);

  // Initialize event bus
  initEventBus(db);
  console.log("[mc] Event bus initialized");

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
