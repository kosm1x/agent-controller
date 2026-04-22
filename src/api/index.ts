/**
 * API route registration.
 * Mounts all route groups onto the Hono app.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { apiKeyAuth } from "./auth.js";
import { apiRateLimit } from "./rate-limit.js";
import { health } from "./routes/health.js";
import dashboardRoute from "./routes/dashboard.js";
import { tasks } from "./routes/tasks.js";
import { agents } from "./routes/agents.js";
import { events } from "./routes/events.js";
import { jarvisPull } from "./routes/jarvis-pull.js";
import { admin } from "./routes/admin.js";
import { buildAgentCard } from "../a2a/agent-card.js";
import { a2a } from "../a2a/server.js";
import {
  getMetricsText,
  metricsContentType,
} from "../observability/prometheus.js";
import { createMcpRouter } from "./mcp-server/index.js";
import { getDatabase } from "../db/index.js";
import { getMemoryService } from "../memory/index.js";

export function createApp(): Hono {
  const app = new Hono();

  // Health check + metrics — no auth
  app.route("/", health);

  // Dashboard serving — no auth (self-contained HTML)
  app.route("/dashboard", dashboardRoute);
  app.get("/metrics", async (c) => {
    const text = await getMetricsText();
    return c.text(text, 200, { "Content-Type": metricsContentType });
  });

  // A2A Agent Card + JSON-RPC — only mounted when A2A is configured
  if (process.env.A2A_AGENT_NAME) {
    app.get("/.well-known/agent.json", (c) => c.json(buildAgentCard()));
    const a2aApi = new Hono();
    // Sec9 round-2 W3 fix: A2A is a full JSON-RPC tool-invocation surface;
    // it needs the same defense-in-depth rate-limit as /api/*.
    a2aApi.use("/*", apiRateLimit({ windowMs: 60_000, maxPerWindow: 300 }));
    a2aApi.use("/*", apiKeyAuth);
    a2aApi.route("/", a2a);
    app.route("/a2a", a2aApi);
  }

  // v7.7 Jarvis MCP Server — read-only MCP surface for Claude Code sessions.
  // Exposes memory / tasks / schedules / feedback / gap-telemetry query tools.
  // Auth: bearer tokens from mcp_tokens table. Rate limit: 100/min/token.
  // Audit: writes to events (category=mcp_call). See project_v77_jarvis_mcp_server.md.
  //
  // v7.7.1 M6 fix: parse the enable flag leniently. Accepts `true`/`1`/
  // `yes`/`on` (case-insensitive). The previous exact `=== "true"` check
  // would silently disable the server if someone set `JARVIS_MCP_ENABLED=1`
  // (the systemd drop-in's natural convention) — a quiet security toggle
  // failure. Also log the mount decision at startup so operators can
  // confirm state via `journalctl -u mission-control | grep mcp`.
  const mcpEnabled = /^(1|true|yes|on)$/i.test(
    (process.env.JARVIS_MCP_ENABLED ?? "").trim(),
  );
  if (mcpEnabled) {
    const mcpRouter = createMcpRouter({
      db: getDatabase(),
      memory: getMemoryService(),
      startedAt: Date.now(),
    });
    app.route("/mcp", mcpRouter);
    console.log("[api] Jarvis MCP server mounted at /mcp (JARVIS_MCP_ENABLED)");
  } else {
    console.log(
      "[api] Jarvis MCP server NOT mounted (JARVIS_MCP_ENABLED unset)",
    );
  }

  // All /api/* routes require API key + IP-keyed rate limit (Sec9).
  // 300 req/min per IP gives the dashboard's 5s polling headroom for 3
  // concurrent tabs while still capping an attacker who captures the key.
  const api = new Hono();
  api.use("/*", apiRateLimit({ windowMs: 60_000, maxPerWindow: 300 }));
  api.use("/*", apiKeyAuth);

  api.route("/tasks", tasks);
  api.route("/agents", agents);
  api.route("/events", events);
  api.route("/", jarvisPull);
  api.route("/admin", admin);

  app.route("/api", api);

  // Dashboard static files — no auth (JS handles API key itself)
  app.get("/dashboard", (c) => c.redirect("/dashboard/"));
  app.use("/dashboard/*", serveStatic({ root: "./public" }));

  // Docs — static HTML index + llms.txt + raw markdown (no auth)
  app.get("/docs", (c) => c.redirect("/docs/"));
  app.use("/docs/*", serveStatic({ root: "./public" }));
  app.get("/docs/raw/:file", async (c) => {
    const file = c.req.param("file");
    // Security: only .md files, no traversal (.. or / or percent-encoded variants)
    if (!file.endsWith(".md") || file.includes("..") || file.includes("/")) {
      return c.text("Not found", 404);
    }
    // Check docs/ first, then project root (README.md, CLAUDE.md)
    for (const base of ["docs", "."]) {
      try {
        const content = await readFile(
          join(process.cwd(), base, file),
          "utf-8",
        );
        return c.text(content, 200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        });
      } catch {
        continue;
      }
    }
    return c.text("Not found", 404);
  });

  return app;
}
