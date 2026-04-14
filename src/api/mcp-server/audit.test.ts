/**
 * Tests for the MCP audit logger.
 *
 * The audit pipe is non-fatal telemetry, but its failure mode must be
 * OBSERVABLE (logged to pino) rather than silent — per v7.7.1 audit
 * finding M1. These tests verify both the happy-path write and the
 * logged-error path.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logMcpCall } from "./audit.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      data TEXT NOT NULL,
      correlation_id TEXT NOT NULL DEFAULT '',
      causation_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const TOKEN = {
  id: 7,
  clientName: "test-client",
  scope: "read_only" as const,
};

describe("logMcpCall", () => {
  beforeEach(() => {
    mocks.loggerError.mockReset();
  });

  it("writes a row to the events table with category=mcp_call", () => {
    const db = makeDb();
    logMcpCall(db, TOKEN, "request_received", { correlation_id: "cid-1" });

    const row = db
      .prepare(
        "SELECT type, category, data, correlation_id FROM events WHERE id IS NOT NULL",
      )
      .get() as {
      type: string;
      category: string;
      data: string;
      correlation_id: string;
    };
    expect(row.category).toBe("mcp_call");
    expect(row.type).toBe("request_received");
    expect(row.correlation_id).toBe("cid-1");
    const payload = JSON.parse(row.data) as {
      client_name: string;
      token_id: number;
      correlation_id: string;
    };
    expect(payload.client_name).toBe("test-client");
    expect(payload.token_id).toBe(7);
  });

  it("writes completion with duration_ms and ok flag", () => {
    const db = makeDb();
    logMcpCall(db, TOKEN, "request_completed", {
      duration_ms: 123,
      ok: true,
      correlation_id: "cid-2",
    });
    const row = db.prepare("SELECT data FROM events").get() as { data: string };
    const payload = JSON.parse(row.data) as {
      duration_ms: number;
      ok: boolean;
    };
    expect(payload.duration_ms).toBe(123);
    expect(payload.ok).toBe(true);
  });

  it("writes failure row with error code", () => {
    const db = makeDb();
    logMcpCall(db, TOKEN, "request_failed", {
      ok: false,
      error: "dispatch_failed",
      duration_ms: 50,
    });
    const row = db.prepare("SELECT type, data FROM events").get() as {
      type: string;
      data: string;
    };
    expect(row.type).toBe("request_failed");
    const payload = JSON.parse(row.data) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("dispatch_failed");
  });

  // v7.7.1 M1 regression — catch must escalate to pino.error, not be silent.
  // A broken audit pipe (disk full, schema drift, DB busy) was previously
  // invisible. Now it must fire a log line so operators see it in journalctl.
  it("logs via pino.error when the DB insert fails", () => {
    const db = makeDb();
    // Drop the events table to force the INSERT to fail
    db.exec("DROP TABLE events");

    // Must NOT throw even though the insert is guaranteed to fail
    expect(() => logMcpCall(db, TOKEN, "request_received")).not.toThrow();

    // Must have called pino.error exactly once with diagnostic context
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const call = mocks.loggerError.mock.calls[0];
    const context = call[0] as {
      err: string;
      type: string;
      token_id: number;
      client_name: string;
    };
    const message = call[1] as string;
    expect(message).toBe("mcp_audit_write_failed");
    expect(context.type).toBe("request_received");
    expect(context.token_id).toBe(7);
    expect(context.client_name).toBe("test-client");
    expect(context.err).toContain("no such table");
  });
});
