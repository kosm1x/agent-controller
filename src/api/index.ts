/**
 * API route registration.
 * Mounts all route groups onto the Hono app.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "./auth.js";
import { health } from "./routes/health.js";

export function createApp(): Hono {
  const app = new Hono();

  // Health check — no auth
  app.route("/", health);

  // All /api/* routes require API key
  const api = new Hono();
  api.use("/*", apiKeyAuth);

  // Task routes (Phase 2)
  // api.route("/tasks", tasks);

  // Agent routes (Phase 2)
  // api.route("/agents", agents);

  // SSE events (Phase 6)
  // api.route("/events", events);

  app.route("/api", api);

  return app;
}
