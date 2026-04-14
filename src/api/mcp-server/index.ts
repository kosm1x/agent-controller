/**
 * Jarvis MCP Server router (v7.7).
 *
 * Exposes a read-only MCP surface at `POST /mcp` on the existing Hono app.
 * Claude Code sessions can call this to query live Jarvis state (memory,
 * tasks, schedules, feedback, gap telemetry) via typed MCP tool calls
 * instead of shelling into the VPS.
 *
 * Transport: WebStandardStreamableHTTPServerTransport from the MCP SDK —
 * native Hono compatibility via `transport.handleRequest(c.req.raw)`.
 * Stateless mode (no session persistence); Claude Code's HTTP MCP client
 * reconnects per call and that's fine for our usage pattern.
 *
 * Mounted conditionally in `createApp()` when `JARVIS_MCP_ENABLED=true`.
 *
 * Security model documented in `project_v77_jarvis_mcp_server.md`:
 *   - Bearer tokens hashed at rest (mcp_tokens table)
 *   - Rate limit 100 req/min per token
 *   - Audit logged to events table (category=mcp_call)
 *   - Read-only scope only; no writes, no mutations
 *   - v7.7 deploys over localhost SSH tunnel; public HTTPS deferred
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { logMcpCall } from "./audit.js";
import { mcpAuth } from "./auth.js";
import { mcpRateLimit } from "./rate-limit.js";
import { registerJarvisTools } from "./tools.js";
import type { McpDeps } from "./types.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

export function createMcpRouter(deps: McpDeps): Hono {
  const router = new Hono();

  // Health check — still behind auth so we don't leak any state publicly.
  router.use("/*", mcpAuth());
  router.use(
    "/*",
    mcpRateLimit({
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxPerWindow: RATE_LIMIT_MAX,
    }),
  );

  router.get("/health", (c) => {
    const token = c.get("mcpToken");
    logMcpCall(deps.db, token, "request_completed", {
      duration_ms: 0,
      ok: true,
    });
    return c.json({
      ok: true,
      server: "jarvis-mcp",
      version: "0.1.0",
      tools: 8,
      scope: token.scope,
    });
  });

  // Main MCP endpoint — JSON-RPC over HTTP. Stateless: create a fresh
  // McpServer + transport per request. The Claude Code HTTP MCP client
  // reconnects per call so this is fine and actually simpler than session
  // management. If the client sends `tools/list` we return the 8 Jarvis
  // tools; if `tools/call` we dispatch to the registered handler.
  router.post("/", async (c) => {
    const token = c.get("mcpToken");
    const start = Date.now();
    logMcpCall(deps.db, token, "request_received");

    try {
      const server = new McpServer(
        { name: "jarvis", version: "0.1.0" },
        { capabilities: { logging: {} } },
      );
      registerJarvisTools(server, deps);

      const transport = new WebStandardStreamableHTTPServerTransport({
        // Stateless mode — no sessionIdGenerator, no event store.
        enableJsonResponse: true,
      });
      await server.connect(transport);

      const response = await transport.handleRequest(c.req.raw);
      logMcpCall(deps.db, token, "request_completed", {
        duration_ms: Date.now() - start,
        ok: true,
      });
      return response;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logMcpCall(deps.db, token, "request_failed", {
        duration_ms: Date.now() - start,
        ok: false,
        error: message,
      });
      return c.json({ error: "mcp_dispatch_failed", message }, 500);
    }
  });

  return router;
}
