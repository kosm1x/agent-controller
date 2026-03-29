/**
 * API route registration.
 * Mounts all route groups onto the Hono app.
 */

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { apiKeyAuth } from "./auth.js";
import { health } from "./routes/health.js";
import { tasks } from "./routes/tasks.js";
import { agents } from "./routes/agents.js";
import { events } from "./routes/events.js";
import { commitEvents } from "./routes/commit-events.js";
import { commitAI } from "./routes/commit-ai.js";
import { buildAgentCard } from "../a2a/agent-card.js";
import { a2a } from "../a2a/server.js";
import {
  getMetricsText,
  metricsContentType,
} from "../observability/prometheus.js";

export function createApp(): Hono {
  const app = new Hono();

  // Health check + metrics — no auth
  app.route("/", health);
  app.get("/metrics", async (c) => {
    const text = await getMetricsText();
    return c.text(text, 200, { "Content-Type": metricsContentType });
  });

  // A2A Agent Card — no auth (per A2A spec)
  app.get("/.well-known/agent.json", (c) => c.json(buildAgentCard()));

  // A2A JSON-RPC endpoint — authenticated
  const a2aApi = new Hono();
  a2aApi.use("/*", apiKeyAuth);
  a2aApi.route("/", a2a);
  app.route("/a2a", a2aApi);

  // All /api/* routes require API key
  const api = new Hono();
  api.use("/*", apiKeyAuth);

  api.route("/tasks", tasks);
  api.route("/agents", agents);
  api.route("/events", events);
  api.route("/commit-events", commitEvents);
  api.route("/commit-ai", commitAI);

  app.route("/api", api);

  // Dashboard static files — no auth (JS handles API key itself)
  app.get("/dashboard", (c) => c.redirect("/dashboard/"));
  app.use("/dashboard/*", serveStatic({ root: "./public" }));

  return app;
}
