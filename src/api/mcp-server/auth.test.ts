/**
 * Tests for the bearer-token auth middleware.
 *
 * Uses an in-memory better-sqlite3 DB so we don't touch the real mc.db.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  getDatabase: mocks.getDatabase,
}));

import Database from "better-sqlite3";
import { mcpAuth } from "./auth.js";

let db: Database.Database;

function insertToken(clientName: string, rawToken: string): number {
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const info = db
    .prepare(
      "INSERT INTO mcp_tokens (token_hash, client_name, scope) VALUES (?, ?, 'read_only') RETURNING id",
    )
    .get(hash, clientName) as { id: number };
  return info.id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mcp_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      client_name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'read_only' CHECK(scope IN ('read_only')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
    );
  `);
  mocks.getDatabase.mockReturnValue(db);
});

function makeApp() {
  const app = new Hono();
  app.use("/*", mcpAuth());
  app.get("/probe", (c) => {
    const token = c.get("mcpToken");
    return c.json({
      id: token.id,
      client: token.clientName,
      scope: token.scope,
    });
  });
  return app;
}

describe("mcpAuth middleware", () => {
  it("rejects requests with no Authorization header (401)", async () => {
    const app = makeApp();
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_or_malformed_bearer");
  });

  it("rejects malformed Authorization header (401)", async () => {
    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects unknown tokens (401)", async () => {
    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: "Bearer jrvs_notarealtoken" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_or_revoked_token");
  });

  it("accepts valid tokens and populates mcpToken in context", async () => {
    const token = "jrvs_validtoken123";
    const id = insertToken("claude-code-test", token);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id,
      client: "claude-code-test",
      scope: "read_only",
    });
  });

  it("rejects revoked tokens (401)", async () => {
    const token = "jrvs_revoked456";
    const id = insertToken("claude-code-revoked", token);
    db.prepare("UPDATE mcp_tokens SET revoked = 1 WHERE id = ?").run(id);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("touches last_used_at on successful auth", async () => {
    const token = "jrvs_touch789";
    const id = insertToken("claude-code-touch", token);

    const app = makeApp();
    await app.request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const row = db
      .prepare("SELECT last_used_at FROM mcp_tokens WHERE id = ?")
      .get(id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
  });
});
