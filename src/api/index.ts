/**
 * API route registration.
 * Mounts all route groups onto the Hono app.
 */

import { Hono } from "hono";
import { apiKeyAuth } from "./auth.js";
import { health } from "./routes/health.js";
import { tasks } from "./routes/tasks.js";
import { agents } from "./routes/agents.js";
import { events } from "./routes/events.js";

export function createApp(): Hono {
  const app = new Hono();

  // Health check — no auth
  app.route("/", health);

  // All /api/* routes require API key
  const api = new Hono();
  api.use("/*", apiKeyAuth);

  api.route("/tasks", tasks);
  api.route("/agents", agents);
  api.route("/events", events);

  app.route("/api", api);

  return app;
}
