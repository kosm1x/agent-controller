/**
 * Audit logging for the Jarvis MCP server.
 *
 * Every MCP request writes a row to the `events` table with:
 *   category = 'mcp_call'
 *   type     = 'request_received' | 'request_completed' | 'request_failed'
 *   data     = { client_name, token_id, duration_ms?, ok?, error? }
 *
 * No tool arguments, no tool output content — counts and shapes only.
 * Raw bearer tokens never touch the audit surface.
 */

import type { Database } from "better-sqlite3";
import type { McpTokenInfo } from "./types.js";

type AuditType = "request_received" | "request_completed" | "request_failed";

export interface AuditPayload {
  duration_ms?: number;
  ok?: boolean;
  error?: string;
}

export function logMcpCall(
  db: Database,
  token: McpTokenInfo,
  type: AuditType,
  payload: AuditPayload = {},
): void {
  try {
    db.prepare(
      `INSERT INTO events (id, type, category, timestamp, workspace_id, data, correlation_id)
       VALUES (?, ?, 'mcp_call', datetime('now'), 'default', ?, '')`,
    ).run(
      crypto.randomUUID(),
      type,
      JSON.stringify({
        client_name: token.clientName,
        token_id: token.id,
        ...payload,
      }),
    );
  } catch {
    // Audit writes are non-fatal telemetry; never block a request on this.
  }
}
