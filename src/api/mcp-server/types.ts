/**
 * Shared types for the Jarvis MCP server (v7.7).
 *
 * The server exposes a read-only MCP surface over HTTP for Claude Code
 * sessions to query live Jarvis state (memory, tasks, schedules, feedback,
 * gap telemetry) without SSH'ing into the VPS.
 */

import type { Database } from "better-sqlite3";
import type { MemoryService } from "../../memory/types.js";

/** Dependencies injected into the MCP server at mount time. */
export interface McpDeps {
  /** Jarvis SQLite connection (singleton via getDatabase). */
  db: Database;
  /** Memory service (singleton via getMemoryService). */
  memory: MemoryService;
  /** Monotonic startup timestamp (ms since epoch). */
  startedAt: number;
}

/** Token info populated by the auth middleware on every authenticated call. */
export interface McpTokenInfo {
  id: number;
  clientName: string;
  scope: "read_only";
}

declare module "hono" {
  interface ContextVariableMap {
    mcpToken: McpTokenInfo;
  }
}
