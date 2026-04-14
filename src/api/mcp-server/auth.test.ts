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

// Long tokens for tests — must be >= 32 chars to pass the BEARER_RE
// min-length rule introduced in v7.7.1.
const TOKEN_A = "jrvs_a11111111111111111111111111111111111111111111";
const TOKEN_B = "jrvs_b22222222222222222222222222222222222222222222";
const TOKEN_C = "jrvs_c33333333333333333333333333333333333333333333";
const TOKEN_D = "jrvs_d44444444444444444444444444444444444444444444";
const TOKEN_E = "jrvs_e55555555555555555555555555555555555555555555";
const TOKEN_F = "jrvs_f66666666666666666666666666666666666666666666";

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
      expires_at TEXT,
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
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_or_revoked_token");
  });

  it("accepts valid tokens and populates mcpToken in context", async () => {
    const id = insertToken("claude-code-test", TOKEN_A);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
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
    const id = insertToken("claude-code-revoked", TOKEN_B);
    db.prepare("UPDATE mcp_tokens SET revoked = 1 WHERE id = ?").run(id);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    });
    expect(res.status).toBe(401);
  });

  it("touches last_used_at on successful auth", async () => {
    const id = insertToken("claude-code-touch", TOKEN_C);

    const app = makeApp();
    await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_C}` },
    });

    const row = db
      .prepare("SELECT last_used_at FROM mcp_tokens WHERE id = ?")
      .get(id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
  });

  // v7.7.1 M5 regression — BEARER_RE min length 32 chars. Short tokens
  // make probing cheap and must be refused at the regex layer, before
  // any DB lookup.
  it("rejects tokens shorter than 32 chars (401)", async () => {
    const shortToken = "jrvs_short";
    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${shortToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_or_malformed_bearer");
  });

  it("rejects tokens with exactly 31 chars (boundary)", async () => {
    // 31 chars total — one below the floor
    const boundary = "a".repeat(31);
    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${boundary}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("missing_or_malformed_bearer");
  });

  // v7.7.1 W2 regression — expires_at enforcement
  it("rejects tokens with expires_at in the past (401)", async () => {
    const id = insertToken("claude-code-expired", TOKEN_D);
    db.prepare(
      "UPDATE mcp_tokens SET expires_at = datetime('now', '-1 hours') WHERE id = ?",
    ).run(id);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_D}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_or_revoked_token");
  });

  it("accepts tokens with expires_at in the future", async () => {
    const id = insertToken("claude-code-future", TOKEN_E);
    db.prepare(
      "UPDATE mcp_tokens SET expires_at = datetime('now', '+1 days') WHERE id = ?",
    ).run(id);

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_E}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });

  it("accepts tokens with expires_at NULL (no expiry)", async () => {
    const id = insertToken("claude-code-forever", TOKEN_F);
    // expires_at stays NULL from insertToken helper

    const app = makeApp();
    const res = await app.request("/probe", {
      headers: { Authorization: `Bearer ${TOKEN_F}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
  });
});
